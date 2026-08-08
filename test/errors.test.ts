/**
 * Error classification and the context-overflow signal.
 */

import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  InvalidRequestError,
  KiroLinkError,
  MalformedBodyError,
  NotFoundError,
  PayloadTooLargeError,
  RuntimeApiError,
  anthropicContextWindowErrorBody,
  describeRuntimeFailure,
  isContextWindowOverflow,
  openAIContextWindowErrorBody,
} from '../src/errors'

describe('error status mapping', () => {
  it.each([
    [new InvalidRequestError('bad'), 400, 'invalid_request_error'],
    [new MalformedBodyError(), 400, 'invalid_request_error'],
    [new PayloadTooLargeError(), 413, 'invalid_request_error'],
    [new AuthenticationError(), 401, 'authentication_error'],
    [new NotFoundError(), 404, 'not_found_error'],
  ])('maps %s', (error, status, type) => {
    expect(error.status).toBe(status)
    expect(error.apiErrorType).toBe(type)
  })

  it('is dispatched by type rather than by message text', () => {
    // The previous implementation compared error.message against string
    // literals, so rewording a message silently changed the HTTP status.
    const error = new PayloadTooLargeError('a completely different wording')
    expect(error.status).toBe(413)
    expect(error instanceof KiroLinkError).toBe(true)
  })
})

describe('RuntimeApiError', () => {
  it.each([
    [429, 429, 'rate_limit_error'],
    [400, 400, 'invalid_request_error'],
    [413, 413, 'invalid_request_error'],
    [500, 503, 'overloaded_error'],
    [503, 503, 'overloaded_error'],
    [418, 502, 'api_error'],
  ])('maps upstream %i to %i', (upstream, status, type) => {
    const error = new RuntimeApiError(upstream, 'body')
    expect(error.status).toBe(status)
    expect(error.apiErrorType).toBe(type)
  })

  it('keeps the upstream body out of the client message by default', () => {
    const error = new RuntimeApiError(500, 'internal stack trace with secrets')
    expect(error.message).toBe('Kiro runtime request failed with status 500')
    // The body is retained for local diagnostics, just not surfaced.
    expect(error.upstreamBody).toContain('secrets')
  })

  it('can summarize the upstream body for local debugging', () => {
    const error = new RuntimeApiError(
      400,
      JSON.stringify({ __type: 'ValidationException', message: 'bad field' }),
      { exposeUpstreamErrors: true },
    )
    expect(error.message).toContain('ValidationException')
    expect(error.message).toContain('bad field')
  })

  it('summarizes a non-JSON body without throwing', () => {
    const error = new RuntimeApiError(502, '<html>Bad Gateway</html>', { exposeUpstreamErrors: true })
    expect(error.message).toContain('Bad Gateway')
  })

  it('carries Retry-After when the upstream supplies one', () => {
    expect(new RuntimeApiError(429, '', { retryAfterSeconds: 12 }).retryAfterSeconds).toBe(12)
  })

  it('extracts safe upstream diagnostics without exposing the raw body', () => {
    const error = new RuntimeApiError(500, JSON.stringify({
      reason_code: 'ContextWindowOverflow',
      __type: 'ValidationException',
      message: 'Input is too large',
      request_echo: 'must not be logged',
    }), { upstreamRequestId: 'abc-123' })

    expect(describeRuntimeFailure(error)).toMatchObject({
      upstream_status: 500,
      upstream_request_id: 'abc-123',
      upstream_reason: 'ContextWindowOverflow',
      upstream_code: 'ValidationException',
      upstream_message: 'Input is too large',
    })
    expect(JSON.stringify(describeRuntimeFailure(error))).not.toContain('request_echo')
  })
})

describe('isContextWindowOverflow', () => {
  it('recognizes the gateway body-size rejection', () => {
    const error = new RuntimeApiError(400, JSON.stringify({
      reason: 'REQUEST_BODY_INVALID',
      message: 'Input content length exceeds threshold',
    }))
    expect(isContextWindowOverflow(error)).toBe(true)
  })

  it('recognizes a model-level overflow reason code', () => {
    expect(isContextWindowOverflow(new RuntimeApiError(400, JSON.stringify({ reason_code: 'ContextWindowOverflow' })))).toBe(true)
    expect(isContextWindowOverflow(new RuntimeApiError(413, JSON.stringify({ reasonCode: 'ContextWindowOverflow' })))).toBe(true)
  })

  it('recognizes overflow from the message alone', () => {
    for (const message of ['Input content length exceeds threshold', 'request exceeds the context window']) {
      expect(isContextWindowOverflow(new RuntimeApiError(400, JSON.stringify({ message })))).toBe(true)
    }
  })

  it('does not misclassify an unrelated validation failure', () => {
    const error = new RuntimeApiError(400, JSON.stringify({ reason: 'INVALID_MODEL', message: 'Invalid model ID' }))
    expect(isContextWindowOverflow(error)).toBe(false)
  })

  it('recognizes an explicit overflow even when Kiro reports it as a 5xx', () => {
    expect(isContextWindowOverflow(new RuntimeApiError(500, JSON.stringify({ reason: 'REQUEST_BODY_INVALID' })))).toBe(true)
    expect(isContextWindowOverflow(new RuntimeApiError(503, JSON.stringify({ reason_code: 'ContextWindowOverflow' })))).toBe(true)
  })

  it('does not treat an unrelated 5xx as an overflow', () => {
    expect(isContextWindowOverflow(new RuntimeApiError(500, JSON.stringify({ reason: 'InternalError' })))).toBe(false)
  })

  it('tolerates a non-JSON body', () => {
    expect(() => isContextWindowOverflow(new RuntimeApiError(400, 'plain text'))).not.toThrow()
    expect(isContextWindowOverflow(new RuntimeApiError(400, 'plain text'))).toBe(false)
  })
})

describe('context window error bodies', () => {
  it('builds the Anthropic envelope clients recognize for compaction', () => {
    const body = anthropicContextWindowErrorBody('req_123')
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toContain('maximum context length')
    expect(body.request_id).toBe('req_123')
  })

  it('builds the OpenAI envelope with the standard code', () => {
    const body = openAIContextWindowErrorBody()
    expect(body.error.code).toBe('context_length_exceeded')
    expect(body.error.param).toBe('messages')
  })
})
