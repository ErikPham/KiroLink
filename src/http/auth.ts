/**
 * Client authentication and CORS.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLocalHost } from '../config/config'

/**
 * Compare a presented key against the configured one in constant time.
 *
 * A plain `===` leaks the length of the matching prefix through timing. The risk
 * is modest for a local proxy, but the key is only required when binding
 * non-locally — precisely the exposed case.
 */
function secureEquals(a: string | undefined, b: string): boolean {
  if (a === undefined) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, so compare lengths first. Length
  // is not secret: it is a property of the configured key, not of the guess.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function isAuthorized(req: IncomingMessage, apiKey: string): boolean {
  const authorization = firstHeader(req.headers['authorization'])
  if (authorization !== undefined && secureEquals(authorization, `Bearer ${apiKey}`)) return true
  return secureEquals(firstHeader(req.headers['x-api-key']), apiKey)
}

/**
 * Allow cross-origin requests only from local origins, and only when the proxy
 * itself is bound locally: a browser page on the internet must not be able to
 * drive a proxy holding the user's Kiro credentials.
 */
export function setCorsHeaders(req: IncomingMessage, res: ServerResponse, host: string): void {
  const origin = firstHeader(req.headers.origin)
  if (!origin) return
  if (!isLocalHost(host) || !isLocalOrigin(origin)) return

  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key')
}

function isLocalOrigin(origin: string): boolean {
  try {
    return isLocalHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
