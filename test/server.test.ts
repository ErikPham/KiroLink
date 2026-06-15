import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createKiroProxyServer } from '../src/server'
import type { Server } from 'node:http'
import type { ProxyConfig } from '../src/config'

let server: Server
const PORT = 14119
const baseConfig: ProxyConfig = { port: PORT, host: '127.0.0.1', quiet: true, verbose: false, maxConcurrent: 2, delayMs: 0, apiKey: undefined, maxBodyBytes: 1_048_576 }

beforeAll(() => new Promise<void>((resolve) => {
  server = createKiroProxyServer(baseConfig)
  server.listen(PORT, '127.0.0.1', resolve)
}))

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))

async function fetch(path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: unknown }> {
  const res = await globalThis.fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: options?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })
  const body = await res.json()
  return { status: res.status, body }
}

describe('server routes', () => {
  it('GET /health', async () => {
    const { status, body } = await fetch('/health')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
  })

  it('GET /v1/models returns list with claude models', async () => {
    const { status, body } = await fetch('/v1/models')
    expect(status).toBe(200)
    const data = body as { object: string; data: { id: string }[] }
    expect(data.object).toBe('list')
    expect(data.data.length).toBeGreaterThan(10)
    const ids = data.data.map((m) => m.id)
    expect(ids).toContain('claude-opus-4-8')
    expect(ids).toContain('claude-opus-4-8[1m]')
    expect(ids).toContain('claude-sonnet-4-6')
  })

  it('POST /api/event_logging/batch returns ok', async () => {
    const { status, body } = await fetch('/api/event_logging/batch', { method: 'POST', body: { events: [] } })
    expect(status).toBe(200)
    expect(body).toEqual({ status: 'ok' })
  })

  it('POST /v1/messages/count_tokens returns estimate', async () => {
    const { status, body } = await fetch('/v1/messages/count_tokens', {
      method: 'POST',
      body: { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hello world' }] },
    })
    expect(status).toBe(200)
    expect((body as { input_tokens: number }).input_tokens).toBeGreaterThan(0)
  })

  it('HEAD / returns 200', async () => {
    const res = await globalThis.fetch(`http://127.0.0.1:${PORT}/`, { method: 'HEAD' })
    expect(res.status).toBe(200)
  })

  it('unknown path returns 404', async () => {
    const { status } = await fetch('/v1/unknown')
    expect(status).toBe(404)
  })

  it('requires api-key when configured', async () => {
    const apiKey = 'secret1234567890'
    const s2 = createKiroProxyServer({ ...baseConfig, port: 14120, maxConcurrent: 1, apiKey })
    await new Promise<void>((r) => s2.listen(14120, '127.0.0.1', r))
    try {
      const res1 = await globalThis.fetch('http://127.0.0.1:14120/v1/models')
      expect(res1.status).toBe(401)

      const res2 = await globalThis.fetch('http://127.0.0.1:14120/v1/models', { headers: { 'x-api-key': apiKey } })
      expect(res2.status).toBe(200)
    } finally {
      await new Promise<void>((r) => s2.close(() => r()))
    }
  })

  it('rejects weak api keys even on localhost', () => {
    expect(() => createKiroProxyServer({ ...baseConfig, apiKey: 'short' })).toThrow('API key must be at least')
  })

  it('rejects bodies above the configured limit', async () => {
    const s2 = createKiroProxyServer({ ...baseConfig, port: 14121, maxBodyBytes: 32 })
    await new Promise<void>((r) => s2.listen(14121, '127.0.0.1', r))
    try {
      const res = await globalThis.fetch('http://127.0.0.1:14121/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(128) }] }),
      })
      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ error: { message: 'Request body is too large' } })
    } finally {
      await new Promise<void>((r) => s2.close(() => r()))
    }
  })

  it('only reflects local CORS origins', async () => {
    const local = await globalThis.fetch(`http://127.0.0.1:${PORT}/health`, { headers: { origin: 'http://localhost:3000' } })
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')

    const remote = await globalThis.fetch(`http://127.0.0.1:${PORT}/health`, { headers: { origin: 'https://example.com' } })
    expect(remote.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('rejects invalid JSON as a bad request', async () => {
    const res = await globalThis.fetch(`http://127.0.0.1:${PORT}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { type: 'invalid_request_error', message: 'Invalid JSON request body' } })
  })

})
