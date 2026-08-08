/**
 * Request body reading.
 */

import type { IncomingMessage } from 'node:http'
import { MalformedBodyError, PayloadTooLargeError } from '../errors'

/** Read the body, enforcing the byte cap as chunks arrive. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buf.length
    // Fail as soon as the cap is exceeded rather than buffering the whole body.
    if (size > maxBytes) throw new PayloadTooLargeError()
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = await readBody(req, maxBytes)
  try {
    return JSON.parse(raw.toString()) as unknown
  } catch {
    throw new MalformedBodyError()
  }
}

/** Consume and discard a body, still enforcing the cap. */
export async function drainBody(req: IncomingMessage, maxBytes: number): Promise<void> {
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buf.length
    if (size > maxBytes) throw new PayloadTooLargeError()
  }
}
