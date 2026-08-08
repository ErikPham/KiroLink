/**
 * Live-server harness: starts a real HTTP server with injected fakes on an
 * ephemeral port, so tests exercise real socket behavior without a real upstream.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createKiroLink, type KiroLinkOverrides } from '../../src/app'
import type { KiroLinkConfig } from '../../src/config/config'
import { fakeAuth, fakeUsage, okUsage, silentLogger, testConfig } from './harness'

export type LiveServer = {
  url: string
  server: Server
  close(): Promise<void>
}

export async function startServer(
  overrides: KiroLinkOverrides,
  configOverrides: Partial<KiroLinkConfig> = {},
): Promise<LiveServer> {
  const config = testConfig(configOverrides)
  const app = createKiroLink(config, {
    logger: silentLogger,
    auth: fakeAuth(),
    usage: fakeUsage(okUsage()),
    version: '1.0.0-test',
    ...overrides,
  })

  // Port 0 lets the OS pick a free port, so tests never collide.
  await new Promise<void>((resolve) => { app.server.listen(0, '127.0.0.1', resolve) })
  const { port } = app.server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    server: app.server,
    close: () => new Promise<void>((resolve) => { app.server.close(() => resolve()) }),
  }
}

export type JsonResponse = { status: number; body: unknown; headers: Headers }

export async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await readBody(res), headers: res.headers }
}

export async function getJson(base: string, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`, { headers })
  return { status: res.status, body: await readBody(res), headers: res.headers }
}

/** Read an SSE response as raw text. */
export async function postSse(base: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

/** Parse an SSE body into ordered `event`/`data` pairs. */
export function parseSse(text: string): { event: string | undefined; data: unknown }[] {
  const out: { event: string | undefined; data: unknown }[] = []
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim()
    if (!trimmed || trimmed.startsWith(':')) continue
    let event: string | undefined
    let raw: string | undefined
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) raw = line.slice(6)
    }
    if (raw === undefined) continue
    if (raw === '[DONE]') {
      out.push({ event, data: '[DONE]' })
      continue
    }
    try {
      out.push({ event, data: JSON.parse(raw) as unknown })
    } catch {
      out.push({ event, data: raw })
    }
  }
  return out
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
