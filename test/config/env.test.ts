/**
 * Configuration resolution.
 *
 * The precedence chain (CLI > env > saved file > default) and the legacy env
 * alias are the compatibility surface users script against, so both are pinned
 * here.
 */

import { describe, expect, it } from 'vitest'
import { defaultUserConfigPath, loadConfig } from '../../src/config/env'

describe('precedence', () => {
  it('defaults to cli auth with no key or region', () => {
    const { config, sources } = loadConfig({ env: {} })

    expect(config.upstream.mode).toBe('cli')
    expect(config.upstream.kiroApiKey).toBeUndefined()
    expect(config.upstream.apiRegion).toBeUndefined()
    expect(sources).toEqual({ auth: 'default', kiroApiKey: 'none', apiRegion: 'none' })
  })

  it('uses the saved file when CLI and env are unset', () => {
    const { config, sources } = loadConfig({
      env: {},
      stored: { auth: 'api-key', kiroApiKey: 'k'.repeat(24), apiRegion: 'eu-central-1' },
    })

    expect(config.upstream.mode).toBe('api-key')
    expect(config.upstream.apiRegion).toBe('eu-central-1')
    expect(sources).toEqual({ auth: 'config', kiroApiKey: 'config', apiRegion: 'config' })
  })

  it('lets env override the saved file', () => {
    const { config, sources } = loadConfig({
      env: { KIROLINK_AUTH: 'cli', KIROLINK_API_REGION: 'us-west-2' },
      stored: { auth: 'api-key', apiRegion: 'eu-central-1' },
    })

    expect(config.upstream.mode).toBe('cli')
    expect(config.upstream.apiRegion).toBe('us-west-2')
    expect(sources.auth).toBe('env')
  })

  it('lets CLI override env', () => {
    const { config, sources } = loadConfig({
      cli: { auth: 'api-key', kiroApiKey: 'c'.repeat(24), apiRegion: 'ap-south-1' },
      env: { KIROLINK_AUTH: 'cli', KIROLINK_KIRO_API_KEY: 'e'.repeat(24) },
    })

    expect(config.upstream.mode).toBe('api-key')
    expect(config.upstream.kiroApiKey).toBe('c'.repeat(24))
    expect(config.upstream.apiRegion).toBe('ap-south-1')
    expect(sources).toEqual({ auth: 'cli', kiroApiKey: 'cli', apiRegion: 'cli' })
  })

  it('rejects a malformed region from any source', () => {
    expect(() => loadConfig({ env: { KIROLINK_API_REGION: 'not a region!' } })).toThrow(/region/u)
    expect(() => loadConfig({ cli: { apiRegion: '../etc' } })).toThrow(/region/u)
  })
})

describe('legacy env aliases', () => {
  it('honors KIRO_PROXY_* names', () => {
    const { config } = loadConfig({
      env: {
        KIRO_PROXY_PORT: '5000',
        KIRO_PROXY_HOST: '0.0.0.0',
        KIRO_PROXY_AUTH: 'api-key',
        KIRO_PROXY_KIRO_API_KEY: 'legacy-key-value-here',
        KIRO_PROXY_API_REGION: 'eu-west-1',
      },
    })

    expect(config.server.port).toBe(5000)
    expect(config.server.host).toBe('0.0.0.0')
    expect(config.upstream.mode).toBe('api-key')
    expect(config.upstream.apiRegion).toBe('eu-west-1')
  })

  it('prefers the canonical name when both are present', () => {
    const { config } = loadConfig({ env: { KIROLINK_PORT: '4000', KIRO_PROXY_PORT: '5000' } })
    expect(config.server.port).toBe(4000)
  })

  it('honors the legacy AUTH_MODE spelling', () => {
    const { config } = loadConfig({ env: { KIRO_PROXY_AUTH_MODE: 'api-key' } })
    expect(config.upstream.mode).toBe('api-key')
  })
})

describe('numeric settings', () => {
  it('applies documented defaults', () => {
    const { config } = loadConfig({ env: {} })

    expect(config.server.port).toBe(4119)
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.throttle.maxConcurrent).toBe(2)
    expect(config.throttle.delayMs).toBe(200)
    expect(config.server.maxBodyBytes).toBe(16 * 1024 * 1024)
    expect(config.upstream.requestTimeoutMs).toBe(600_000)
  })

  it.each([
    ['KIROLINK_PORT', '0'],
    ['KIROLINK_PORT', '70000'],
    ['KIROLINK_PORT', 'abc'],
    ['KIROLINK_MAX_CONCURRENT', '-1'],
    ['KIROLINK_MAX_BODY_BYTES', '0'],
    ['KIROLINK_MAX_TOOLS', '1.5'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ env: { [name]: value } })).toThrow()
  })

  it('rejects a request timeout below the floor', () => {
    // A sub-30s timeout is far more likely a mistake than an intent, since real
    // generations routinely take minutes.
    expect(() => loadConfig({ env: { KIROLINK_REQUEST_TIMEOUT_MS: '5000' } })).toThrow(/at least/u)
    expect(loadConfig({ env: { KIROLINK_REQUEST_TIMEOUT_MS: '120000' } }).config.upstream.requestTimeoutMs).toBe(120_000)
  })
})

describe('boolean settings', () => {
  it.each(['1', 'true', 'TRUE', 'yes'])('treats %s as enabled', (value) => {
    expect(loadConfig({ env: { KIROLINK_REQUIRE_CREDITS: value } }).config.credits.required).toBe(true)
  })

  it.each(['0', 'false', 'no', ''])('treats %s as disabled', (value) => {
    expect(loadConfig({ env: { KIROLINK_REQUIRE_CREDITS: value } }).config.credits.required).toBe(false)
  })

  it('lets the legacy no-filter escape hatch win over the filter flag', () => {
    const both = loadConfig({
      env: { KIROLINK_FILTER_SYSTEM_PROMPT: '1', KIRO_PROXY_NO_PROMPT_FILTER: '1' },
    })
    expect(both.config.translation.filterSystemPrompt).toBe(false)

    const filterOnly = loadConfig({ env: { KIROLINK_FILTER_SYSTEM_PROMPT: '1' } })
    expect(filterOnly.config.translation.filterSystemPrompt).toBe(true)
  })
})

describe('defaultUserConfigPath', () => {
  it('prefers an explicit override', () => {
    expect(defaultUserConfigPath({ KIROLINK_CONFIG: '/custom/kirolink.json' })).toBe('/custom/kirolink.json')
  })

  it('honors the legacy override name', () => {
    expect(defaultUserConfigPath({ KIRO_PROXY_CONFIG: '/legacy.json' })).toBe('/legacy.json')
  })

  it('respects XDG_CONFIG_HOME', () => {
    expect(defaultUserConfigPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/kirolink/config.json')
  })

  it('falls back to ~/.config', () => {
    expect(defaultUserConfigPath({})).toMatch(/\.config\/kirolink\/config\.json$/u)
  })
})

describe('isolation', () => {
  it('reads nothing from the ambient process env when one is supplied', () => {
    process.env['KIROLINK_PORT'] = '9999'
    try {
      expect(loadConfig({ env: {} }).config.server.port).toBe(4119)
    } finally {
      delete process.env['KIROLINK_PORT']
    }
  })
})
