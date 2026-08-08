/**
 * Anthropic response writers.
 *
 * Two implementations of one interface, replacing the previous pair of inline
 * switch blocks in the server: a streaming writer that maintains Anthropic's
 * content-block state machine, and a buffered writer that accumulates the same
 * events into a single JSON response.
 */

import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { KiroStreamEvent, KiroToolUse } from '../../domain/types'
import { anthropicContextWindowErrorBody, RuntimeApiError, isContextWindowOverflow } from '../../errors'
import { beginSse, SseStream, startKeepalive, writeJson } from '../../http/response'
import type { ResponseWriter } from '../adapter'
import { buildAnthropicResponse, type AnthropicContentBlock } from './types'

/** Interval for SSE comment frames during a long thinking phase. */
const KEEPALIVE_INTERVAL_MS = 15_000

function newMessageId(): string {
  return `msg_${randomUUID().replace(/-/gu, '')}`
}

/**
 * Streaming writer.
 *
 * Anthropic's protocol allows only one open content block at a time, and each
 * must be closed with content_block_stop before the next starts. Centralizing
 * those transitions here keeps every event-handling site from re-deriving them.
 */
export class AnthropicStreamWriter implements ResponseWriter {
  private readonly stream: SseStream
  private readonly messageId = newMessageId()
  private stopKeepalive: (() => void) | undefined
  private blockIndex = 0
  private openBlock: 'text' | 'thinking' | null = null
  private hasToolUse = false
  private outputTokens = 0

  constructor(private readonly res: ServerResponse, private readonly model: string) {
    this.stream = new SseStream(res)
  }

  begin(): void {
    beginSse(this.res)
    this.stream.event('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    this.stopKeepalive = startKeepalive(this.stream, KEEPALIVE_INTERVAL_MS)
  }

  handle(event: KiroStreamEvent): void {
    switch (event.type) {
      case 'text':
        this.delta('text', { type: 'text_delta', text: event.text })
        break
      case 'thinking':
        this.delta('thinking', { type: 'thinking_delta', thinking: event.text })
        break
      case 'tool_use':
        this.toolUse(event.toolUse)
        break
      case 'done':
        this.outputTokens = event.outputTokens
        break
    }
  }

  complete(): void {
    this.stopKeepalive?.()
    this.closeOpenBlock()
    this.stream.event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    })
    this.stream.event('message_stop', { type: 'message_stop' })
  }

  fail(error: unknown): void {
    this.stopKeepalive?.()
    const body = error instanceof RuntimeApiError && isContextWindowOverflow(error)
      ? anthropicContextWindowErrorBody(`req_${randomUUID()}`)
      : { type: 'error', error: { type: 'api_error', message: error instanceof Error ? error.message : String(error) } }
    this.stream.event('error', body)
  }

  finish(): Promise<void> {
    return this.stream.flush()
  }

  private delta(kind: 'text' | 'thinking', delta: unknown): void {
    if (this.openBlock && this.openBlock !== kind) this.closeOpenBlock()
    if (this.openBlock !== kind) {
      this.startBlock(kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' })
      this.openBlock = kind
    }
    this.stream.event('content_block_delta', { type: 'content_block_delta', index: this.blockIndex, delta })
  }

  private toolUse(toolUse: KiroToolUse): void {
    this.closeOpenBlock()
    this.hasToolUse = true
    this.startBlock({ type: 'tool_use', id: toolUse.toolUseId, name: toolUse.name, input: {} })
    // The upstream delivers tool input as one complete object, so it is emitted
    // as a single input_json_delta rather than incremental fragments.
    this.stream.event('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) },
    })
    this.closeBlock()
  }

  private startBlock(contentBlock: unknown): void {
    this.stream.event('content_block_start', { type: 'content_block_start', index: this.blockIndex, content_block: contentBlock })
  }

  private closeOpenBlock(): void {
    if (!this.openBlock) return
    this.closeBlock()
  }

  private closeBlock(): void {
    this.stream.event('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
    this.blockIndex++
    this.openBlock = null
  }
}

/** Buffered writer: accumulates the stream into one JSON message. */
export class AnthropicJsonWriter implements ResponseWriter {
  private readonly blocks: AnthropicContentBlock[] = []
  private thinkingBuffer = ''
  private textBuffer = ''
  private inputTokens = 0
  private outputTokens = 0

  constructor(private readonly res: ServerResponse, private readonly model: string) {}

  begin(): void {
    // Headers are written with the body once the full response is known.
  }

  handle(event: KiroStreamEvent): void {
    switch (event.type) {
      case 'text':
        this.textBuffer += event.text
        break
      case 'thinking':
        this.thinkingBuffer += event.text
        break
      case 'tool_use':
        // Flush pending text first so block order matches the stream order.
        this.flushText()
        this.blocks.push({
          type: 'tool_use',
          id: event.toolUse.toolUseId,
          name: event.toolUse.name,
          input: event.toolUse.input,
        })
        break
      case 'done':
        this.inputTokens = event.inputTokens
        this.outputTokens = event.outputTokens
        break
    }
  }

  complete(): void {
    // Thinking precedes all visible output, matching Anthropic's own ordering.
    if (this.thinkingBuffer) this.blocks.unshift({ type: 'thinking', thinking: this.thinkingBuffer })
    this.flushText()
    // Clients require at least one block.
    if (!this.blocks.length) this.blocks.push({ type: 'text', text: '' })
    writeJson(this.res, 200, buildAnthropicResponse(this.model, this.blocks, this.inputTokens, this.outputTokens))
  }

  fail(): void {
    // Nothing has been written yet, so the server renders the error response.
  }

  finish(): Promise<void> {
    return Promise.resolve()
  }

  private flushText(): void {
    if (!this.textBuffer) return
    this.blocks.push({ type: 'text', text: this.textBuffer })
    this.textBuffer = ''
  }
}
