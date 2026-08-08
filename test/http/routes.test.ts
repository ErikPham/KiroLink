/**
 * Routing, auth, CORS, and body limits.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { assertSafeBind } from '../../src/config/config'
import { fakeClient, textEvents } from '../support/harness'
import { getJson, postJson, startServer, type LiveServer } from '../support/server'

let live: LiveServer | undefined

afterEach(async () => {
  await live?.close()
  live = undefined
})

async function start(configOverrides = {}): Promise<LiveServer> {
  live = await startServer({ client: fakeClient(textEvents('ok')) }, configOverrides)
  return live
}

describe('routes', () => {
  it('GET /health', async () => {
    const server = await start()
    const { status, body } = await getJson(server.url, '/health')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
  })

  it('HEAD / returns 200', async () => {
    const server = await start()
    const res = await fetch(`${server.url}/`, { method: 'HEAD' })
    expect(res.status).toBe(200)
  })

  it('GET /v1/models advertises claude and non-claude ids', async () => {
    const server = await start()
    const { status, body } = await getJson(server.url, '/v1/models')

    expect(status).toBe(200)
    const list = body as { object: string; data: { id: string }[] }
    expect(list.object).toBe('list')
    const ids = list.data.map((model) => model.id)
    for (const expected of ['claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-4.6', 'auto', 'minimax-m2.5', 'qwen3-coder-next']) {
      expect(ids).toContain(expected)
    }
  })

  it('advertises no duplicate model ids', async () => {
    const server = await start()
    const { body } = await getJson(server.url, '/v1/models')
    const ids = (body as { data: { id: string }[] }).data.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('accepts and discards client telemetry batches', async () => {
    const server = await start()
    for (const path of ['/api/event_logging/batch', '/api/event_logging/v2/batch']) {
      const { status, body } = await postJson(server.url, path, { events: [] })
      expect(status).toBe(200)
      expect(body).toEqual({ status: 'ok' })
    }
  })

  it('estimates tokens for count_tokens', async () => {
    const server = await start()
    const { status, body } = await postJson(server.url, '/v1/messages/count_tokens', {
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hello world' }],
    })
    expect(status).toBe(200)
    expect((body as { input_tokens: number }).input_tokens).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown path', async () => {
    const server = await start()
    const { status, body } = await getJson(server.url, '/nope')
    expect(status).toBe(404)
    expect((body as { error: { type: string } }).error.type).toBe('not_found_error')
  })

  it('distinguishes a wrong method from an unknown path', async () => {
    const server = await start()
    const { status } = await getJson(server.url, '/v1/messages')
    expect(status).toBe(405)
  })
})

describe('client authentication', () => {
  const apiKey = 'k'.repeat(32)

  it('rejects requests without the configured key', async () => {
    const server = await start({ server: { apiKey, host: '127.0.0.1', port: 0, maxBodyBytes: 1_048_576 } })
    const { status, body } = await getJson(server.url, '/v1/models')
    expect(status).toBe(401)
    expect((body as { error: { type: string } }).error.type).toBe('authentication_error')
  })

  it('accepts a Bearer token or x-api-key', async () => {
    const server = await start({ server: { apiKey, host: '127.0.0.1', port: 0, maxBodyBytes: 1_048_576 } })
    expect((await getJson(server.url, '/v1/models', { authorization: `Bearer ${apiKey}` })).status).toBe(200)
    expect((await getJson(server.url, '/v1/models', { 'x-api-key': apiKey })).status).toBe(200)
  })

  it('rejects a key of the right length but wrong value', async () => {
    const server = await start({ server: { apiKey, host: '127.0.0.1', port: 0, maxBodyBytes: 1_048_576 } })
    const { status } = await getJson(server.url, '/v1/models', { 'x-api-key': 'x'.repeat(32) })
    expect(status).toBe(401)
  })

  it('leaves health reachable without a key, for probes', async () => {
    const server = await start({ server: { apiKey, host: '127.0.0.1', port: 0, maxBodyBytes: 1_048_576 } })
    expect((await getJson(server.url, '/health')).status).toBe(200)
  })

  it('rejects weak keys and unauthenticated non-local binds at config time', () => {
    expect(() => assertSafeBind({ host: '127.0.0.1', apiKey: 'short' })).toThrow(/at least/u)
    expect(() => assertSafeBind({ host: '0.0.0.0', apiKey: undefined })).toThrow(/non-local/u)
    expect(() => assertSafeBind({ host: '0.0.0.0', apiKey: 'k'.repeat(16) })).not.toThrow()
    expect(() => assertSafeBind({ host: '127.0.0.1', apiKey: undefined })).not.toThrow()
  })
})

describe('body handling', () => {
  it('rejects a body above the configured limit with 413', async () => {
    const server = await start({ server: { host: '127.0.0.1', port: 0, apiKey: undefined, maxBodyBytes: 512 } })
    const { status, body } = await postJson(server.url, '/v1/messages', {
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    })
    expect(status).toBe(413)
    expect((body as { error: { type: string } }).error.type).toBe('invalid_request_error')
  })

  it('rejects invalid JSON with 400', async () => {
    const server = await start()
    const res = await fetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })
})

describe('CORS', () => {
  it('reflects a local origin', async () => {
    const server = await start()
    const res = await fetch(`${server.url}/health`, { headers: { origin: 'http://localhost:3000' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('ignores a remote origin', async () => {
    const server = await start()
    const res = await fetch(`${server.url}/health`, { headers: { origin: 'https://evil.example.com' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers preflight with 204', async () => {
    const server = await start()
    const res = await fetch(`${server.url}/v1/messages`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173' },
    })
    expect(res.status).toBe(204)
  })
})
