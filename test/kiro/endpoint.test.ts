/**
 * Runtime URL resolution and host allowlisting.
 *
 * These guards prevent the bearer token from being sent to an attacker-chosen
 * host, so they are security-relevant rather than cosmetic.
 */

import { describe, expect, it } from 'vitest'
import {
  defaultKiroApiUrl,
  isAllowedKiroApiHost,
  resolveKiroApiUrl,
  resolveUsageRestBase,
} from '../../src/kiro/endpoint'
import { testConfig } from '../support/harness'

const base = testConfig().upstream

function upstream(overrides = {}): typeof base {
  return { ...base, ...overrides }
}

describe('isAllowedKiroApiHost', () => {
  it.each([
    'runtime.us-east-1.kiro.dev',
    'runtime.eu-central-1.kiro.dev',
    'q.ap-southeast-2.amazonaws.com',
    'codewhisperer.us-east-1.amazonaws.com',
  ])('allows %s', (host) => {
    expect(isAllowedKiroApiHost(host)).toBe(true)
  })

  it.each([
    'evil.com',
    'runtime.us-east-1.kiro.dev.evil.com',
    'kiro.dev',
    'q.amazonaws.com.evil.net',
  ])('rejects %s', (host) => {
    expect(isAllowedKiroApiHost(host)).toBe(false)
  })
})

describe('defaultKiroApiUrl', () => {
  it('defaults to us-east-1', () => {
    expect(defaultKiroApiUrl({ apiRegion: undefined })).toBe('https://runtime.us-east-1.kiro.dev/')
  })

  it('retargets by region', () => {
    expect(defaultKiroApiUrl({ apiRegion: 'eu-central-1' })).toBe('https://runtime.eu-central-1.kiro.dev/')
  })
})

describe('resolveKiroApiUrl', () => {
  it('uses the regional default when no override is set', () => {
    expect(resolveKiroApiUrl(upstream({ apiRegion: 'eu-central-1' })).hostname).toBe('runtime.eu-central-1.kiro.dev')
  })

  it('accepts a valid override', () => {
    const url = resolveKiroApiUrl(upstream({ apiUrl: 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse' }))
    expect(url.pathname).toBe('/generateAssistantResponse')
  })

  it.each([
    ['plain http', 'http://runtime.us-east-1.kiro.dev/', /https/u],
    ['embedded credentials', 'https://user:pass@runtime.us-east-1.kiro.dev/', /credentials/u],
    ['an unexpected path', 'https://runtime.us-east-1.kiro.dev/evil', /path/u],
    ['a query string', 'https://runtime.us-east-1.kiro.dev/?x=1', /query/u],
    ['a custom port', 'https://runtime.us-east-1.kiro.dev:8443/', /port/u],
    ['an untrusted host', 'https://evil.example.com/', /untrusted/u],
  ])('rejects %s', (_label, apiUrl, pattern) => {
    expect(() => resolveKiroApiUrl(upstream({ apiUrl }))).toThrow(pattern)
  })

  it('permits an untrusted host only when explicitly allowed', () => {
    expect(() => resolveKiroApiUrl(upstream({
      apiUrl: 'https://localhost:8443/',
      allowUntrustedApiUrl: true,
    }))).not.toThrow()
  })
})

describe('resolveUsageRestBase', () => {
  it('uses the codewhisperer host in us-east-1', () => {
    expect(resolveUsageRestBase('us-east-1')).toBe('https://codewhisperer.us-east-1.amazonaws.com')
  })

  it('uses the regional Amazon Q host elsewhere', () => {
    expect(resolveUsageRestBase('eu-central-1')).toBe('https://q.eu-central-1.amazonaws.com')
  })
})
