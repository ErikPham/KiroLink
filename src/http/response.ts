/**
 * HTTP response helpers.
 *
 * SSE writes respect backpressure: `res.write` returning false means the socket
 * buffer is full, and ignoring it lets a slow client cause unbounded memory
 * growth while a fast upstream streams. Writers await `drain` before continuing.
 */

import type { ServerResponse } from 'node:http'

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  // Defeat proxy buffering, which would otherwise defeat streaming entirely.
  'x-accel-buffering': 'no',
} as const

export function writeJson(res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(data))
}

export function beginSse(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS)
}

/**
 * A serialized SSE writer.
 *
 * Events are chained onto a single promise so that ordering is preserved even
 * though each write may need to await drain. Callers stay synchronous; they
 * await `flush()` once at the end.
 */
export class SseStream {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly res: ServerResponse) {}

  /** Queue a named SSE event. */
  event(event: string, data: unknown): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /** Queue a bare `data:` frame, as OpenAI's protocol uses. */
  data(data: unknown): void {
    this.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  /** Queue a raw line, for sentinels such as `data: [DONE]`. */
  raw(chunk: string): void {
    this.write(chunk)
  }

  /** Queue a comment frame, used as a keepalive. */
  comment(text = ''): void {
    this.write(`: ${text}\n\n`)
  }

  /** Resolve once every queued write has been flushed to the socket. */
  flush(): Promise<void> {
    return this.tail
  }

  private write(chunk: string): void {
    this.tail = this.tail.then(() => this.writeChunk(chunk))
  }

  private writeChunk(chunk: string): Promise<void> {
    if (this.res.writableEnded || this.res.destroyed) return Promise.resolve()
    if (this.res.write(chunk)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.res.off('drain', done)
        this.res.off('close', done)
        resolve()
      }
      this.res.once('drain', done)
      this.res.once('close', done)
    })
  }
}

/**
 * Send a periodic SSE comment so intermediaries do not close an idle
 * connection during a long thinking phase. Returns a stop function.
 */
export function startKeepalive(stream: SseStream, intervalMs: number): () => void {
  const timer = setInterval(() => { stream.comment('keepalive') }, intervalMs)
  timer.unref()
  return () => { clearInterval(timer) }
}
