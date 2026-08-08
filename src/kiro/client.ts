/**
 * The upstream seam.
 *
 * `KiroClient` is the interface the server depends on; `HttpKiroClient` is the
 * real implementation. Previously the server imported `callKiroApi` as a direct
 * module binding, which meant the entire chat path — SSE framing, error mapping,
 * abort propagation, context-overflow translation — could not be tested at all.
 * Tests now supply a fake client.
 */

import type { KiroRequest, KiroStreamEvent } from '../domain/types'

export type KiroClient = {
  /**
   * Send a translated request, invoking `onEvent` for each normalized stream
   * event. Resolves once the upstream stream completes, after a final
   * `{ type: 'done' }` event.
   */
  send(request: KiroRequest, onEvent: (event: KiroStreamEvent) => void, signal?: AbortSignal): Promise<void>
}
