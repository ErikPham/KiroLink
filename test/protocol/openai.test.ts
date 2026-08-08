/**
 * OpenAI → Kiro translation.
 */

import { describe, expect, it } from 'vitest'
import { isAssistantHistoryEntry, isUserHistoryEntry } from '../../src/domain/types'
import type { KiroPayload } from '../../src/domain/types'
import { createConversationIdAssigner } from '../../src/protocol/conversation'
import { openaiToKiro, validateOpenAIRequest } from '../../src/protocol/openai/translate'
import type { OpenAIRequest } from '../../src/protocol/openai/types'
import { testConfig } from '../support/harness'

const config = testConfig()

function translate(request: OpenAIRequest, overrides = {}): KiroPayload {
  const merged = { ...config, ...overrides }
  return openaiToKiro(request, merged, createConversationIdAssigner(merged.translation)).payload
}

function currentMessage(payload: KiroPayload) {
  return payload.conversationState.currentMessage.userInputMessage
}

describe('basic translation', () => {
  it('maps a single user message', () => {
    const payload = translate({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'hello' }] })

    expect(currentMessage(payload).content).toBe('hello')
    expect(currentMessage(payload).modelId).toBe('claude-sonnet-4.6')
    expect(payload.conversationState.history).toEqual([])
  })

  it('folds system messages into the current turn', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }],
    })

    expect(currentMessage(payload).content).toBe('Be brief.\n\nhi')
  })

  it('joins multiple system messages', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'system', content: 'One.' },
        { role: 'system', content: 'Two.' },
        { role: 'user', content: 'hi' },
      ],
    })

    expect(currentMessage(payload).content).toBe('One.\nTwo.\n\nhi')
  })

  it('splits earlier turns into history', () => {
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

  it('substitutes placeholder text for an empty turn', () => {
    const payload = translate({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: '' }] })
    expect(currentMessage(payload).content).toBe('Continue.')
  })
})

describe('tool calls and results', () => {
  const conversation = (): OpenAIRequest => ({
    model: 'claude-sonnet-4.6',
    messages: [
      { role: 'user', content: 'what time is it' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
    ],
  })

  it('pairs a tool result with its call', () => {
    const payload = translate(conversation())

    const assistant = payload.conversationState.history[1]
    const toolUses = assistant && isAssistantHistoryEntry(assistant) ? assistant.assistantResponseMessage.toolUses : []
    expect(toolUses[0]).toEqual({ toolUseId: 'call_1', name: 'get_time', input: { tz: 'UTC' } })

    expect(currentMessage(payload).userInputMessageContext?.toolResults).toEqual([
      { toolUseId: 'call_1', content: [{ text: '12:00' }], status: 'success' },
    ])
  })

  it('keeps a tool result in history when the conversation continues', () => {
    const request = conversation()
    request.messages.push({ role: 'assistant', content: 'It is noon.' }, { role: 'user', content: 'thanks' })
    const payload = translate(request)

    const toolTurn = payload.conversationState.history.find(
      (entry) => isUserHistoryEntry(entry) && entry.userInputMessage.userInputMessageContext?.toolResults?.length,
    )
    expect(toolTurn).toBeDefined()
  })

  it('does not merge a tool-result turn with a plain user turn', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' },
        { role: 'user', content: 'follow up' },
      ],
    })

    // The tool-result turn stays separate, so results are not reordered relative
    // to the call they answer.
    const toolTurns = payload.conversationState.history.filter(
      (entry) => isUserHistoryEntry(entry) && entry.userInputMessage.userInputMessageContext?.toolResults?.length,
    )
    expect(toolTurns).toHaveLength(1)
    expect(currentMessage(payload).content).toBe('follow up')
  })

  it('synthesizes a result for an interrupted call', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      ],
    })

    const results = currentMessage(payload).userInputMessageContext?.toolResults
    expect(results?.[0]?.status).toBe('error')
    expect(results?.[0]?.content[0]?.text).toMatch(/interrupted/u)
  })

  it('rejects non-object tool arguments', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '"text"' } }] }],
    })).toThrow(/must be a JSON object/u)
  })

  it('rejects a tool result with no matching call', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'tool', tool_call_id: 'call_missing', content: 'x' }],
    })).toThrow(/unknown tool_use id/u)
  })

  it('rejects a duplicate call id', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_1', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      }],
    })).toThrow(/duplicated/u)
  })

  it('translates OpenAI tool definitions into Kiro specs', () => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'get_time', description: 'time', parameters: { type: 'object' } } }],
    })

    expect(currentMessage(payload).userInputMessageContext?.tools).toEqual([
      { toolSpecification: { name: 'get_time', description: 'time', inputSchema: { json: { type: 'object' } } } },
    ])
  })
})

describe('reasoning effort', () => {
  it.each([
    ['max', 'max'],
    ['high', 'high'],
    ['medium', 'medium'],
    ['low', 'low'],
    ['minimal', 'low'],
  ])('maps reasoning_effort %s to effort %s', (input, expected) => {
    const payload = translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      reasoning_effort: input,
    })

    expect(payload.additionalModelRequestFields).toEqual({ output_config: { effort: expected } })
  })

  it('rejects an unknown effort', () => {
    expect(() => translate({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      reasoning_effort: 'turbo',
    })).toThrow(/Unsupported thinking effort/u)
  })

  it('omits the field when reasoning is not requested', () => {
    const payload = translate({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }] })
    expect(payload.additionalModelRequestFields).toBeUndefined()
  })
})

describe('request validation', () => {
  it('accepts a well-formed request', () => {
    expect(() => validateOpenAIRequest({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
    })).not.toThrow()
  })

  it.each([
    ['a non-object body', 42],
    ['a missing model', { messages: [{ role: 'user', content: 'x' }] }],
    ['empty messages', { model: 'm', messages: [] }],
    ['an unknown role', { model: 'm', messages: [{ role: 'developer', content: 'x' }] }],
    ['a tool message with no id', { model: 'm', messages: [{ role: 'tool', content: 'x' }] }],
    ['non-array tool_calls', { model: 'm', messages: [{ role: 'assistant', tool_calls: {} }] }],
    ['a tool with no function name', { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: {} }] }],
    ['a non-string reasoning_effort', { model: 'm', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 3 }],
  ])('rejects %s', (_label, body) => {
    expect(() => validateOpenAIRequest(body)).toThrow()
  })
})
