import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { anthropicToKiro, openaiToKiro, buildAnthropicResponse } from '../src/translator'

describe('anthropicToKiro', () => {
  it('converts simple message', () => {
    const payload = anthropicToKiro({
      model: 'claude-opus-4-8[1m]',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    expect(msg['content']).toBe('hello')
    expect(msg['modelId']).toBe('claude-opus-4.8')
  })

  it('uses a fresh conversation id for independent requests', () => {
    const a = anthropicToKiro({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'a' }] })
    const b = anthropicToKiro({ model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'b' }] })
    expect(a.conversationState.conversationId).not.toBe(b.conversationState.conversationId)
    expect(a.conversationState.agentContinuationId).toBeUndefined()
  })

  it('maps model IDs correctly', () => {
    const cases: [string, string][] = [
      ['claude-opus-4-8[1m]', 'claude-opus-4.8'],
      ['claude-sonnet-4-6', 'claude-sonnet-4.6'],
      ['claude-sonnet-4.5', 'claude-sonnet-4.5'],
      ['claude-haiku-4-5-20251001', 'claude-haiku-4.5'],
      ['claude-haiku-4-20250414', 'claude-haiku-4'],
      ['claude-opus-4', 'claude-opus-4'],
    ]
    for (const [input, expected] of cases) {
      const p = anthropicToKiro({ model: input, messages: [{ role: 'user', content: 'x' }] })
      const msg = p.conversationState.currentMessage.userInputMessage as Record<string, unknown>
      expect(msg['modelId']).toBe(expected)
    }
  })

  it('rejects unsupported model ids and unsafe max_tokens', () => {
    expect(() => anthropicToKiro({ model: 'not-a-model', messages: [{ role: 'user', content: 'x' }] })).toThrow('Unsupported model id')
    expect(() => anthropicToKiro({ model: 'claude-sonnet-4.6', max_tokens: 0, messages: [{ role: 'user', content: 'x' }] })).toThrow('max_tokens')
    expect(() => anthropicToKiro({ model: 'claude-sonnet-4.6', max_tokens: 100_001, messages: [{ role: 'user', content: 'x' }] })).toThrow('max_tokens')
  })

  it('includes system prompt in content', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    expect(msg['content']).toContain('You are helpful.')
    expect(msg['content']).toContain('hi')
  })

  it('passes tools', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'calc' }],
      tools: [{ name: 'calc', description: 'math', input_schema: { type: 'object' } }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as Record<string, unknown>
    expect(ctx['tools']).toHaveLength(1)
  })

  it('uses runtime additional model fields for thinking instead of prompt injection', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      thinking: { type: 'enabled', budget_tokens: 12_000 },
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'think' }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    expect(msg['content']).not.toContain('enabled 200000')
    expect(msg['content']).toContain('You are helpful.')
    expect(payload.additionalModelRequestFields).toEqual({ output_config: { effort: 'high' } })
  })

  it('supports opt-in thinking prompt injection for experiments only', () => {
    const prev = process.env['KIRO_PROXY_INJECT_THINKING_PROMPT']
    try {
      process.env['KIRO_PROXY_INJECT_THINKING_PROMPT'] = '1'
      const payload = anthropicToKiro({
        model: 'claude-sonnet-4.6',
        thinking: { type: 'enabled', budget_tokens: 12_000 },
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'think' }],
      })
      const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
      expect(msg['content']).toContain('enabled 200000')
    } finally {
      if (prev === undefined) delete process.env['KIRO_PROXY_INJECT_THINKING_PROMPT']
      else process.env['KIRO_PROXY_INJECT_THINKING_PROMPT'] = prev
    }
  })

  it('does not send unsupported effort fields for models Kiro marks unsupported', () => {
    const payload = anthropicToKiro({
      model: 'claude-haiku-4',
      thinking: { type: 'enabled', budget_tokens: 12_000 },
      messages: [{ role: 'user', content: 'think' }],
    })
    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('sanitizes invalid tool names but rejects exact duplicates', () => {
    // Invalid name gets sanitized instead of rejected
    const payload1 = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'calc' }],
      tools: [{ name: 'bad tool name', description: 'bad', input_schema: { type: 'object' } }],
    })
    expect(payload1).toBeDefined()

    expect(() => anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'calc' }],
      tools: [
        { name: 'calc', description: 'math', input_schema: { type: 'object' } },
        { name: 'calc', description: 'math2', input_schema: { type: 'object' } },
      ],
    })).toThrow('tool name is duplicated')
  })

  it('deduplicates sanitized tool-name collisions and maps history tool uses', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'use tools' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'bad/tool', input: { x: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'done' }] },
      ],
      tools: [
        { name: 'bad tool', description: 'a', input_schema: { type: 'object' } },
        { name: 'bad/tool', description: 'b', input_schema: { type: 'object' } },
      ],
    })
    const toolNames = (((payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>)['userInputMessageContext'] as { tools: { toolSpecification: { name: string } }[] }).tools)
      .map((tool) => tool.toolSpecification.name)
    expect(toolNames).toEqual(['bad_tool', 'bad_tool_2'])
    const assistant = payload.conversationState.history[1] as { assistantResponseMessage: { toolUses: { name: string }[] } }
    expect(assistant.assistantResponseMessage.toolUses[0]?.name).toBe('bad_tool_2')
  })

  it('allows Claude Code sized tool sets while keeping a hard ceiling', () => {
    const tools = Array.from({ length: 81 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'tool',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    }))
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'use tools if needed' }],
      tools,
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as { tools: unknown[] }
    expect(ctx.tools).toHaveLength(81)

    const tooMany = Array.from({ length: 257 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'tool',
      input_schema: { type: 'object' },
    }))
    expect(() => anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'x' }],
      tools: tooMany,
    })).toThrow('tool count exceeds 256')
  })

  it('synthesizes Kiro image read flow for image blocks', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] }],
    })
    expect(payload.conversationState.history).toHaveLength(2)
    const syntheticToolUse = ((payload.conversationState.history[1] as { assistantResponseMessage: { toolUses: { name: string; input: Record<string, unknown> }[] } }).assistantResponseMessage.toolUses[0])!
    expect(syntheticToolUse.name).toBe('fs_read')
    expect(syntheticToolUse.input).toEqual({ operations: [{ mode: 'Image', image_paths: ['/tmp/kirolink-image-1.png'] }] })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    expect(msg['images']).toEqual([{ format: 'png', source: { bytes: 'abc' } }])
    const ctx = msg['userInputMessageContext'] as Record<string, unknown>
    expect(ctx['toolResults']).toHaveLength(1)
    expect(ctx['tools']).toHaveLength(1)
  })

  it('extracts tool results', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'calc 2+2' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'calc', input: { expr: '2+2' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '4' }] },
      ],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as Record<string, unknown>
    expect(ctx['toolResults']).toHaveLength(1)
  })

  it('preserves Anthropic tool_result errors for Kiro', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'ask' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'ask_user', input: { question: 'Pick one' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Invalid tool parameters', is_error: true }] },
      ],
      tools: [{ name: 'ask_user', description: 'Ask user', input_schema: { type: 'object' } }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as { toolResults: { status: string }[] }
    expect(ctx.toolResults[0]?.status).toBe('error')
  })

  it('repairs interrupted Anthropic tool uses that are missing results', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'ask me' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'ask_user', input: { question: 'Pick one' } }] },
        { role: 'user', content: 'continue after failed tool submit' },
      ],
      tools: [{ name: 'ask_user', description: 'Ask user', input_schema: { type: 'object' } }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as { toolResults: { toolUseId: string; status: string; content: { text: string }[] }[] }
    expect(ctx.toolResults).toEqual([{
      toolUseId: 'tu_1',
      status: 'error',
      content: [{ text: 'Tool use was interrupted before a result was returned.' }],
    }])
  })

  it('creates a current repair turn when Anthropic history ends with a tool use', () => {
    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'ask me' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'ask_user', input: { question: 'Pick one' } }] },
      ],
      tools: [{ name: 'ask_user', description: 'Ask user', input_schema: { type: 'object' } }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as { toolResults: { toolUseId: string; status: string }[] }
    expect(msg['content']).toBe('Continue.')
    expect(ctx.toolResults[0]).toMatchObject({ toolUseId: 'tu_1', status: 'error' })
  })

  it('rejects tool results that do not match a prior tool use', () => {
    expect(() => anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: '4' }] }],
    })).toThrow('unknown tool_use id')
  })

  it('rejects unsupported image payloads', () => {
    expect(() => anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', media_type: 'image/png', data: 'https://example.com/a.png' } }] }],
    })).toThrow('only base64 image sources')

    expect(() => anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zy8+' } }] }],
    })).toThrow('unsupported image media type')
  })
})

describe('openaiToKiro', () => {
  it('converts simple message', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    expect(msg['content']).toBe('hello')
    expect(msg['modelId']).toBe('claude-sonnet-4.6')
    const ctx = msg['userInputMessageContext'] as Record<string, unknown>
    expect(ctx['envState']).toBeDefined()
  })

  it('includes system message in content', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hi' },
      ],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    expect(msg['content']).toContain('Be concise.')
  })

  it('handles tool results', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'calc' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 'tc_1', content: '42' },
      ],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as Record<string, unknown>
    expect(ctx['toolResults']).toHaveLength(1)
  })

  it('preserves OpenAI tool results in earlier history turns', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'calc' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 'tc_1', content: '42' },
        { role: 'user', content: 'now explain' },
      ],
    })
    const toolResultTurn = payload.conversationState.history.find((entry) => {
      const user = (entry as Record<string, unknown>)['userInputMessage'] as Record<string, unknown> | undefined
      const ctx = user?.['userInputMessageContext'] as Record<string, unknown> | undefined
      return Array.isArray(ctx?.['toolResults'])
    }) as Record<string, unknown> | undefined
    expect(toolResultTurn).toBeTruthy()
  })

  it('repairs interrupted OpenAI tool calls that are missing results', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'calc' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'calc', arguments: '{"x":1}' } }] },
        { role: 'user', content: 'continue' },
      ],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as { toolResults: { toolUseId: string; status: string }[] }
    expect(ctx.toolResults[0]).toMatchObject({ toolUseId: 'tc_1', status: 'error' })
  })

  it('rejects OpenAI tool results and arguments that are inconsistent', () => {
    expect(() => openaiToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'tool', tool_call_id: 'tc_missing', content: '42' }],
    })).toThrow('unknown tool_use id')

    expect(() => openaiToKiro({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'user', content: 'calc' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'calc', arguments: 'not json' } }] },
      ],
    })).toThrow('arguments must be a JSON object')
  })

  it('maps OpenAI reasoning_effort to runtime additional model fields', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.6',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    expect(msg['content']).not.toContain('enabled 200000')
    expect(payload.additionalModelRequestFields).toEqual({ output_config: { effort: 'high' } })
  })
})

describe('Kiro CLI recording parity assumptions', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/kiro-cli-runtime-recording.json', import.meta.url), 'utf8')) as {
    request: {
      user_input_message: {
        user_input_message_context: { tools: { ToolSpecification: { input_schema: unknown } }[] }
        model_id: string
      }
    }
  }

  it('keeps the recorded CLI request shape visible without treating it as the proxy service body', () => {
    expect(fixture.request.user_input_message.model_id).toBe('auto')
    expect(fixture.request.user_input_message.user_input_message_context.tools[0]).toHaveProperty('ToolSpecification')
    expect(fixture.request.user_input_message.user_input_message_context.tools[0]?.ToolSpecification).toHaveProperty('input_schema')

    const payload = anthropicToKiro({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'calc' }],
      tools: [{ name: 'calc', description: 'math', input_schema: { type: 'object' } }],
    })
    const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
    const ctx = msg['userInputMessageContext'] as { tools: Record<string, unknown>[] }
    expect(ctx.tools[0]).toHaveProperty('toolSpecification')
  })
})

describe('buildAnthropicResponse', () => {
  it('sets stop_reason to tool_use when has tool blocks', () => {
    const resp = buildAnthropicResponse('m', [{ type: 'tool_use', id: 'x', name: 'y', input: {} }], 10, 5) as Record<string, unknown>
    expect(resp['stop_reason']).toBe('tool_use')
  })

  it('sets stop_reason to end_turn for text', () => {
    const resp = buildAnthropicResponse('m', [{ type: 'text', text: 'hi' }], 10, 5) as Record<string, unknown>
    expect(resp['stop_reason']).toBe('end_turn')
  })
})
