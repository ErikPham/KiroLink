/**
 * Error hierarchy.
 *
 * Each error carries its own HTTP status and API error type, so the server maps
 * failures with a single lookup instead of the previous arrangement where two
 * functions compared `error.message` against string literals duplicated from
 * the throw sites — a rewording of any message would silently change the
 * response status to 500.
 */

export type ApiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error'

/** Base class for every failure KiroLink maps to a deliberate HTTP response. */
export abstract class KiroLinkError extends Error {
  abstract readonly status: number
  abstract readonly apiErrorType: ApiErrorType
  /** Value for a Retry-After header, when the upstream supplied one. */
  readonly retryAfterSeconds: number | undefined = undefined
}

/** The client's request is malformed or violates a documented limit. */
export class InvalidRequestError extends KiroLinkError {
  override readonly name = 'InvalidRequestError'
  override readonly status = 400
  override readonly apiErrorType: ApiErrorType = 'invalid_request_error'
}

/** The request body is not valid JSON. */
export class MalformedBodyError extends KiroLinkError {
  override readonly name = 'MalformedBodyError'
  override readonly status = 400
  override readonly apiErrorType: ApiErrorType = 'invalid_request_error'

  constructor(message = 'Invalid JSON request body') {
    super(message)
  }
}

/** The request body exceeded `server.maxBodyBytes`. */
export class PayloadTooLargeError extends KiroLinkError {
  override readonly name = 'PayloadTooLargeError'
  override readonly status = 413
  override readonly apiErrorType: ApiErrorType = 'invalid_request_error'

  constructor(message = 'Request body is too large') {
    super(message)
  }
}

/** The client failed the proxy's own API-key check. */
export class AuthenticationError extends KiroLinkError {
  override readonly name = 'AuthenticationError'
  override readonly status = 401
  override readonly apiErrorType: ApiErrorType = 'authentication_error'

  constructor(message = 'Unauthorized') {
    super(message)
  }
}

export class NotFoundError extends KiroLinkError {
  override readonly name = 'NotFoundError'
  override readonly status = 404
  override readonly apiErrorType: ApiErrorType = 'not_found_error'

  constructor(message = 'Not found') {
    super(message)
  }
}

/** The client disconnected or the request was aborted. */
export class RequestAbortedError extends KiroLinkError {
  override readonly name = 'RequestAbortedError'
  override readonly status = 499
  override readonly apiErrorType: ApiErrorType = 'api_error'

  constructor(message = 'Request aborted') {
    super(message)
  }
}

/** The Kiro runtime returned a non-200 response. */
export class RuntimeApiError extends KiroLinkError {
  override readonly name = 'RuntimeApiError'
  override readonly apiErrorType: ApiErrorType
  override readonly status: number
  override readonly retryAfterSeconds: number | undefined

  constructor(
    public readonly statusCode: number,
    public readonly upstreamBody: string,
    options: { retryAfterSeconds?: number | undefined; exposeUpstreamErrors?: boolean; upstreamRequestId?: string | undefined } = {},
  ) {
    super(formatRuntimeApiError(statusCode, upstreamBody, options.exposeUpstreamErrors ?? false))
    this.retryAfterSeconds = options.retryAfterSeconds
    this.upstreamRequestId = options.upstreamRequestId
    this.status = mapUpstreamStatus(statusCode)
    this.apiErrorType = mapUpstreamErrorType(statusCode)
  }

  /** Correlates a runtime rejection with Kiro/AWS support logs when supplied. */
  readonly upstreamRequestId: string | undefined
}

/**
 * Translate an upstream status into the status KiroLink returns.
 * 5xx becomes 503 (transient, retryable by the client); anything unrecognized
 * becomes 502 because the failure is upstream, not in the client's request.
 */
function mapUpstreamStatus(statusCode: number): number {
  if (statusCode === 429) return 429
  if (statusCode === 400 || statusCode === 413) return statusCode
  if (statusCode >= 500 && statusCode <= 599) return 503
  return 502
}

function mapUpstreamErrorType(statusCode: number): ApiErrorType {
  if (statusCode === 429) return 'rate_limit_error'
  if (statusCode === 400 || statusCode === 413) return 'invalid_request_error'
  if (statusCode >= 500 && statusCode <= 599) return 'overloaded_error'
  return 'api_error'
}

export const CONTEXT_LENGTH_EXCEEDED_CODE = 'context_length_exceeded'

/**
 * Safe, compact diagnostics for an upstream rejection. This deliberately
 * extracts only conventional error metadata; the raw body remains debug-only
 * because it can contain request-derived text.
 */
export function describeRuntimeFailure(error: RuntimeApiError): Record<string, string | number | undefined> {
  const parsed = parseJsonObject(error.upstreamBody)
  const reason = parsed && (readString(parsed, 'reason') ?? readString(parsed, 'reason_code') ?? readString(parsed, 'reasonCode'))
  const code = parsed && (readString(parsed, 'code') ?? readString(parsed, 'errorCode') ?? readString(parsed, '__type') ?? readString(parsed, 'type'))
  const message = parsed && (readString(parsed, 'message') ?? readString(parsed, 'Message'))

  return {
    upstream_status: error.statusCode,
    upstream_request_id: error.upstreamRequestId,
    upstream_reason: reason ? truncateLogValue(reason, 160) : undefined,
    upstream_code: code ? truncateLogValue(code, 160) : undefined,
    upstream_message: message ? truncateLogValue(message, 500) : undefined,
    // A plain-text gateway error has no structured fields, but its short
    // summary is still useful without promoting the whole body to normal logs.
    upstream_detail: parsed ? undefined : truncateLogValue(summarizeUpstreamBody(error.upstreamBody), 500) || undefined,
  }
}

/**
 * Kiro's runtime reports two distinct overflow conditions that both surface as
 * HTTP 400/413, and both mean "the client's history is too large for the model
 * to accept as-is": a request-body-size validation failure at the gateway
 * (reason REQUEST_BODY_INVALID, e.g. "Input content length exceeds threshold"),
 * and a model-level context-window overflow (reason_code ContextWindowOverflow).
 *
 * KiroLink does not compact conversation history itself — it forwards the
 * client's history as given, the way Kiro CLI forwards its own — so when Kiro
 * reports either condition, the signal must reach Claude Code / Codex in the
 * exact shape their own reactive compaction already knows how to recognize,
 * rather than being surfaced as a generic upstream failure.
 */
export function isContextWindowOverflow(error: RuntimeApiError): boolean {
  const parsed = parseJsonObject(error.upstreamBody)
  if (!parsed) return false
  const reason = readString(parsed, 'reason') ?? readString(parsed, 'reason_code') ?? readString(parsed, 'reasonCode')
  if (reason === 'REQUEST_BODY_INVALID' || reason === 'ContextWindowOverflow') return true
  const message = readString(parsed, 'message') ?? readString(parsed, 'Message') ?? ''
  return /content length exceeds threshold|exceeds the context window|context window overflow/iu.test(message)
}

/** Anthropic's canonical invalid_request_error body for an oversized request. */
export function anthropicContextWindowErrorBody(requestId: string): {
  type: 'error'
  error: { type: 'invalid_request_error'; message: string }
  request_id: string
} {
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: "Your input exceeds this model's maximum context length. Please reduce the length of the messages or use /compact.",
    },
    request_id: requestId,
  }
}

/** OpenAI's canonical invalid_request_error body for an oversized request. */
export function openAIContextWindowErrorBody(): {
  error: { message: string; type: string; param: string; code: string }
} {
  return {
    error: {
      message: "This model's maximum context length has been exceeded. Please reduce the length of the messages.",
      type: 'invalid_request_error',
      param: 'messages',
      code: CONTEXT_LENGTH_EXCEEDED_CODE,
    },
  }
}

function formatRuntimeApiError(statusCode: number, upstreamBody: string, expose: boolean): string {
  if (!expose) return `Kiro runtime request failed with status ${statusCode}`
  const detail = summarizeUpstreamBody(upstreamBody)
  return detail
    ? `Kiro runtime request failed with status ${statusCode}: ${detail}`
    : `Kiro runtime request failed with status ${statusCode}`
}

function summarizeUpstreamBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const message = readString(record, 'message') ?? readString(record, 'Message')
      const code = readString(record, 'code') ?? readString(record, '__type') ?? readString(record, 'type')
      const pieces = [code, message].filter(Boolean)
      if (pieces.length) return truncate(pieces.join(' '))
    }
  } catch {
    // Not JSON — fall through to the raw-text summary.
  }

  return truncate(trimmed.replace(/\s+/gu, ' '))
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value
}

function truncateLogValue(value: string, maxLength: number): string {
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized
}
