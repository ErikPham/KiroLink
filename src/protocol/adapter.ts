/**
 * Protocol adapter contract.
 *
 * Each client protocol (Anthropic Messages, OpenAI Chat Completions) supplies
 * one adapter. Previously both protocols were implemented as parallel copies:
 * two ~90-line translator functions with the same structure, and two ~60-line
 * server handlers each containing a streaming and a buffered branch over the
 * same four event types — four near-identical switch blocks that had to be kept
 * in sync by hand. Adding a third protocol meant a third copy of all of it.
 *
 * An adapter now owns three things: which routes it serves, how to turn a
 * request into a KiroRequest, and how to render the resulting event stream back
 * to the client. The router and the event pump are shared.
 */

import type { ServerResponse } from 'node:http'
import type { KiroRequest, KiroStreamEvent } from '../domain/types'

/**
 * Renders a Kiro event stream into one client protocol.
 *
 * The pump calls `begin` immediately before the first event (or before a
 * successful empty response), `handle` for each event, and exactly one of
 * `complete`/`fail`. Deferring `begin` lets a pre-stream upstream rejection
 * retain its real HTTP error status, including the client compaction signal.
 */
export type ResponseWriter = {
  /** Send response headers. Called before any event is handled. */
  begin(): void
  handle(event: KiroStreamEvent): void
  /** Flush the final response. */
  complete(): void
  /**
   * Report a failure after response headers have been committed, so the writer
   * must deliver it inside the already-open response. Failures before that are
   * rendered by the server instead.
   */
  fail(error: unknown): void
  /** Resolve once everything queued has reached the socket. */
  finish(): Promise<void>
}

export type ProtocolAdapter<TRequest> = {
  /** Stable adapter id, used in logs. */
  readonly name: string
  /** Validate and narrow a parsed request body. Throws InvalidRequestError. */
  parseRequest(body: unknown): TRequest
  /** Translate a validated request into the upstream payload. */
  toKiroRequest(request: TRequest): KiroRequest
  /** Create the writer that renders events back to this client. */
  createWriter(res: ServerResponse, request: TRequest): ResponseWriter
  /** Build the protocol's error body for a context-window overflow. */
  contextWindowErrorBody(): unknown
  /** Short description of the request, for the request log. */
  describeRequest(request: TRequest): string
  /** Fields the dashboard and status endpoint report for this request. */
  metricsFor(request: TRequest): { model: string; stream: boolean }
}
