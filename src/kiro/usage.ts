/**
 * Kiro credit / quota lookup (getUsageLimits).
 *
 * The cache is instance state rather than a module global, so two providers do
 * not share it and tests need no reset hook.
 */

import type { ClientIdentityConfig, UpstreamConfig } from '../config/config'
import type { Logger } from '../logging/logger'
import type { AuthProvider, KiroAuth } from './auth'
import { buildClientHeaders } from './auth'
import { resolveUsageRestBase } from './endpoint'

const CACHE_TTL_MS = 60_000
const FETCH_TIMEOUT_MS = 12_000
/** Failures are cached briefly to avoid a stampede without masking recovery. */
const FAILURE_CACHE_TTL_MS = 5_000

export type UsageBucket = {
  used: number
  limit: number
  remaining: number
  unit: string
  resourceType?: string
}

export type KiroUsageSummary =
  | {
      ok: true
      used: number
      limit: number
      remaining: number
      unit: string
      percentUsed: number
      exhausted: boolean
      trial?: UsageBucket & { status?: string }
      bonuses?: Array<UsageBucket & { code?: string; name?: string }>
      subscription?: { type?: string; title?: string; status?: string }
      email?: string
      nextResetDate?: string
      fetchedAt: string
    }
  | { ok: false; error: string; fetchedAt: string }

export type UsageService = {
  fetch(options?: { force?: boolean }): Promise<KiroUsageSummary>
}

export type UsageServiceDeps = {
  upstream: UpstreamConfig
  identity: ClientIdentityConfig
  auth: AuthProvider
  logger: Logger
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const { upstream, identity, auth, logger } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  let cache: { at: number; ttl: number; value: KiroUsageSummary } | null = null

  return {
    async fetch(options) {
      if (!options?.force && cache && Date.now() - cache.at < cache.ttl) return cache.value

      try {
        const credential = await auth.load()
        const raw = await getUsageLimitsRaw(credential, upstream, identity, fetchImpl)
        const summary = summarizeUsageResponse(raw)
        cache = { at: Date.now(), ttl: CACHE_TTL_MS, value: summary }
        return summary
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.log('debug', 'usage lookup failed', { error: message })
        const failed: KiroUsageSummary = { ok: false, error: message, fetchedAt: new Date().toISOString() }
        cache = { at: Date.now(), ttl: FAILURE_CACHE_TTL_MS, value: failed }
        return failed
      }
    },
  }
}

/** One-line summary for startup and logs. */
export function formatUsageLine(usage: KiroUsageSummary): string {
  if (!usage.ok) return `credits unavailable (${usage.error})`
  const parts = [`credits ${fmt(usage.used)}/${fmt(usage.limit)} used`, `${fmt(usage.remaining)} remaining`]
  if (usage.trial && usage.trial.limit > 0) parts.push(`trial ${fmt(usage.trial.remaining)} left`)
  if (usage.nextResetDate) parts.push(`reset ${usage.nextResetDate}`)
  const plan = usage.subscription?.title || usage.subscription?.type
  if (plan) parts.push(plan)
  if (usage.exhausted) parts.push('EXHAUSTED')
  return parts.filter(Boolean).join(' · ')
}

export function buildUsageLimitsUrl(auth: KiroAuth, upstream: UpstreamConfig): string {
  const base = resolveUsageRestBase(resolveDataRegion(auth, upstream))
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true',
  })
  if (auth.mode === 'oauth' && auth.profileArn) params.set('profileArn', auth.profileArn)
  return `${base}/getUsageLimits?${params.toString()}`
}

/**
 * Parse the getUsageLimits JSON into a credit summary.
 * Exported for unit tests (no network).
 */
export function summarizeUsageResponse(raw: unknown): KiroUsageSummary {
  const fetchedAt = new Date().toISOString()
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'empty usage response', fetchedAt }

  const body = raw as Record<string, unknown>
  const breakdowns = Array.isArray(body['usageBreakdownList']) ? body['usageBreakdownList'] : []
  const first = breakdowns.length > 0 ? breakdowns[0] : undefined

  const primary = first !== undefined ? asBucket(first) : emptyBucket()
  const trial = first !== undefined ? asTrial(first) : undefined
  const bonuses = first !== undefined ? asBonuses(first) : undefined

  // Remaining spans all funding sources: the base allowance plus any trial and
  // active bonus buckets.
  let remaining = primary.remaining
  if (trial) remaining += trial.remaining
  for (const bonus of bonuses ?? []) remaining += bonus.remaining

  const subscription = asSubscription(body['subscriptionInfo'])
  const userInfo = asRecord(body['userInfo'])
  const email = typeof userInfo?.['email'] === 'string' ? userInfo['email'] : undefined
  const nextResetDate = parseNextReset(body['nextDateReset'])
  const percentUsed = primary.limit > 0 ? Math.min(100, Math.max(0, (primary.used / primary.limit) * 100)) : 0

  return {
    ok: true,
    used: primary.used,
    limit: primary.limit,
    remaining,
    unit: primary.unit || 'CREDIT',
    percentUsed,
    exhausted: remaining <= 0,
    ...(trial ? { trial } : {}),
    ...(bonuses && bonuses.length > 0 ? { bonuses } : {}),
    ...(subscription ? { subscription } : {}),
    ...(email ? { email } : {}),
    ...(nextResetDate ? { nextResetDate } : {}),
    fetchedAt,
  }
}

async function getUsageLimitsRaw(
  auth: KiroAuth,
  upstream: UpstreamConfig,
  identity: ClientIdentityConfig,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(buildUsageLimitsUrl(auth, upstream), {
      method: 'GET',
      headers: buildClientHeaders(auth, identity, 'application/json'),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`getUsageLimits HTTP ${res.status}: ${text.slice(0, 300)}`)
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new Error('getUsageLimits returned non-JSON body', { cause: error })
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`getUsageLimits timed out after ${FETCH_TIMEOUT_MS}ms`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** The OAuth profile ARN encodes the account's real region; prefer it. */
function resolveDataRegion(auth: KiroAuth, upstream: UpstreamConfig): string {
  if (auth.mode === 'oauth') {
    const fromArn = regionFromProfileArn(auth.profileArn)
    if (fromArn) return fromArn
  }
  return upstream.apiRegion ?? 'us-east-1'
}

export function regionFromProfileArn(profileArn: string | undefined): string | undefined {
  if (!profileArn) return undefined
  // arn:aws:codewhisperer:REGION:account:profile/...
  const parts = profileArn.trim().split(':')
  if (parts.length >= 6 && parts[0] === 'arn' && parts[2] === 'codewhisperer' && parts[3]) return parts[3]
  return undefined
}

function asBucket(entry: unknown): UsageBucket {
  const rec = asRecord(entry)
  const used = num(rec?.['currentUsage'])
  const limit = num(rec?.['usageLimit'])
  const unit = typeof rec?.['unit'] === 'string' ? rec['unit'] : 'CREDIT'
  const resourceType = typeof rec?.['resourceType'] === 'string' ? rec['resourceType'] : undefined
  return { used, limit, remaining: Math.max(0, limit - used), unit, ...(resourceType ? { resourceType } : {}) }
}

function asTrial(entry: unknown): (UsageBucket & { status?: string }) | undefined {
  const trial = asRecord(asRecord(entry)?.['freeTrialInfo'])
  if (!trial) return undefined
  const used = num(trial['currentUsage'])
  const limit = num(trial['usageLimit'])
  if (limit <= 0 && used <= 0) return undefined
  const status = typeof trial['freeTrialStatus'] === 'string' ? trial['freeTrialStatus'] : undefined
  return { used, limit, remaining: Math.max(0, limit - used), unit: 'CREDIT', ...(status ? { status } : {}) }
}

function asBonuses(entry: unknown): Array<UsageBucket & { code?: string; name?: string }> | undefined {
  const list = asRecord(entry)?.['bonuses']
  if (!Array.isArray(list) || list.length === 0) return undefined
  const out: Array<UsageBucket & { code?: string; name?: string }> = []
  for (const item of list) {
    const bonus = asRecord(item)
    if (!bonus) continue
    const used = num(bonus['currentUsage'])
    const limit = num(bonus['usageLimit'])
    if (limit <= 0 && used <= 0) continue
    const status = typeof bonus['status'] === 'string' ? bonus['status'].toUpperCase() : ''
    if (status && status !== 'ACTIVE' && status !== 'ENABLED') continue
    out.push({
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unit: 'CREDIT',
      ...(typeof bonus['bonusCode'] === 'string' ? { code: bonus['bonusCode'] } : {}),
      ...(typeof bonus['displayName'] === 'string' ? { name: bonus['displayName'] } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

function asSubscription(value: unknown): { type?: string; title?: string; status?: string } | undefined {
  const rec = asRecord(value)
  if (!rec) return undefined
  const name = typeof rec['subscriptionName'] === 'string' ? rec['subscriptionName'] : undefined
  const type = typeof rec['subscriptionType'] === 'string' ? rec['subscriptionType'] : name
  const title = typeof rec['subscriptionTitle'] === 'string' ? rec['subscriptionTitle'] : name
  const status = typeof rec['status'] === 'string' ? rec['status'] : undefined
  if (!type && !title && !status) return undefined
  return { ...(type ? { type } : {}), ...(title ? { title } : {}), ...(status ? { status } : {}) }
}

function parseNextReset(value: unknown): string | undefined {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value)
      : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  // AWS returns seconds or milliseconds depending on the field; treat large
  // values as milliseconds.
  const date = new Date(n > 1e12 ? n : n * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}

function emptyBucket(): UsageBucket {
  return { used: 0, limit: 0, remaining: 0, unit: 'CREDIT' }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/u, '')
}
