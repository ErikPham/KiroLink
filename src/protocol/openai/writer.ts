/**
 * OpenAI response writers.
 */

import type { ServerResponse } from 'node:http'
import type { KiroStreamEvent } from '../../domain/types'
import { openAIContextWindowErrorBody, RuntimeApiError, isContextWindowOverflow } from '../../errors'
import { beginSse, SseStream, startKeepalive, writeJson } from '../../http/response'
import type { ResponseWriter } from '../adapter'
import { buildUsage, nowSeconds, type OpenAIChunk, type OpenAIToolCall } from './types'

const KEEPALIVE_INTERVAL_MS = 15_000

export class OpenAIStreamWriter implements ResponseWriter {
  private readonly stream: SseStream
  private stopKeepalive: (() => void) | undefined
  private toolCallIndex = 0
  private hasToolCalls = false
  private inputTokens = 0
  private outputTokens = 0

  constructor(
    private readonly res: ServerResponse,
    private readonly model: string,
    private readonly id: string,
  ) {
    this.stream = new SseStream(res)
  }

  begin(): void {
    beginSse(this.res)
    this.stopKeepalive = startKeepalive(this.stream, KEEPALIVE_INTERVAL_MS)
  }

  handle(event: KiroStreamEvent): void {
    switch (event.type) {
      case 'text':
        this.chunk({ content: event.text })
        break
      case 'thinking':
        this.chunk({ reasoning_content: event.text })
        break
      case 'tool_use': {
        this.hasToolCalls = true
        const call: OpenAIToolCall & { index: number } = {
          index: this.toolCallIndex++,
          id: event.toolUse.toolUseId,
          type: 'function',
          function: { name: event.toolUse.name, arguments: JSON.stringify(event.toolUse.input) },
        }
        this.chunk({ tool_calls: [call] })
        break
      }
      case 'done':
        this.inputTokens = event.inputTokens
        this.outputTokens = event.outputTokens
        break
    }
  }

  complete(): void {
    this.stopKeepalive?.()
    const final: OpenAIChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: nowSeconds(),
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: this.hasToolCalls ? 'tool_calls' : 'stop' }],
      usage: buildUsage(this.inputTokens, this.outputTokens),
    }
    this.stream.data(final)
    this.stream.raw('data: [DONE]\n\n')
  }

  fail(error: unknown): void {
    this.stopKeepalive?.()
    const body = error instanceof RuntimeApiError && isContextWindowOverflow(error)
      ? openAIContextWindowErrorBody()
      : { error: { message: error instanceof Error ? error.message : String(error), type: 'api_error' } }
    this.stream.data(body)
    this.stream.raw('data: [DONE]\n\n')
  }

  finish(): Promise<void> {
    return this.stream.flush()
  }

  private chunk(delta: OpenAIChunk['choices'][number]['delta']): void {
    this.stream.data({
      id: this.id,
      object: 'chat.completion.chunk',
      created: nowSeconds(),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    } satisfies OpenAIChunk)
  }
}

export class OpenAIJsonWriter implements ResponseWriter {
  private content = ''
  private reasoning = ''
  private readonly toolCalls: OpenAIToolCall[] = []
  private inputTokens = 0
  private outputTokens = 0

  constructor(
    private readonly res: ServerResponse,
    private readonly model: string,
    private readonly id: string,
  ) {}

  begin(): void {
    // Headers are written with the body once the full response is known.
  }

  handle(event: KiroStreamEvent): void {
    switch (event.type) {
      case 'text':
        this.content += event.text
        break
      case 'thinking':
        this.reasoning += event.text
        break
      case 'tool_use':
        this.toolCalls.push({
          id: event.toolUse.toolUseId,
          type: 'function',
          function: { name: event.toolUse.name, arguments: JSON.stringify(event.toolUse.input) },
        })
        break
      case 'done':
        this.inputTokens = event.inputTokens
        this.outputTokens = event.outputTokens
        break
    }
  }

  complete(): void {
    writeJson(this.res, 200, {
      id: this.id,
      object: 'chat.completion',
      created: nowSeconds(),
      model: this.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          // OpenAI uses null, not an empty string, for a tool-only response.
          content: this.content || null,
          ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
          ...(this.toolCalls.length ? { tool_calls: this.toolCalls } : {}),
        },
        finish_reason: this.toolCalls.length ? 'tool_calls' : 'stop',
      }],
      usage: buildUsage(this.inputTokens, this.outputTokens),
    })
  }

  fail(): void {
    // Nothing written yet; the server renders the error response.
  }

  finish(): Promise<void> {
    return Promise.resolve()
  }
}
