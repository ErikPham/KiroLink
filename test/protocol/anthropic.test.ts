/**
 * Anthropic → Kiro translation.
 */

import { describe, expect, it } from 'vitest'
import { anthropicToKiro, validateAnthropicRequest } from '../../src/protocol/anthropic/translate'
import { buildAnthropicResponse } from '../../src/protocol/anthropic/types'
import type { AnthropicRequest } from '../../src/protocol/anthropic/types'
import { createConversationIdAssigner } from '../../src/protocol/conversation'
import { isAssistantHistoryEntry, isUserHistoryEntry } from '../../src/domain/types'
import type { KiroPayload } from '../../src/domain/types'
import { testConfig } from '../support/harness'

const config = testConfig()

function translate(request: AnthropicRequest, overrides = {}): KiroPayload {
  const merged = { ...config, ...overrides }
  return anthropicToKiro(request, merged, createConversationIdAssigner(merged.translation)).payload
}

function currentMessage(payload: KiroPayload) {
  return payload.conversationState.currentMessage.userInputMessage
}

const LONG_TEXT = 'this is a sufficiently long first user message to be a stable anchor'

describe('basic translation', () => {
  it('maps a single user message onto the current turn', () => {
    const payload = translate({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hello' }] })

    expect(currentMessage(payload).content).toBe('hello')
    expect(currentMessage(payload).modelId).toBe('claude-sonnet-4.6')
    expect(currentMessage(payload).origin).toBe('KIRO_CLI')
    expect(payload.conversationState.history).toEqual([])
    expect(payload.conversationState.chatTriggerType).toBe('MANUAL')
  })

  it('splits earlier turns into history and keeps the last as current', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
    })

    expect(payload.conversationState.history).toHaveLength(2)
    expect(currentMessage(payload).content).toBe('third')
  })

  it('merges consecutive same-role messages to preserve alternation', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'three' },
      ],
    })

    const first = payload.conversationState.history[0]
    expect(first && isUserHistoryEntry(first) ? first.userInputMessage.content : '').toBe('one\ntwo')
  })

  it('prepends the system prompt to the first user turn', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(currentMessage(payload).content).toBe('Be terse.\n\nhi')
  })

  it('flattens an array-form system prompt', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(currentMessage(payload).content).toBe('a\nb\n\nhi')
  })

  it('omits envState from history turns but keeps it on the current turn', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    })

    const first = payload.conversationState.history[0]
    const historyContext = first && isUserHistoryEntry(first) ? first.userInputMessage.userInputMessageContext : undefined
    expect(historyContext?.envState).toBeUndefined()
    expect(currentMessage(payload).userInputMessageContext?.envState).toBeDefined()
  })
})

describe('model mapping', () => {
  it.each([
    ['claude-sonnet-4-6', 'claude-sonnet-4.6'],
    ['claude-sonnet-4.6', 'claude-sonnet-4.6'],
    ['claude-opus-4-8[1m]', 'claude-opus-4.8'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
    ['claude-opus-4-6-20260601', 'claude-opus-4.6'],
  ])('normalizes %s to %s', (input, expected) => {
    const payload = translate({ model: input, messages: [{ role: 'user', content: 'x' }] })
    expect(currentMessage(payload).modelId).toBe(expected)
  })

  it('passes through non-Claude ids Kiro serves', () => {
    for (const model of ['auto', 'minimax-m2.5', 'qwen3-coder-next']) {
      const payload = translate({ model, messages: [{ role: 'user', content: 'x' }] })
      expect(currentMessage(payload).modelId).toBe(model)
    }
  })

  it('rejects unsupported model ids', () => {
    expect(() => translate({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] })).toThrow(/Unsupported model/u)
  })
})

describe('conversation id', () => {
  const request = (text: string): AnthropicRequest => ({
    model: 'claude-sonnet-4.6',
    messages: [{ role: 'user', content: text }],
  })

  it('stays stable across turns of one conversation', () => {
    const assigner = createConversationIdAssigner(config.translation)
    const first = anthropicToKiro(request(LONG_TEXT), config, assigner).payload
    const second = anthropicToKiro(
      { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: LONG_TEXT }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }] },
      config,
      assigner,
    ).payload

    expect(second.conversationState.conversationId).toBe(first.conversationState.conversationId)
  })

  it('differs for different first messages', () => {
    const assigner = createConversationIdAssigner(config.translation)
    const a = anthropicToKiro(request(`${LONG_TEXT} A`), config, assigner).payload
    const b = anthropicToKiro(request(`${LONG_TEXT} B`), config, assigner).payload

    expect(a.conversationState.conversationId).not.toBe(b.conversationState.conversationId)
  })

  it('uses an ephemeral id for short or synthetic anchors', () => {
    const assigner = createConversationIdAssigner(config.translation)
    for (const text of ['hi', 'Continue.', '.']) {
      const a = anthropicToKiro(request(text), config, assigner).payload
      const b = anthropicToKiro(request(text), config, assigner).payload
      expect(a.conversationState.conversationId).not.toBe(b.conversationState.conversationId)
    }
  })

  it('forces random ids when configured', () => {
    const overrides = { translation: { ...config.translation, randomConversationId: true } }
    const a = translate(request(LONG_TEXT), overrides)
    const b = translate(request(LONG_TEXT), overrides)

    expect(a.conversationState.conversationId).not.toBe(b.conversationState.conversationId)
  })
})

describe('tools', () => {
  it('emits Kiro tool specifications', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
    })

    expect(currentMessage(payload).userInputMessageContext?.tools).toEqual([
      { toolSpecification: { name: 'Read', description: 'read', inputSchema: { json: { type: 'object' } } } },
    ])
  })

  it('sanitizes an invalid tool name and maps it back', () => {
    const result = anthropicToKiro(
      {
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'search.files', description: 'd', input_schema: {} }],
      },
      config,
      createConversationIdAssigner(config.translation),
    )

    expect(result.toolNameMap.get('search_files')).toBe('search.files')
  })

  it('shortens an MCP namespace that exceeds the name budget', () => {
    const long = `mcp__${'server'.repeat(12)}__do_thing`
    const result = anthropicToKiro(
      {
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: long, description: 'd', input_schema: {} }],
      },
      config,
      createConversationIdAssigner(config.translation),
    )

    const sanitized = [...result.toolNameMap.keys()][0]!
    expect(sanitized.length).toBeLessThanOrEqual(64)
    expect(result.toolNameMap.get(sanitized)).toBe(long)
  })

  it('rejects exact duplicate tool names', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'Read', description: 'a', input_schema: {} },
        { name: 'Read', description: 'b', input_schema: {} },
      ],
    })).toThrow(/duplicated/u)
  })

  it('disambiguates two names that sanitize to the same value', () => {
    const result = anthropicToKiro(
      {
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          { name: 'a.b', description: 'first', input_schema: {} },
          { name: 'a:b', description: 'second', input_schema: {} },
        ],
      },
      config,
      createConversationIdAssigner(config.translation),
    )

    const specs = currentMessage(result.payload).userInputMessageContext?.tools as { toolSpecification: { name: string } }[]
    expect(new Set(specs.map((spec) => spec.toolSpecification.name)).size).toBe(2)
    expect(result.toolNameMap.get('a_b')).toBe('a.b')
    expect(result.toolNameMap.get('a_b_2')).toBe('a:b')
  })

  it('enforces the tool-count ceiling', () => {
    const tools = Array.from({ length: 5 }, (_unused, index) => ({
      name: `tool_${index}`,
      description: 'd',
      input_schema: {},
    }))
    expect(() => translate(
      { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }], tools },
      { limits: { ...config.limits, maxTools: 4 } },
    )).toThrow(/tool count exceeds/u)
  })

  it('enforces the total schema-size ceiling', () => {
    const big = { type: 'object', description: 'x'.repeat(2000) }
    expect(() => translate(
      {
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'a', description: 'd', input_schema: big }, { name: 'b', description: 'd', input_schema: big }],
      },
      { limits: { ...config.limits, maxTotalToolSchemaBytes: 2500 } },
    )).toThrow(/schemas are too large/u)
  })
})

describe('tool use and results', () => {
  const conversation = (isError = false): AnthropicRequest => ({
    model: 'claude-sonnet-4.6',
    messages: [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done', is_error: isError }] },
    ],
  })

  it('pairs a tool result with its tool use', () => {
    const payload = translate(conversation())

    const assistant = payload.conversationState.history[1]
    expect(assistant && isAssistantHistoryEntry(assistant) ? assistant.assistantResponseMessage.toolUses : []).toHaveLength(1)
    expect(currentMessage(payload).userInputMessageContext?.toolResults).toEqual([
      { toolUseId: 'toolu_1', content: [{ text: 'done' }], status: 'success' },
    ])
  })

  it('preserves an error status', () => {
    const payload = translate(conversation(true))
    expect(currentMessage(payload).userInputMessageContext?.toolResults?.[0]?.status).toBe('error')
  })

  it('rejects a tool result with no matching tool use', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'orphan' }] }],
    })).toThrow(/unknown tool_use id/u)
  })

  it('rejects a duplicate tool_use id', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'A', input: {} },
          { type: 'tool_use', id: 'toolu_1', name: 'B', input: {} },
        ],
      }],
    })).toThrow(/duplicated/u)
  })

  it('rejects an invalid tool_use id', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'bad id!', name: 'A', input: {} }] }],
    })).toThrow(/id is invalid/u)
  })

  it('synthesizes a result for an interrupted tool use', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
      ],
    })

    const results = currentMessage(payload).userInputMessageContext?.toolResults
    expect(results?.[0]?.status).toBe('error')
    expect(results?.[0]?.content[0]?.text).toMatch(/interrupted/u)
  })

  it('truncates an oversized tool result rather than rejecting it', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(200_000) }] },
      ],
    })

    const text = currentMessage(payload).userInputMessageContext?.toolResults?.[0]?.content[0]?.text ?? ''
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024)
    expect(text).toMatch(/truncated: original_bytes=200000/u)
  })

  it('truncates only once, so the marker survives', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'y'.repeat(500_000) }] },
      ],
    })

    const text = currentMessage(payload).userInputMessageContext?.toolResults?.[0]?.content[0]?.text ?? ''
    expect(text.endsWith(']')).toBe(true)
    expect(text.match(/truncated/gu)).toHaveLength(1)
  })

  it('caps oversized message content without dropping history turns', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'z'.repeat(300_000) },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' },
      ],
    })

    expect(payload.conversationState.history).toHaveLength(2)
    const first = payload.conversationState.history[0]
    const content = first && isUserHistoryEntry(first) ? first.userInputMessage.content : ''
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(128 * 1024)
  })
})

describe('images', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg=='

  const imageRequest = (): AnthropicRequest => ({
    model: 'claude-sonnet-4.6',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      ],
    }],
  })

  it('delivers images through a synthesized fs_read tool call', () => {
    const payload = translate(imageRequest())

    // A user turn plus an assistant tool use are synthesized ahead of the image.
    expect(payload.conversationState.history).toHaveLength(2)
    const assistant = payload.conversationState.history[1]
    const toolUses = assistant && isAssistantHistoryEntry(assistant) ? assistant.assistantResponseMessage.toolUses : []
    expect(toolUses[0]?.name).toBe('fs_read')

    expect(currentMessage(payload).images).toEqual([{ format: 'png', source: { bytes: png } }])
    expect(currentMessage(payload).userInputMessageContext?.toolResults?.[0]?.content[0]?.text).toBe('See images data supplied')
  })

  it('declares the synthetic image tool alongside client tools', () => {
    const request = imageRequest()
    request.tools = [{ name: 'Read', description: 'd', input_schema: {} }]
    const payload = translate(request)

    const specs = currentMessage(payload).userInputMessageContext?.tools as { toolSpecification: { name: string } }[]
    expect(specs.map((spec) => spec.toolSpecification.name)).toContain('fs_read')
  })

  it('extracts a tool_result image without stringifying its base64', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'screenshot it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Shot', input: {} }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
          }],
        },
      ],
    })

    expect(currentMessage(payload).images).toEqual([{ format: 'png', source: { bytes: png } }])
    const text = currentMessage(payload).userInputMessageContext?.toolResults?.[0]?.content[0]?.text ?? ''
    expect(text).not.toContain(png)
  })

  it('rejects an unsupported media type or non-base64 source', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: png } }] }],
    })).toThrow(/unsupported image media type/u)

    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data:image/png;base64,AAA' } }] }],
    })).toThrow(/base64/u)
  })

  it('rejects more images than the limit allows', () => {
    const many = Array.from({ length: 21 }, () => ({
      type: 'image' as const,
      source: { type: 'base64', media_type: 'image/png', data: png },
    }))
    expect(() => translate({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: many }] }))
      .toThrow(/image count exceeds/u)
  })
})

describe('thinking', () => {
  it('sends an effort field for a supporting model', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 32_000 },
    })

    expect(payload.additionalModelRequestFields).toEqual({ output_config: { effort: 'xhigh' } })
  })

  it.each([
    [70_000, 'max'],
    [32_000, 'xhigh'],
    [12_000, 'high'],
    [4_000, 'medium'],
    [500, 'low'],
  ])('maps budget %i to effort %s', (budget, effort) => {
    const payload = translate({
      model: 'claude-opus-4.7',
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: budget },
    })
    expect(payload.additionalModelRequestFields).toEqual({ output_config: { effort } })
  })

  it('omits the field for a model Kiro does not support it on', () => {
    const payload = translate({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 32_000 },
    })

    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('does not inject a thinking prompt by default', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 10_000 },
    })

    expect(currentMessage(payload).content).not.toContain('enabled 200000')
  })

  it('injects a thinking prompt when explicitly enabled', () => {
    const payload = translate(
      { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }], thinking: { type: 'enabled' } },
      { translation: { ...config.translation, injectThinkingPrompt: true } },
    )

    expect(currentMessage(payload).content).toContain('enabled 200000')
  })
})

describe('inference config', () => {
  it('passes max_tokens through', () => {
    const payload = translate({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }], max_tokens: 4096 })
    expect(payload.inferenceConfig).toEqual({ maxTokens: 4096 })
  })

  it('omits inferenceConfig when max_tokens is absent', () => {
    const payload = translate({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }] })
    expect(payload.inferenceConfig).toBeUndefined()
  })
})

describe('request validation', () => {
  it('accepts a well-formed request', () => {
    expect(() => validateAnthropicRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
    })).not.toThrow()
  })

  it.each([
    ['a non-object body', 'nope'],
    ['a missing model', { messages: [] }],
    ['empty messages', { model: 'm', messages: [] }],
    ['a bad role', { model: 'm', messages: [{ role: 'tool', content: 'x' }] }],
    ['non-array tools', { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: {} }],
    ['a tool with no name', { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{}] }],
    ['a bad thinking shape', { model: 'm', messages: [{ role: 'user', content: 'x' }], thinking: 'on' }],
    ['a negative budget', { model: 'm', messages: [{ role: 'user', content: 'x' }], thinking: { type: 'enabled', budget_tokens: -1 } }],
    ['oversized max_tokens', { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10_000_000 }],
  ])('rejects %s', (_label, body) => {
    expect(() => validateAnthropicRequest(body)).toThrow()
  })
})

describe('buildAnthropicResponse', () => {
  it('reports tool_use when a tool block is present', () => {
    const response = buildAnthropicResponse('claude-sonnet-4.6', [
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    ], 1, 2)

    expect(response.stop_reason).toBe('tool_use')
    expect(response.id).toMatch(/^msg_/u)
  })

  it('reports end_turn for text only', () => {
    const response = buildAnthropicResponse('claude-sonnet-4.6', [{ type: 'text', text: 'hi' }], 1, 2)
    expect(response.stop_reason).toBe('end_turn')
    expect(response.usage).toEqual({ input_tokens: 1, output_tokens: 2 })
  })
})
