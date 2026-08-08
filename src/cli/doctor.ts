/**
 * Diagnostics.
 *
 * Checks are pure functions over injected dependencies rather than direct calls
 * to the filesystem, network, and child processes, so the whole command is
 * testable and each check can be exercised in isolation.
 */

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { KiroLinkConfig } from '../config/config'
import { describeUpstream } from '../config/config'
import type { AuthProvider } from '../kiro/auth'
import { loadKiroToken } from '../kiro/auth'
import type { SecretStoreOptions } from '../kiro/secret-store'
import { resolveKiroApiUrl } from '../kiro/endpoint'
import type { UsageService } from '../kiro/usage'
import { formatUsageLine } from '../kiro/usage'

const execFileAsync = promisify(execFile)
const KIRO_CLI_PROBE_TIMEOUT_MS = 10_000
const MIN_NODE_MAJOR = 18

export type CheckLevel = 'pass' | 'warn' | 'fail'

export type CheckResult = {
  name: string
  level: CheckLevel
  detail: string
  /** How to fix it. Present whenever level is not 'pass'. */
  hint?: string
}

export type DoctorReport = {
  results: CheckResult[]
  /** True when no check failed; warnings do not make the report unhealthy. */
  healthy: boolean
}

export type DoctorDeps = {
  config: KiroLinkConfig
  auth: AuthProvider
  usage: UsageService
  /** Injected for tests. */
  probeKiroCli?: () => Promise<string>
  isPortFree?: (port: number, host: string) => Promise<boolean>
  /** Where to look for kiro-cli tokens when no explicit path is configured. */
  tokenCacheDir?: string
  /** The other half of that lookup: kiro-cli's keyring and SQLite store. */
  secretStore?: SecretStoreOptions
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const results: CheckResult[] = [
    checkNodeVersion(),
    await checkConfigFile(deps.config),
    checkEndpoint(deps.config),
  ]

  if (deps.config.upstream.mode === 'cli') {
    results.push(await checkKiroCli(deps))
    results.push(await checkTokenFile(deps))
  } else {
    results.push(checkApiKey(deps.config))
  }

  const credential = await checkCredential(deps)
  results.push(credential)

  // A credit lookup can only fail the same way when the credential itself is
  // unusable, so skip the network call and the duplicate error text.
  results.push(credential.level === 'fail'
    ? { name: 'Credits', level: 'fail', detail: 'skipped — no usable credential' }
    : await checkCredits(deps))

  results.push(await checkPort(deps))

  return { results, healthy: !results.some((result) => result.level === 'fail') }
}

/** Trim a multi-line "searched these paths" error down to its first line. */
function firstLine(text: string): string {
  const [first = ''] = text.split('\n')
  return first
}

function checkNodeVersion(): CheckResult {
  const major = Number(process.versions.node.split('.')[0])
  return major >= MIN_NODE_MAJOR
    ? { name: 'Node version', level: 'pass', detail: process.versions.node }
    : {
        name: 'Node version',
        level: 'fail',
        detail: `${process.versions.node} is below the minimum`,
        hint: `Install Node ${MIN_NODE_MAJOR} or newer`,
      }
}

async function checkConfigFile(config: KiroLinkConfig): Promise<CheckResult> {
  try {
    const info = await stat(config.configPath)
    const mode = info.mode & 0o777
    // The file can hold an API key, so group/world access is a real exposure.
    if (mode & 0o077) {
      return {
        name: 'Config file',
        level: 'warn',
        detail: `${config.configPath} has mode ${mode.toString(8)}`,
        hint: `Restrict it: chmod 600 ${config.configPath}`,
      }
    }
    return { name: 'Config file', level: 'pass', detail: config.configPath }
  } catch {
    return {
      name: 'Config file',
      level: 'warn',
      detail: 'not created yet',
      hint: 'Run: kirolink setup — settings are saved after the first start',
    }
  }
}

function checkApiKey(config: KiroLinkConfig): CheckResult {
  const key = config.upstream.kiroApiKey
  if (!key) {
    return {
      name: 'Kiro API key',
      level: 'fail',
      detail: 'auth mode is api-key but no key is configured',
      hint: 'Run: kirolink setup',
    }
  }
  return { name: 'Kiro API key', level: 'pass', detail: `configured (${maskSecret(key)})` }
}

async function checkKiroCli(deps: DoctorDeps): Promise<CheckResult> {
  const probe = deps.probeKiroCli ?? defaultProbeKiroCli
  try {
    const version = await probe()
    return { name: 'kiro-cli', level: 'pass', detail: version || 'available' }
  } catch (error) {
    return {
      name: 'kiro-cli',
      level: 'fail',
      detail: describe(error),
      hint: 'Install kiro-cli and run: kiro-cli login — or switch to an API key with: kirolink setup',
    }
  }
}

async function checkTokenFile(deps: DoctorDeps): Promise<CheckResult> {
  const { config } = deps
  try {
    const cacheDir = deps.tokenCacheDir ?? defaultTokenCacheDir()
    const { token, origin } = await loadKiroToken(cacheDir, config.upstream.tokenPath, deps.secretStore)
    const expiresAt = new Date(token.expiresAt).getTime()

    if (!Number.isFinite(expiresAt)) {
      return { name: 'kiro-cli token', level: 'warn', detail: `${origin} has no readable expiry` }
    }
    const remainingMs = expiresAt - Date.now()
    if (remainingMs <= 0) {
      return {
        name: 'kiro-cli token',
        level: 'warn',
        detail: 'expired',
        // Not a failure: the proxy refreshes automatically on the next request.
        hint: 'It refreshes automatically, or run: kiro-cli login',
      }
    }
    return {
      name: 'kiro-cli token',
      level: 'pass',
      detail: `valid for ${formatDuration(remainingMs)} (${origin})`,
    }
  } catch (error) {
    return {
      name: 'kiro-cli token',
      level: 'fail',
      detail: describe(error),
      hint: 'Run: kiro-cli login',
    }
  }
}

function checkEndpoint(config: KiroLinkConfig): CheckResult {
  try {
    const url = resolveKiroApiUrl(config.upstream)
    return { name: 'Runtime endpoint', level: 'pass', detail: url.origin }
  } catch (error) {
    return {
      name: 'Runtime endpoint',
      level: 'fail',
      detail: describe(error),
      hint: 'Check KIROLINK_API_URL and KIROLINK_API_REGION',
    }
  }
}

/** Prove the credential is actually accepted, not merely present. */
async function checkCredential(deps: DoctorDeps): Promise<CheckResult> {
  try {
    const credential = await deps.auth.load()
    const detail = credential.mode === 'api_key'
      ? 'API key loaded'
      : `OAuth token loaded (${credential.profileArn.split('/').pop() ?? 'profile'})`
    return { name: 'Credential', level: 'pass', detail }
  } catch (error) {
    return {
      name: 'Credential',
      level: 'fail',
      // The token check above already printed the full search list; repeating it
      // here buries the report in duplicated paths.
      detail: firstLine(describe(error)),
      hint: deps.config.upstream.mode === 'api-key'
        ? 'Run: kirolink setup — the saved key may be wrong'
        : 'Run: kiro-cli login',
    }
  }
}

async function checkCredits(deps: DoctorDeps): Promise<CheckResult> {
  const summary = await deps.usage.fetch({ force: true })
  if (!summary.ok) {
    // A 403 here is the clearest signal of a wrong key or region, since this is
    // the first call that actually exercises the credential.
    const rejected = /403|invalid|token/iu.test(summary.error)
    return {
      name: 'Credits',
      level: 'fail',
      detail: summary.error,
      hint: rejected
        ? deps.config.upstream.mode === 'api-key'
          ? 'The key was rejected. Check it and the region: kirolink setup'
          : 'The token was rejected. Run: kiro-cli login'
        : 'Check network access to the Kiro runtime',
    }
  }
  if (summary.exhausted) {
    return {
      name: 'Credits',
      level: 'warn',
      detail: formatUsageLine(summary),
      hint: summary.nextResetDate ? `Quota resets on ${summary.nextResetDate}` : 'Wait for the quota to reset',
    }
  }
  return { name: 'Credits', level: 'pass', detail: formatUsageLine(summary) }
}

async function checkPort(deps: DoctorDeps): Promise<CheckResult> {
  const { port, host } = deps.config.server
  const isFree = deps.isPortFree ?? defaultIsPortFree
  if (await isFree(port, host)) {
    return { name: 'Listen port', level: 'pass', detail: `${host}:${port} is free` }
  }
  return {
    name: 'Listen port',
    level: 'warn',
    detail: `${host}:${port} is in use`,
    // Not a failure: the CLI advances to the next free port automatically.
    hint: 'KiroLink will use the next free port, or pass --port',
  }
}

/** Render the report for a terminal. */
export function formatDoctorReport(report: DoctorReport, config: KiroLinkConfig, symbols: {
  pass: string
  warn: string
  fail: string
}): string {
  const lines = [`kirolink doctor — auth=${describeUpstream(config.upstream)}`, '']

  const width = Math.max(...report.results.map((result) => result.name.length))
  const indent = ' '.repeat(width + 4)
  for (const result of report.results) {
    const icon = result.level === 'pass' ? symbols.pass : result.level === 'warn' ? symbols.warn : symbols.fail
    // Details can be multi-line (a list of searched paths), so continuation
    // lines are indented to the detail column instead of breaking the layout.
    const [first = '', ...rest] = result.detail.split('\n')
    lines.push(`${icon} ${result.name.padEnd(width)}  ${first}`)
    for (const line of rest) lines.push(`${indent}${line}`)
    if (result.hint) lines.push(`${indent}→ ${result.hint}`)
  }

  const failures = report.results.filter((result) => result.level === 'fail').length
  const warnings = report.results.filter((result) => result.level === 'warn').length
  lines.push('')
  lines.push(report.healthy
    ? warnings > 0
      ? `Ready, with ${warnings} warning${warnings === 1 ? '' : 's'}.`
      : 'Everything looks good.'
    : failures === 1
      ? '1 problem needs attention.'
      : `${failures} problems need attention.`)

  return `${lines.join('\n')}\n`
}

function defaultTokenCacheDir(): string {
  return `${process.env['HOME'] ?? ''}/.aws/sso/cache`
}

async function defaultProbeKiroCli(): Promise<string> {
  const { stdout } = await execFileAsync('kiro-cli', ['--version'], { timeout: KIRO_CLI_PROBE_TIMEOUT_MS })
  return stdout.trim().split('\n')[0] ?? ''
}

function defaultIsPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.once('listening', () => { probe.close(() => { resolve(true) }) })
    probe.listen(port, host)
  })
}

function maskSecret(value: string): string {
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-2)}`
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
