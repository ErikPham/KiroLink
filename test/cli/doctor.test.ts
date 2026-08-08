/**
 * Diagnostics.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatDoctorReport, runDoctor, type DoctorDeps } from '../../src/cli/doctor'
import type { KiroUsageSummary } from '../../src/kiro/usage'
import { fakeAuth, fakeUsage, okUsage, testConfig } from '../support/harness'

const SYMBOLS = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }

/** A token file valid for an hour, at a path doctor can read. */
async function writeTokenFile(expiresInMs = 3_600_000): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kirolink-doctor-'))
  const path = join(dir, 'kiro-auth-token-cli.json')
  await writeFile(path, JSON.stringify({
    accessToken: 'a'.repeat(40),
    refreshToken: 'r'.repeat(20),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF',
  }))
  return path
}

/**
 * Baseline config for checks unrelated to auth. api-key mode avoids needing a
 * token file on disk, so those tests assert only what they are about.
 */
function healthyConfig() {
  const base = testConfig()
  return testConfig({ upstream: { ...base.upstream, mode: 'api-key', kiroApiKey: 'k'.repeat(24) } })
}

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const config = overrides.config ?? healthyConfig()
  return {
    config,
    auth: fakeAuth(),
    usage: fakeUsage(okUsage(500)),
    probeKiroCli: () => Promise.resolve('kiro-cli 2.5.1'),
    isPortFree: () => Promise.resolve(true),
    // Never fall through to the host's own credentials: a developer logged into
    // kiro-cli would otherwise see a real token and different results.
    tokenCacheDir: '/nonexistent-token-cache',
    secretStore: { keyring: false, dbPath: '/nonexistent-kiro-store.sqlite3' },
    ...overrides,
  }
}

function find(results: { name: string }[], name: string) {
  return results.find((result) => result.name === name)
}

describe('runDoctor in api-key mode', () => {
  const apiKeyConfig = () => testConfig({
    upstream: { ...testConfig().upstream, mode: 'api-key', kiroApiKey: 'k'.repeat(24) },
  })

  it('passes when everything is configured', async () => {
    const report = await runDoctor(deps({ config: apiKeyConfig() }))

    expect(report.healthy).toBe(true)
    expect(find(report.results, 'Kiro API key')?.level).toBe('pass')
    expect(find(report.results, 'Credential')?.level).toBe('pass')
    // kiro-cli is irrelevant in api-key mode, so it is not checked.
    expect(find(report.results, 'kiro-cli')).toBeUndefined()
  })

  it('masks the key rather than printing it', async () => {
    const report = await runDoctor(deps({ config: apiKeyConfig() }))
    const detail = find(report.results, 'Kiro API key')?.detail ?? ''

    expect(detail).not.toContain('k'.repeat(24))
    expect(detail).toContain('…')
  })

  it('fails when the mode is api-key but no key is set', async () => {
    const config = testConfig({ upstream: { ...testConfig().upstream, mode: 'api-key', kiroApiKey: undefined } })
    const report = await runDoctor(deps({ config }))

    const check = find(report.results, 'Kiro API key')
    expect(check?.level).toBe('fail')
    expect(check?.hint).toContain('kirolink setup')
    expect(report.healthy).toBe(false)
  })

  it('points at the key, not kiro-cli, when credits are rejected', async () => {
    const rejected: KiroUsageSummary = {
      ok: false,
      error: 'getUsageLimits HTTP 403: invalid bearer token',
      fetchedAt: new Date().toISOString(),
    }
    const report = await runDoctor(deps({ config: apiKeyConfig(), usage: fakeUsage(rejected) }))

    const check = find(report.results, 'Credits')
    expect(check?.level).toBe('fail')
    expect(check?.hint).toContain('kirolink setup')
    expect(check?.hint).not.toContain('kiro-cli login')
  })
})

describe('runDoctor in cli mode', () => {
  it('passes with kiro-cli present and a fresh token', async () => {
    const tokenPath = await writeTokenFile()
    const config = testConfig({ upstream: { ...testConfig().upstream, mode: 'cli', tokenPath } })
    const report = await runDoctor(deps({ config }))

    expect(find(report.results, 'kiro-cli')?.level).toBe('pass')
    expect(find(report.results, 'kiro-cli token')?.level).toBe('pass')
    expect(report.healthy).toBe(true)
  })

  it('fails when kiro-cli is missing', async () => {
    const tokenPath = await writeTokenFile()
    const config = testConfig({ upstream: { ...testConfig().upstream, mode: 'cli', tokenPath } })
    const report = await runDoctor(deps({
      config,
      probeKiroCli: () => Promise.reject(new Error('command not found')),
    }))

    const check = find(report.results, 'kiro-cli')
    expect(check?.level).toBe('fail')
    expect(check?.hint).toContain('kiro-cli login')
    expect(report.healthy).toBe(false)
  })

  it('warns rather than fails on an expired token, since it auto-refreshes', async () => {
    const tokenPath = await writeTokenFile(-60_000)
    const config = testConfig({ upstream: { ...testConfig().upstream, mode: 'cli', tokenPath } })
    const report = await runDoctor(deps({ config }))

    const check = find(report.results, 'kiro-cli token')
    expect(check?.level).toBe('warn')
    expect(report.healthy).toBe(true)
  })

  it('fails when no token file exists', async () => {
    const config = testConfig({
      upstream: { ...testConfig().upstream, mode: 'cli', tokenPath: '/nonexistent/token.json' },
    })
    const report = await runDoctor(deps({ config }))

    expect(find(report.results, 'kiro-cli token')?.level).toBe('fail')
  })

  it('skips the credit lookup when the credential is unusable', async () => {
    const config = testConfig({
      upstream: { ...testConfig().upstream, mode: 'cli', tokenPath: '/nonexistent/token.json' },
    })
    let usageCalled = false
    const report = await runDoctor(deps({
      config,
      auth: {
        load: () => Promise.reject(new Error('no token\nsearched a\nsearched b')),
        invalidate: () => {},
        refresh: () => Promise.resolve(),
      },
      usage: {
        fetch: () => {
          usageCalled = true
          return Promise.resolve(okUsage())
        },
      },
    }))

    expect(usageCalled).toBe(false)
    expect(find(report.results, 'Credits')?.detail).toContain('skipped')
    // The full search list is printed once by the token check, not repeated.
    expect(find(report.results, 'Credential')?.detail).not.toContain('searched b')
  })
})

describe('runDoctor environment checks', () => {
  it('warns when the port is busy, since fallback handles it', async () => {
    const report = await runDoctor(deps({ isPortFree: () => Promise.resolve(false) }))

    const check = find(report.results, 'Listen port')
    expect(check?.level).toBe('warn')
    expect(report.healthy).toBe(true)
  })

  it('warns when the config file does not exist yet', async () => {
    const report = await runDoctor(deps({ config: { ...healthyConfig(), configPath: '/nonexistent/config.json' } }))

    const check = find(report.results, 'Config file')
    expect(check?.level).toBe('warn')
    expect(check?.hint).toContain('setup')
  })

  it('warns when the config file is group- or world-readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-perm-'))
    const path = join(dir, 'config.json')
    // The file can hold an API key, so loose permissions are a real exposure.
    await writeFile(path, '{}', { mode: 0o644 })

    const report = await runDoctor(deps({ config: { ...healthyConfig(), configPath: path } }))
    expect(find(report.results, 'Config file')?.level).toBe('warn')
    expect(find(report.results, 'Config file')?.hint).toContain('chmod 600')
  })

  it('fails on an invalid runtime endpoint', async () => {
    const config = testConfig({ upstream: { ...healthyConfig().upstream, apiUrl: 'https://evil.example.com/' } })
    const report = await runDoctor(deps({ config }))

    expect(find(report.results, 'Runtime endpoint')?.level).toBe('fail')
    expect(report.healthy).toBe(false)
  })

  it('warns when credits are exhausted', async () => {
    const report = await runDoctor(deps({ usage: fakeUsage(okUsage(0)) }))

    const check = find(report.results, 'Credits')
    expect(check?.level).toBe('warn')
    expect(report.healthy).toBe(true)
  })
})

describe('formatDoctorReport', () => {
  it('indents multi-line details to the detail column', async () => {
    // An empty cache dir with no explicit tokenPath produces the multi-line
    // "searched these paths" error, which is the case that used to break the
    // column layout.
    const cacheDir = await mkdtemp(join(tmpdir(), 'kirolink-empty-'))
    const base = testConfig()
    const config = testConfig({ upstream: { ...base.upstream, mode: 'cli', tokenPath: undefined } })
    const report = await runDoctor(deps({ config, tokenCacheDir: cacheDir }))
    const text = formatDoctorReport(report, config, SYMBOLS)

    const continuation = text.split('\n').filter((line) => line.trimStart().startsWith('- /'))
    expect(continuation.length).toBeGreaterThan(0)
    for (const line of continuation) {
      expect(line.startsWith('  ')).toBe(true)
    }
  })

  it('summarizes a healthy report', async () => {
    // A saved config with tight permissions is required for a clean run.
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-healthy-'))
    const configPath = join(dir, 'config.json')
    await writeFile(configPath, '{}', { mode: 0o600 })

    const config = { ...healthyConfig(), configPath }
    const report = await runDoctor(deps({ config }))
    const text = formatDoctorReport(report, config, SYMBOLS)

    expect(report.healthy).toBe(true)
    expect(text).toContain('Everything looks good.')
  })

  it('uses singular wording for one problem', async () => {
    const config = testConfig({ upstream: { ...testConfig().upstream, mode: 'api-key', kiroApiKey: undefined } })
    const report = await runDoctor(deps({ config }))
    const text = formatDoctorReport(report, config, SYMBOLS)

    expect(text).toContain('1 problem needs attention.')
  })

  it('reports warning counts when otherwise healthy', async () => {
    const report = await runDoctor(deps({ isPortFree: () => Promise.resolve(false) }))
    const text = formatDoctorReport(report, healthyConfig(), SYMBOLS)

    expect(text).toMatch(/Ready, with \d+ warning/u)
  })
})
