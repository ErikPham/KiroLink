export class InvalidRequestError extends Error {
  override name = 'InvalidRequestError'
}

export class RuntimeApiError extends Error {
  override name = 'RuntimeApiError'

  constructor(
    public readonly statusCode: number,
    public readonly upstreamBody: string,
    public readonly retryAfterSeconds: number | undefined = undefined,
  ) {
    super(formatRuntimeApiError(statusCode, upstreamBody))
  }
}

function formatRuntimeApiError(statusCode: number, upstreamBody: string): string {
  if (process.env['KIRO_PROXY_EXPOSE_UPSTREAM_ERRORS'] !== '1') {
    return `Kiro runtime request failed with status ${statusCode}`
  }
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
  } catch {}

  return truncate(trimmed.replace(/\s+/gu, ' '))
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value
}
