/**
 * Credit / quota parsing and the usage service cache.
 */

import { describe, expect, it } from 'vitest'
import type { KiroAuth } from '../../src/kiro/auth'
import {
  buildUsageLimitsUrl,
  createUsageService,
  formatUsageLine,
  regionFromProfileArn,
  summarizeUsageResponse,
} from '../../src/kiro/usage'
import { fakeAuth, silentLogger, testConfig } from '../support/harness'

const config = testConfig()

const oauth: KiroAuth = {
  mode: 'oauth',
  accessToken: 'token',
  profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC',
}
const apiKey: KiroAuth = { mode: 'api_key', apiKey: 'k'.repeat(24) }

describe('summarizeUsageResponse', () => {
  it('sums the primary allowance, trial, and active bonuses', () => {
    const summary = summarizeUsageResponse({
      usageBreakdownList: [{
        currentUsage: 40,
        usageLimit: 100,
        unit: 'CREDIT',
        resourceType: 'AGENTIC_REQUEST',
        freeTrialInfo: { currentUsage: 5, usageLimit: 20, freeTrialStatus: 'ACTIVE' },
        bonuses: [
          { currentUsage: 0, usageLimit: 10, status: 'ACTIVE', bonusCode: 'PROMO', displayName: 'Promo' },
          { currentUsage: 0, usageLimit: 50, status: 'EXPIRED' },
        ],
      }],
    })

    expect(summary.ok).toBe(true)
    if (!summary.ok) return
    // 60 primary + 15 trial + 10 active bonus; the expired bonus is excluded.
    expect(summary.remaining).toBe(85)
    expect(summary.used).toBe(40)
    expect(summary.percentUsed).toBe(40)
    expect(summary.exhausted).toBe(false)
    expect(summary.bonuses).toHaveLength(1)
  })

  it('marks exhausted when nothing remains', () => {
    const summary = summarizeUsageResponse({ usageBreakdownList: [{ currentUsage: 100, usageLimit: 100 }] })
    expect(summary.ok && summary.exhausted).toBe(true)
  })

  it('reports failure for an empty or non-object payload', () => {
    for (const raw of [null, undefined, 'text', 42]) {
      expect(summarizeUsageResponse(raw).ok).toBe(false)
    }
  })

  it('tolerates a payload with no breakdown list', () => {
    const summary = summarizeUsageResponse({})
    expect(summary.ok).toBe(true)
    if (summary.ok) expect(summary.limit).toBe(0)
  })

  it('extracts subscription, email, and reset date', () => {
    const summary = summarizeUsageResponse({
      usageBreakdownList: [{ currentUsage: 1, usageLimit: 10 }],
      subscriptionInfo: { subscriptionTitle: 'Pro', status: 'ACTIVE' },
      userInfo: { email: 'dev@example.com' },
      nextDateReset: 1_767_225_600,
    })

    expect(summary.ok).toBe(true)
    if (!summary.ok) return
    expect(summary.subscription?.title).toBe('Pro')
    expect(summary.email).toBe('dev@example.com')
    expect(summary.nextResetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
  })

  it('accepts a reset date in milliseconds', () => {
    const summary = summarizeUsageResponse({
      usageBreakdownList: [{ currentUsage: 0, usageLimit: 1 }],
      nextDateReset: 1_767_225_600_000,
    })
    expect(summary.ok && summary.nextResetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
  })

  it('parses numeric strings from the API', () => {
    const summary = summarizeUsageResponse({ usageBreakdownList: [{ currentUsage: '25', usageLimit: '100' }] })
    expect(summary.ok && summary.remaining).toBe(75)
  })
})

describe('formatUsageLine', () => {
  it('summarizes a successful lookup', () => {
    const line = formatUsageLine(summarizeUsageResponse({
      usageBreakdownList: [{ currentUsage: 10, usageLimit: 100 }],
      subscriptionInfo: { subscriptionTitle: 'Pro' },
    }))

    expect(line).toContain('10/100 used')
    expect(line).toContain('90 remaining')
    expect(line).toContain('Pro')
  })

  it('flags exhaustion', () => {
    const line = formatUsageLine(summarizeUsageResponse({ usageBreakdownList: [{ currentUsage: 5, usageLimit: 5 }] }))
    expect(line).toContain('EXHAUSTED')
  })

  it('reports a failure reason', () => {
    expect(formatUsageLine({ ok: false, error: 'network down', fetchedAt: '' })).toContain('network down')
  })
})

describe('buildUsageLimitsUrl', () => {
  it('derives the region from an OAuth profile ARN', () => {
    const url = buildUsageLimitsUrl(oauth, config.upstream)
    expect(url).toContain('https://q.eu-central-1.amazonaws.com/getUsageLimits')
    expect(url).toContain('profileArn=arn')
  })

  it('omits profileArn for an API key', () => {
    const url = buildUsageLimitsUrl(apiKey, config.upstream)
    expect(url).not.toContain('profileArn')
    expect(url).toContain('codewhisperer.us-east-1.amazonaws.com')
  })

  it('falls back to the configured region for an API key', () => {
    const url = buildUsageLimitsUrl(apiKey, { ...config.upstream, apiRegion: 'ap-southeast-2' })
    expect(url).toContain('q.ap-southeast-2.amazonaws.com')
  })

  it('always requests the agentic-request resource with email', () => {
    const url = buildUsageLimitsUrl(apiKey, config.upstream)
    expect(url).toContain('resourceType=AGENTIC_REQUEST')
    expect(url).toContain('isEmailRequired=true')
  })
})

describe('regionFromProfileArn', () => {
  it('reads the region segment', () => {
    expect(regionFromProfileArn('arn:aws:codewhisperer:us-west-2:1:profile/X')).toBe('us-west-2')
  })

  it.each([undefined, '', 'not-an-arn', 'arn:aws:s3:::bucket'])('returns undefined for %s', (input) => {
    expect(regionFromProfileArn(input)).toBeUndefined()
  })
})

describe('createUsageService', () => {
  function service(fetchImpl: typeof fetch) {
    return createUsageService({
      upstream: config.upstream,
      identity: config.identity,
      auth: fakeAuth(),
      logger: silentLogger,
      fetchImpl,
    })
  }

  const okResponse = (): Response =>
    new Response(JSON.stringify({ usageBreakdownList: [{ currentUsage: 1, usageLimit: 10 }] }), { status: 200 })

  it('caches a successful lookup', async () => {
    let calls = 0
    const usage = service(() => {
      calls++
      return Promise.resolve(okResponse())
    })

    await usage.fetch()
    await usage.fetch()

    expect(calls).toBe(1)
  })

  it('bypasses the cache when forced', async () => {
    let calls = 0
    const usage = service(() => {
      calls++
      return Promise.resolve(okResponse())
    })

    await usage.fetch()
    await usage.fetch({ force: true })

    expect(calls).toBe(2)
  })

  it('reports an HTTP failure without throwing', async () => {
    const usage = service(() => Promise.resolve(new Response('denied', { status: 403 })))
    const summary = await usage.fetch()

    expect(summary.ok).toBe(false)
    if (!summary.ok) expect(summary.error).toContain('403')
  })

  it('reports a non-JSON body without throwing', async () => {
    const usage = service(() => Promise.resolve(new Response('<html>', { status: 200 })))
    const summary = await usage.fetch()

    expect(summary.ok).toBe(false)
    if (!summary.ok) expect(summary.error).toContain('non-JSON')
  })

  it('reports a transport error without throwing', async () => {
    const usage = service(() => Promise.reject(new Error('socket closed')))
    const summary = await usage.fetch()

    expect(summary.ok).toBe(false)
    if (!summary.ok) expect(summary.error).toContain('socket closed')
  })

  it('keeps caches independent between instances', async () => {
    let first = 0
    let second = 0
    const a = service(() => { first++; return Promise.resolve(okResponse()) })
    const b = service(() => { second++; return Promise.resolve(okResponse()) })

    await a.fetch()
    await b.fetch()

    expect(first).toBe(1)
    expect(second).toBe(1)
  })
})
