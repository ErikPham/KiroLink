/**
 * Upstream auth: credential selection, headers, and token file discovery.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertUpstreamConfig, describeUpstream, parseAuthMode } from '../../src/config/config'
import {
  buildAuthHeaders,
  buildClientHeaders,
  createAuthProvider,
  resolveProfileArn,
  resolveTokenPath,
  validateToken,
  type KiroToken,
} from '../../src/kiro/auth'
import { silentLogger, testConfig } from '../support/harness'

const config = testConfig()

function upstream(overrides = {}): typeof config.upstream {
  return { ...config.upstream, ...overrides }
}

function token(overrides: Partial<KiroToken> = {}): KiroToken {
  return {
    accessToken: 'a'.repeat(40),
    refreshToken: 'r'.repeat(20),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF',
    ...overrides,
  }
}

describe('parseAuthMode', () => {
  it.each([
    [undefined, 'cli'],
    ['cli', 'cli'],
    ['kiro-cli', 'cli'],
    ['oauth', 'cli'],
    ['api-key', 'api-key'],
    ['apikey', 'api-key'],
    ['API_KEY', 'api-key'],
  ])('parses %s as %s', (input, expected) => {
    expect(parseAuthMode(input)).toBe(expected)
  })

  it('rejects an unknown mode', () => {
    expect(() => parseAuthMode('basic')).toThrow(/Invalid auth mode/u)
  })
})

describe('assertUpstreamConfig', () => {
  it('requires a key only in api-key mode', () => {
    expect(() => assertUpstreamConfig(upstream({ mode: 'cli', kiroApiKey: undefined }))).not.toThrow()
    expect(() => assertUpstreamConfig(upstream({ mode: 'api-key', kiroApiKey: undefined }))).toThrow(/requires/u)
  })

  it('rejects a key that is too short to be real', () => {
    expect(() => assertUpstreamConfig(upstream({ mode: 'api-key', kiroApiKey: 'short' }))).toThrow(/at least/u)
    expect(() => assertUpstreamConfig(upstream({ mode: 'api-key', kiroApiKey: 'k'.repeat(24) }))).not.toThrow()
  })
})

describe('headers', () => {
  it('sends Bearer plus tokentype for an API key', () => {
    expect(buildAuthHeaders({ mode: 'api_key', apiKey: 'secret-key-value' })).toEqual({
      Authorization: 'Bearer secret-key-value',
      tokentype: 'API_KEY',
    })
  })

  it('sends only Bearer for OAuth', () => {
    const headers = buildAuthHeaders({ mode: 'oauth', accessToken: 'tok', profileArn: 'arn:x' })
    expect(headers).toEqual({ Authorization: 'Bearer tok' })
    expect(headers).not.toHaveProperty('tokentype')
  })

  it('spoofs the kiro-cli client identity', () => {
    const headers = buildClientHeaders({ mode: 'oauth', accessToken: 't', profileArn: 'arn:x' }, config.identity)

    expect(headers['User-Agent']).toContain('aws-sdk-rust')
    expect(headers['User-Agent']).toContain(config.identity.kiroCliVersion)
    expect(headers['x-amzn-codewhisperer-optout']).toBe('true')
  })

  it('honors a user-agent override', () => {
    const headers = buildClientHeaders(
      { mode: 'api_key', apiKey: 'k'.repeat(20) },
      { ...config.identity, userAgent: 'custom/1.0' },
    )
    expect(headers['User-Agent']).toBe('custom/1.0')
  })
})

describe('resolveProfileArn', () => {
  it('returns the ARN for OAuth and requires one', () => {
    expect(resolveProfileArn({ mode: 'oauth', accessToken: 't', profileArn: 'arn:x' })).toBe('arn:x')
    expect(() => resolveProfileArn({ mode: 'oauth', accessToken: 't', profileArn: '' })).toThrow(/profileArn/u)
  })

  it('omits the ARN for an API key, which has no profile', () => {
    expect(resolveProfileArn({ mode: 'api_key', apiKey: 'k'.repeat(20) })).toBeUndefined()
  })
})

describe('validateToken', () => {
  it('accepts the expected shape', () => {
    expect(() => validateToken(token())).not.toThrow()
  })

  it.each([
    ['a short access token', { accessToken: 'x' }],
    ['a non-ARN profile', { profileArn: 'not-an-arn' }],
    ['an unparseable expiry', { expiresAt: 'whenever' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateToken(token(overrides as Partial<KiroToken>))).toThrow()
  })
})

describe('token file discovery', () => {
  async function tokenDir(files: Record<string, KiroToken | string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-tokens-'))
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
    }
    return dir
  }

  it('prefers an explicit path without touching the cache dir', async () => {
    expect(await resolveTokenPath('/nonexistent', '/explicit/token.json')).toBe('/explicit/token.json')
  })

  it('falls back to the legacy filename', async () => {
    const dir = await tokenDir({ 'kiro-auth-token.json': token() })
    expect(await resolveTokenPath(dir)).toBe(join(dir, 'kiro-auth-token.json'))
  })

  it('discovers a valid token by shape when filenames drift', async () => {
    const dir = await tokenDir({ 'sso-cache-9f8e.json': token() })
    expect(await resolveTokenPath(dir)).toBe(join(dir, 'sso-cache-9f8e.json'))
  })

  it('prefers the token that expires latest', async () => {
    const dir = await tokenDir({
      'kiro-auth-token-cli.json': token({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      'other.json': token({ expiresAt: new Date(Date.now() + 7_200_000).toISOString() }),
    })
    expect(await resolveTokenPath(dir)).toBe(join(dir, 'other.json'))
  })

  it('ignores malformed candidates', async () => {
    const dir = await tokenDir({ 'broken.json': '{not json', 'kiro-auth-token-cli.json': token() })
    expect(await resolveTokenPath(dir)).toBe(join(dir, 'kiro-auth-token-cli.json'))
  })

  it('reports every path searched when nothing is valid', async () => {
    const dir = await tokenDir({ 'junk.json': '{}' })
    await expect(resolveTokenPath(dir)).rejects.toThrow(/Searched/u)
  })

  it('fails clearly when the cache directory is unreadable', async () => {
    await expect(resolveTokenPath('/definitely/not/here')).rejects.toThrow(/Unable to read/u)
  })
})

describe('createAuthProvider', () => {
  it('returns an api_key credential in api-key mode', async () => {
    const provider = createAuthProvider(upstream({ mode: 'api-key', kiroApiKey: 'k'.repeat(24) }), silentLogger)
    await expect(provider.load()).resolves.toEqual({ mode: 'api_key', apiKey: 'k'.repeat(24) })
  })

  it('rejects api-key mode with no key', async () => {
    const provider = createAuthProvider(upstream({ mode: 'api-key', kiroApiKey: undefined }), silentLogger)
    await expect(provider.load()).rejects.toThrow(/requires/u)
  })

  it('loads and caches an OAuth token from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-auth-'))
    const path = join(dir, 'kiro-auth-token-cli.json')
    await writeFile(path, JSON.stringify(token()))

    const provider = createAuthProvider(upstream({ mode: 'cli', tokenPath: path }), silentLogger)
    const credential = await provider.load()

    expect(credential).toEqual({
      mode: 'oauth',
      accessToken: 'a'.repeat(40),
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF',
    })

    // A second load is served from cache, so removing the file changes nothing.
    await writeFile(path, '{corrupt')
    await expect(provider.load()).resolves.toEqual(credential)

    // After invalidation the corrupt file is read and rejected.
    provider.invalidate()
    await expect(provider.load()).rejects.toThrow()
  })

  it('treats refresh as a no-op in api-key mode', async () => {
    const provider = createAuthProvider(upstream({ mode: 'api-key', kiroApiKey: 'k'.repeat(24) }), silentLogger)
    await expect(provider.refresh()).resolves.toBeUndefined()
  })
})

describe('describeUpstream', () => {
  it('names the cli path', () => {
    expect(describeUpstream(upstream({ mode: 'cli', kiroApiKey: undefined }))).toBe('cli (kiro-cli cache)')
  })

  it('warns when a key is present but unused', () => {
    expect(describeUpstream(upstream({ mode: 'cli', kiroApiKey: 'k'.repeat(20) }))).toContain('ignored')
  })

  it('reports the region in api-key mode', () => {
    expect(describeUpstream(upstream({ mode: 'api-key', kiroApiKey: 'k'.repeat(20), apiRegion: 'eu-central-1' })))
      .toBe('api-key (region=eu-central-1)')
  })

  it('reports a URL override', () => {
    expect(describeUpstream(upstream({
      mode: 'api-key',
      kiroApiKey: 'k'.repeat(20),
      apiUrl: 'https://runtime.us-east-1.kiro.dev/',
    }))).toContain('override')
  })
})
