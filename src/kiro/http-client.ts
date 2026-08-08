/**
 * HTTP transport for GenerateAssistantResponse.
 *
 * Responsibilities are limited to issuing the request, applying retry policy,
 * and delegating the response body to the stream parser. Payload truncation and
 * tool-result pairing now belong to the protocol layer (which owns the semantics
 * and can report problems to the client), and telemetry formatting lives in
 * telemetry.ts.
 */

import { writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientIdentityConfig, DiagnosticsConfig, UpstreamConfig } from '../config/config'
import { MAX_ERROR_BODY_BYTES } from '../domain/limits'
import type { KiroRequest, KiroStreamEvent } from '../domain/types'
import { RequestAbortedError, RuntimeApiError, describeRuntimeFailure } from '../errors'
import type { Logger } from '../logging/logger'
import type { AuthProvider } from './auth'
import { buildAuthHeaders, resolveProfileArn, amzUserAgent, userAgent } from './auth'
import type { KiroClient } from './client'
import { resolveKiroApiUrl } from './endpoint'
import { parseEventStream } from './stream'
import {
  describeHistoryShape,
  describePayload,
  describeTimings,
  newStreamCounters,
  type RequestTimings,
} from './telemetry'

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1000
const MAX_RETRY_AFTER_MS = 60_000

export type HttpKiroClientDeps = {
  upstream: UpstreamConfig
  identity: ClientIdentityConfig
  diagnostics: DiagnosticsConfig
  auth: AuthProvider
  logger: Logger
}

export function createHttpKiroClient(deps: HttpKiroClientDeps): KiroClient {
  const { upstream, identity, diagnostics, auth, logger } = deps
  let requestSeq = 0

  return {
    async send(kiroRequest: KiroRequest, onEvent: (event: KiroStreamEvent) => void, signal?: AbortSignal): Promise<void> {
      const rid = ++requestSeq
      const startedAt = Date.now()
      const { payload, toolNameMap } = kiroRequest
      const emit = wrapToolNames(onEvent, toolNameMap)

      let retries = 0
      let retryWaitMs = 0

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (signal?.aborted) throw new RequestAbortedError()

        const credential = await auth.load()
        const profileArn = resolveProfileArn(credential)
        // profileArn is auth-derived, so it is applied per attempt: a refresh
        // between attempts can change it.
        const body = serializePayload(payload, profileArn)

        logger.lazyDebug(() => ({
          message: 'runtime request',
          fields: { rid, auth_mode: credential.mode, attempt, ...describePayload(payload, Buffer.byteLength(body)) },
        }))

        const response = await sendRequest({
          body,
          headers: {
            'Content-Type': 'application/x-amz-json-1.0',
            'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
            'Content-Length': String(Buffer.byteLength(body)),
            ...buildAuthHeaders(credential),
            'User-Agent': userAgent(identity),
            'x-amz-user-agent': amzUserAgent(identity),
            'x-amzn-codewhisperer-optout': identity.codeWhispererOptOut,
            'Amz-Sdk-Invocation-Id': crypto.randomUUID(),
            'Amz-Sdk-Request': `attempt=${attempt + 1}; max=${MAX_RETRIES + 1}`,
            Accept: '*/*',
          },
          upstream,
          signal,
        })

        const sentAt = response.sentAt
        const status = response.message.statusCode ?? 0
        logger.lazyDebug(() => ({
          message: 'runtime headers',
          fields: { rid, status, after_ms: Date.now() - sentAt },
        }))

        if (status === 429 && attempt < MAX_RETRIES) {
          await drain(response.message)
          const delay = parseRetryAfterMs(response.message.headers['retry-after']) ?? RETRY_DELAY_MS * (attempt + 1)
          retries++
          retryWaitMs += delay
          logger.log('debug', 'rate limited, backing off', { rid, delay_ms: delay })
          await sleep(delay, signal)
          continue
        }

        // OAuth access tokens can expire mid-flight; force a refresh once.
        // API keys have no refresh path, so a 403 is permanent for that credential.
        if (status === 403 && attempt === 0 && credential.mode === 'oauth') {
          await drain(response.message)
          auth.invalidate()
          retries++
          logger.log('debug', 'forbidden, forcing token refresh', { rid })
          await auth.refresh()
          continue
        }

        if (status !== 200) {
          const errorBody = await readTextCapped(response.message, MAX_ERROR_BODY_BYTES)
          const error = new RuntimeApiError(status, errorBody, {
            retryAfterSeconds: retryAfterSeconds(response.message.headers['retry-after']),
            exposeUpstreamErrors: diagnostics.exposeUpstreamErrors,
            upstreamRequestId: upstreamRequestId(response.message.headers),
          })
          // Keep enough metadata in normal logs to identify the rejection
          // without dumping request content or an arbitrary upstream body.
          // The full capped body remains available under --verbose.
          logger.log('warn', 'runtime request rejected', {
            rid,
            attempt: attempt + 1,
            auth_mode: credential.mode,
            ...describeRuntimeFailure(error),
            ...describePayload(payload, Buffer.byteLength(body)),
            ...describeHistoryShape(payload.conversationState.history),
          })
          logger.lazyDebug(() => ({
            message: 'runtime request failed',
            fields: {
              rid,
              status,
              upstream_body: errorBody,
              ...describePayload(payload, Buffer.byteLength(body)),
              ...describeHistoryShape(payload.conversationState.history),
            },
          }))
          if (diagnostics.dumpFailedPayload) {
            await dumpPayload(payload, diagnostics.dumpFailedPayloadPath, logger)
          }
          throw error
        }

        const timings: RequestTimings = {
          startedAt, sentAt, firstEventAt: 0, firstTextAt: 0, firstToolUseAt: 0, doneAt: 0, endAt: 0,
        }
        const counters = newStreamCounters()

        await parseEventStream(response.message, (event) => {
          recordEvent(event, timings, counters)
          emit(event)
        }, logger)

        timings.endAt = Date.now()
        logger.lazyDebug(() => ({
          message: 'runtime timing',
          fields: { rid, ...describeTimings(timings, counters, retries, retryWaitMs) },
        }))
        return
      }

      throw new Error('Max retries exceeded')
    },
  }
}

/**
 * Restore the client's original tool names on the way out. Tool names are
 * sanitized before being sent upstream (Kiro rejects some characters), and the
 * client only recognizes the names it supplied.
 */
function wrapToolNames(
  onEvent: (event: KiroStreamEvent) => void,
  toolNameMap: ReadonlyMap<string, string>,
): (event: KiroStreamEvent) => void {
  if (toolNameMap.size === 0) return onEvent
  return (event) => {
    if (event.type === 'tool_use') {
      const original = toolNameMap.get(event.toolUse.name)
      if (original) {
        onEvent({ ...event, toolUse: { ...event.toolUse, name: original } })
        return
      }
    }
    onEvent(event)
  }
}

/** Serialize without mutating the payload; omit profileArn when absent. */
function serializePayload(payload: KiroRequest['payload'], profileArn: string | undefined): string {
  return JSON.stringify(profileArn ? { ...payload, profileArn } : { ...payload, profileArn: undefined })
}

function recordEvent(event: KiroStreamEvent, timings: RequestTimings, counters: ReturnType<typeof newStreamCounters>): void {
  const now = Date.now()
  timings.firstEventAt ||= now
  counters.events++
  switch (event.type) {
    case 'thinking':
      counters.thinkBytes += Buffer.byteLength(event.text)
      break
    case 'text':
      counters.textBytes += Buffer.byteLength(event.text)
      timings.firstTextAt ||= now
      break
    case 'tool_use':
      counters.toolUses++
      timings.firstToolUseAt ||= now
      break
    case 'done':
      timings.doneAt = now
      counters.inputTokens = event.inputTokens
      counters.outputTokens = event.outputTokens
      break
  }
}

function sendRequest(options: {
  body: string
  headers: Record<string, string>
  upstream: UpstreamConfig
  signal: AbortSignal | undefined
}): Promise<{ message: IncomingMessage; sentAt: number }> {
  const { body, headers, upstream, signal } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError())
      return
    }
    const url = resolveKiroApiUrl(upstream)
    let sentAt = 0
    const req = request({
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
    }, (message) => { resolve({ message, sentAt }) })

    req.on('error', reject)
    req.setTimeout(upstream.requestTimeoutMs, () => {
      req.destroy(new Error(`Kiro API request timed out after ${upstream.requestTimeoutMs}ms`))
    })

    const onAbort = (): void => { req.destroy(new RequestAbortedError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => { signal?.removeEventListener('abort', onAbort) })

    sentAt = Date.now()
    req.end(body)
  })
}

async function dumpPayload(payload: unknown, path: string | undefined, logger: Logger): Promise<void> {
  const target = path ?? join(tmpdir(), 'kiro-failed-payload.json')
  try {
    await writeFile(target, JSON.stringify(payload, null, 2), { mode: 0o600 })
    logger.log('debug', 'wrote failed payload', { path: target })
  } catch (error) {
    logger.log('warn', `could not write failed payload: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RequestAbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryAfterSeconds(header: string | string[] | undefined): number | undefined {
  const ms = parseRetryAfterMs(header)
  return ms === undefined ? undefined : Math.ceil(ms / 1000)
}

function upstreamRequestId(headers: IncomingMessage['headers']): string | undefined {
  const value = headers['x-amzn-requestid'] ?? headers['x-amzn-request-id'] ?? headers['x-request-id']
  return Array.isArray(value) ? value[0] : value
}

/** Retry-After is either a delta in seconds or an HTTP date; both are capped. */
export function parseRetryAfterMs(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return undefined

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)

  const dateMs = Date.parse(raw)
  if (Number.isNaN(dateMs)) return undefined
  return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS)
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  // Read to completion so the socket can be reused.
  for await (const chunk of stream) {
    void chunk
  }
}

async function readTextCapped(stream: AsyncIterable<Buffer | string>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size <= maxBytes) {
      chunks.push(buf)
    } else if (!truncated) {
      const remaining = maxBytes - (size - buf.length)
      if (remaining > 0) chunks.push(buf.subarray(0, remaining))
      truncated = true
    }
  }
  return Buffer.concat(chunks).toString() + (truncated ? '...[truncated]' : '')
}
