/**
 * Request telemetry.
 *
 * Kept separate from the transport so the request path contains no
 * summarization logic: previously ~120 lines of string building lived inside the
 * client module, and a 29-field interpolated log line was assembled on every
 * request. Field builders here are only invoked when debug logging is enabled.
 */

import type { KiroHistoryEntry, KiroImageBlock, KiroPayload, KiroToolResult } from '../domain/types'
import { isUserHistoryEntry } from '../domain/types'
import type { LogFields } from '../logging/logger'

export type ToolPairingRepairStats = { addedMissingResults: number; removedOrphanResults: number }

/** Wall-clock marks collected during one upstream request. */
export type RequestTimings = {
  startedAt: number
  sentAt: number
  firstEventAt: number
  firstTextAt: number
  firstToolUseAt: number
  doneAt: number
  endAt: number
}

export type StreamCounters = {
  events: number
  thinkBytes: number
  textBytes: number
  toolUses: number
  inputTokens: number
  outputTokens: number
}

export function newStreamCounters(): StreamCounters {
  return { events: 0, thinkBytes: 0, textBytes: 0, toolUses: 0, inputTokens: 0, outputTokens: 0 }
}

/** Structured description of an outbound payload, for debug logging. */
export function describePayload(payload: KiroPayload, bodyBytes: number, repairs?: ToolPairingRepairStats): LogFields {
  const current = payload.conversationState.currentMessage.userInputMessage
  const context = current.userInputMessageContext
  const tools = context?.tools ?? []
  const currentToolResults = context?.toolResults ?? []
  const currentImages = current.images ?? []
  const history = summarizeHistory(payload.conversationState.history)

  return {
    body_bytes: bodyBytes,
    model_id: current.modelId ?? '',
    history_len: payload.conversationState.history.length,
    current_content_bytes: Buffer.byteLength(current.content),
    tools: tools.length,
    tools_bytes: tools.reduce<number>((sum, tool) => sum + jsonBytes(tool), 0),
    top_tool_bytes: topToolBytes(tools),
    current_tool_results: currentToolResults.length,
    current_tool_result_bytes: toolResultTextBytes(currentToolResults),
    history_tool_result_bytes: history.toolResultBytes,
    current_images: currentImages.length,
    current_image_bytes: imageBytes(currentImages),
    history_images: history.images,
    history_image_bytes: history.imageBytes,
    repairs: repairs ? `missing:${repairs.addedMissingResults},orphan:${repairs.removedOrphanResults}` : undefined,
  }
}

/** Latency breakdown for one completed request. */
export function describeTimings(timings: RequestTimings, counters: StreamCounters, retries: number, retryWaitMs: number): LogFields {
  const { startedAt, sentAt, firstEventAt, firstTextAt, firstToolUseAt, doneAt, endAt } = timings
  return {
    before_send_ms: sentAt - startedAt,
    first_event_ms: (firstEventAt || endAt) - sentAt,
    first_text_ms: firstTextAt ? firstTextAt - sentAt : undefined,
    first_tool_use_ms: firstToolUseAt ? firstToolUseAt - sentAt : undefined,
    think_ms: firstTextAt && firstEventAt ? firstTextAt - firstEventAt : undefined,
    done_ms: doneAt ? doneAt - sentAt : undefined,
    stream_ms: firstEventAt ? endAt - firstEventAt : 0,
    tail_ms: doneAt ? endAt - doneAt : undefined,
    upstream_total_ms: endAt - sentAt,
    wall_ms: endAt - startedAt,
    events: counters.events,
    think_bytes: counters.thinkBytes,
    text_bytes: counters.textBytes,
    tool_uses: counters.toolUses,
    input_tokens: counters.inputTokens,
    output_tokens: counters.outputTokens,
    retries,
    retry_wait_ms: retryWaitMs,
  }
}

/** Compact per-turn view of the head and tail of history, for diagnosing shape bugs. */
export function describeHistoryShape(history: KiroHistoryEntry[]): LogFields {
  return {
    history_head: sliceShape(history, 0, Math.min(6, history.length)),
    history_tail: sliceShape(history, Math.max(0, history.length - 8), history.length),
  }
}

function summarizeHistory(history: KiroHistoryEntry[]): { toolResultBytes: number; images: number; imageBytes: number } {
  let toolResultBytes = 0
  let images = 0
  let imageByteTotal = 0
  for (const entry of history) {
    if (!isUserHistoryEntry(entry)) continue
    const toolResults = entry.userInputMessage.userInputMessageContext?.toolResults ?? []
    toolResultBytes += toolResultTextBytes(toolResults)
    const userImages = entry.userInputMessage.images ?? []
    images += userImages.length
    imageByteTotal += imageBytes(userImages)
  }
  return { toolResultBytes, images, imageBytes: imageByteTotal }
}

function sliceShape(history: KiroHistoryEntry[], start: number, end: number): string {
  const parts: string[] = []
  for (let i = start; i < end; i++) {
    const entry = history[i]!
    if (isUserHistoryEntry(entry)) {
      const user = entry.userInputMessage
      const toolResults = user.userInputMessageContext?.toolResults?.length ?? 0
      const images = user.images?.length ?? 0
      parts.push(`${i}:user(c=${Buffer.byteLength(user.content)},tr=${toolResults},img=${images})`)
      continue
    }
    const assistant = entry.assistantResponseMessage
    parts.push(`${i}:assistant(c=${Buffer.byteLength(assistant.content)},tu=${assistant.toolUses.length})`)
  }
  return parts.join(',')
}

function topToolBytes(tools: unknown[]): string {
  const ranked = tools
    .map((tool) => ({ name: toolName(tool), bytes: jsonBytes(tool) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
  return ranked.length ? ranked.map((tool) => `${tool.name}:${tool.bytes}`).join(',') : 'none'
}

function toolName(tool: unknown): string {
  if (!isRecord(tool)) return 'unknown'
  const spec = tool['toolSpecification'] ?? tool['ToolSpecification']
  if (isRecord(spec) && typeof spec['name'] === 'string') return spec['name']
  return 'unknown'
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return 0
  }
}

function toolResultTextBytes(results: KiroToolResult[]): number {
  let bytes = 0
  for (const result of results) {
    for (const block of result.content) bytes += Buffer.byteLength(block.text)
  }
  return bytes
}

function imageBytes(images: KiroImageBlock[]): number {
  let bytes = 0
  for (const image of images) bytes += Buffer.byteLength(image.source.bytes)
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
