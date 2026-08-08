/**
 * Metrics, /v1/status, and the dashboard shell.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMetrics } from '../../src/observability/metrics'
import { fakeClient, fakeUsage, okUsage, textEvents } from '../support/harness'
import { getJson, postJson, startServer, type LiveServer } from '../support/server'

let live: LiveServer | undefined

afterEach(async () => {
  await live?.close()
  live = undefined
})

const chatBody = (model = 'claude-sonnet-4.6'): Record<string, unknown> => ({
  model,
  messages: [{ role: 'user', content: 'hello there, a test message' }],
})

describe('createMetrics', () => {
  it('starts empty', () => {
    const snapshot = createMetrics().snapshot()
    expect(snapshot.total).toBe(0)
    expect(snapshot.inFlight).toBe(0)
    expect(snapshot.recent).toEqual([])
  })

  it('counts outcomes separately', () => {
    const metrics = createMetrics()
    metrics.begin({ method: 'POST', path: '/a' }).finish('ok', 200)
    metrics.begin({ method: 'POST', path: '/b' }).finish('error', 500)
    metrics.begin({ method: 'POST', path: '/c' }).finish('aborted')

    const snapshot = metrics.snapshot()
    expect(snapshot).toMatchObject({ total: 3, ok: 1, errors: 1, aborted: 1, inFlight: 0 })
  })

  it('tracks in-flight requests', () => {
    const metrics = createMetrics()
    const tracker = metrics.begin({ method: 'POST', path: '/slow' })
    expect(metrics.snapshot().inFlight).toBe(1)
    tracker.finish('ok', 200)
    expect(metrics.snapshot().inFlight).toBe(0)
  })

  it('ignores a double finish', () => {
    // The server's catch and finally paths can both plausibly complete a request.
    const metrics = createMetrics()
    const tracker = metrics.begin({ method: 'POST', path: '/x' })
    tracker.finish('ok', 200)
    tracker.finish('error', 500)

    expect(metrics.snapshot()).toMatchObject({ total: 1, ok: 1, errors: 0, inFlight: 0 })
  })

  it('accumulates tokens', () => {
    const metrics = createMetrics()
    const first = metrics.begin({ method: 'POST', path: '/a' })
    first.setTokens(100, 20)
    first.finish('ok', 200)
    const second = metrics.begin({ method: 'POST', path: '/b' })
    second.setTokens(5, 3)
    second.finish('ok', 200)

    expect(metrics.snapshot()).toMatchObject({ inputTokens: 105, outputTokens: 23 })
  })

  it('records model, stream, and duration', () => {
    let now = 1000
    const metrics = createMetrics(() => now)
    const tracker = metrics.begin({ method: 'POST', path: '/v1/messages' })
    tracker.setModel('claude-opus-4.7')
    tracker.setStream(true)
    now = 1250
    tracker.finish('ok', 200)

    expect(metrics.snapshot().recent[0]).toMatchObject({
      path: '/v1/messages',
      model: 'claude-opus-4.7',
      stream: true,
      durationMs: 250,
      outcome: 'ok',
    })
  })

  it('lists newest first and caps history', () => {
    const metrics = createMetrics()
    for (let i = 0; i < 60; i++) {
      metrics.begin({ method: 'POST', path: `/r${i}` }).finish('ok', 200)
    }

    const { recent, total } = metrics.snapshot()
    expect(total).toBe(60)
    // History is bounded so a long-running proxy does not grow without limit.
    expect(recent).toHaveLength(50)
    expect(recent[0]?.path).toBe('/r59')
  })

  it('returns a copy, so callers cannot mutate internal state', () => {
    const metrics = createMetrics()
    metrics.begin({ method: 'POST', path: '/a' }).finish('ok', 200)
    metrics.snapshot().recent.length = 0

    expect(metrics.snapshot().recent).toHaveLength(1)
  })
})

describe('GET /v1/status', () => {
  it('reports config, credits, and metrics', async () => {
    live = await startServer({
      client: fakeClient(textEvents('hi', 40, 9)),
      usage: fakeUsage(okUsage(500)),
      version: '9.9.9',
    })
    await postJson(live.url, '/v1/messages', chatBody())

    const { status, body } = await getJson(live.url, '/v1/status')
    expect(status).toBe(200)

    const payload = body as {
      version: string
      baseUrl: string
      port: number
      authMode: string
      credits: { ok: boolean; remaining: number }
      metrics: { total: number; ok: number; inputTokens: number; recent: { model: string }[] }
    }
    expect(payload.version).toBe('9.9.9')
    expect(payload.authMode).toBe('cli')
    expect(payload.credits.remaining).toBe(500)
    expect(payload.metrics).toMatchObject({ total: 1, ok: 1, inputTokens: 40 })
    expect(payload.metrics.recent[0]?.model).toBe('claude-sonnet-4.6')
  })

  it('reports the port actually bound, not the configured one', async () => {
    // The harness listens on port 0, so a payload echoing config would be wrong.
    live = await startServer({ client: fakeClient(textEvents('hi')) })

    const { body } = await getJson(live.url, '/v1/status')
    const payload = body as { port: number; baseUrl: string }

    expect(payload.port).toBeGreaterThan(0)
    expect(live.url).toContain(String(payload.port))
    expect(payload.baseUrl).toBe(live.url)
  })

  it('records a failed request as an error', async () => {
    live = await startServer({ client: fakeClient(textEvents('hi')) })
    await postJson(live.url, '/v1/messages', { model: 'claude-sonnet-4.6', messages: [] })

    const { body } = await getJson(live.url, '/v1/status')
    const metrics = (body as { metrics: { errors: number; recent: { status: number }[] } }).metrics

    expect(metrics.errors).toBe(1)
    expect(metrics.recent[0]?.status).toBe(400)
  })

  it('stays reachable when a client API key is configured', async () => {
    // The dashboard is a local operator UI; the key protects inference endpoints.
    const apiKey = 'k'.repeat(32)
    live = await startServer(
      { client: fakeClient(textEvents('hi')) },
      { server: { apiKey, host: '127.0.0.1', port: 0, maxBodyBytes: 1_048_576 } },
    )

    expect((await getJson(live.url, '/v1/status')).status).toBe(200)
    expect((await getJson(live.url, '/v1/models')).status).toBe(401)
  })

  it('reports credits as undefined when the lookup fails', async () => {
    const failed = { ok: false as const, error: 'quota down', fetchedAt: new Date().toISOString() }
    live = await startServer({ client: fakeClient(textEvents('hi')), usage: fakeUsage(failed) })

    const { body } = await getJson(live.url, '/v1/status')
    expect((body as { credits: { ok: boolean } }).credits.ok).toBe(false)
  })
})

describe('dashboard', () => {
  it('serves an HTML document', async () => {
    live = await startServer({ client: fakeClient(textEvents('hi')) })

    const res = await fetch(`${live.url}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const html = await res.text()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('KiroLink')
    // Self-contained: no external asset requests.
    expect(html).not.toMatch(/<script[^>]+src=/u)
    expect(html).not.toMatch(/<link[^>]+stylesheet/u)
  })

  it('serves a favicon so the browser console stays clean', async () => {
    live = await startServer({ client: fakeClient(textEvents('hi')) })

    const svg = await fetch(`${live.url}/favicon.svg`)
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toContain('image/svg+xml')

    expect((await fetch(`${live.url}/favicon.ico`)).status).toBe(204)
  })
})
