/**
 * Test helpers.
 *
 * The fake KiroClient is the point of the whole DI refactor: it makes the chat
 * path reachable from a test, which was impossible when the server imported the
 * transport directly.
 */

import type { KiroLinkConfig } from '../../src/config/config'
import { loadConfig } from '../../src/config/env'
import type { KiroRequest, KiroStreamEvent } from '../../src/domain/types'
import type { KiroClient } from '../../src/kiro/client'
import type { AuthProvider } from '../../src/kiro/auth'
import type { UsageService, KiroUsageSummary } from '../../src/kiro/usage'
import { createNullLogger } from '../../src/logging/logger'

/** A config built from an explicit env map, never the ambient process env. */
export function testConfig(overrides: Partial<KiroLinkConfig> = {}, env: NodeJS.ProcessEnv = {}): KiroLinkConfig {
  const { config } = loadConfig({ env, configPath: '/tmp/kirolink-test-config.json' })
  return {
    ...config,
    ...overrides,
    server: { ...config.server, ...overrides.server },
    upstream: { ...config.upstream, ...overrides.upstream },
    throttle: { ...config.throttle, delayMs: 1, ...overrides.throttle },
    limits: { ...config.limits, ...overrides.limits },
    translation: { ...config.translation, ...overrides.translation },
    credits: { ...config.credits, ...overrides.credits },
    diagnostics: { ...config.diagnostics, quiet: true, ...overrides.diagnostics },
    identity: { ...config.identity, ...overrides.identity },
  }
}

export type FakeKiroClient = KiroClient & {
  /** Requests the server handed to the client, in order. */
  readonly requests: KiroRequest[]
}

/**
 * A client that replays a fixed event script.
 *
 * Tool names are mapped back to the client's originals, mirroring the contract
 * the real HTTP client honors, so writer-level assertions see realistic names.
 */
export function fakeClient(events: KiroStreamEvent[]): FakeKiroClient {
  const requests: KiroRequest[] = []
  return {
    requests,
    async send(request, onEvent, signal) {
      requests.push(request)
      for (const event of events) {
        if (signal?.aborted) return
        onEvent(restoreToolName(event, request.toolNameMap))
        // Yield so an abort between events is observed, as with a real socket.
        await Promise.resolve()
      }
    },
  }
}

function restoreToolName(event: KiroStreamEvent, toolNameMap: ReadonlyMap<string, string>): KiroStreamEvent {
  if (event.type !== 'tool_use') return event
  const original = toolNameMap.get(event.toolUse.name)
  if (!original) return event
  return { ...event, toolUse: { ...event.toolUse, name: original } }
}

/** A client that always fails, for error-path tests. */
export function failingClient(error: Error): FakeKiroClient {
  const requests: KiroRequest[] = []
  return {
    requests,
    send(request) {
      requests.push(request)
      return Promise.reject(error)
    },
  }
}

/** A client that emits some events, then fails — the mid-stream error case. */
export function partialThenFailClient(events: KiroStreamEvent[], error: Error): FakeKiroClient {
  const requests: KiroRequest[] = []
  return {
    requests,
    async send(request, onEvent) {
      requests.push(request)
      for (const event of events) {
        onEvent(event)
        await Promise.resolve()
      }
      throw error
    },
  }
}

export function fakeAuth(): AuthProvider {
  return {
    load: () => Promise.resolve({ mode: 'api_key', apiKey: 'x'.repeat(24) }),
    invalidate: () => {},
    refresh: () => Promise.resolve(),
  }
}

export function fakeUsage(summary: KiroUsageSummary): UsageService {
  return { fetch: () => Promise.resolve(summary) }
}

export function okUsage(remaining = 100): KiroUsageSummary {
  return {
    ok: true,
    used: 10,
    limit: 10 + remaining,
    remaining,
    unit: 'CREDIT',
    percentUsed: 10,
    exhausted: remaining <= 0,
    fetchedAt: new Date().toISOString(),
  }
}

export const silentLogger = createNullLogger()

/** Text events, the common case in writer tests. */
export function textEvents(text: string, inputTokens = 5, outputTokens = 7): KiroStreamEvent[] {
  return [{ type: 'text', text }, { type: 'done', inputTokens, outputTokens }]
}
