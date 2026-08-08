/**
 * Chat path, end to end.
 *
 * This is the coverage the previous architecture made impossible: with the
 * upstream imported as a module binding, none of the streaming, error mapping,
 * or abort behavior could be reached from a test.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeApiError } from '../../src/errors'
import type { KiroStreamEvent } from '../../src/domain/types'
import {
  fakeClient,
  failingClient,
  fakeUsage,
  okUsage,
  partialThenFailClient,
  textEvents,
} from '../support/harness'
import { parseSse, postJson, postSse, startServer, type LiveServer } from '../support/server'

let live: LiveServer | undefined

afterEach(async () => {
  await live?.close()
  live = undefined
})

const anthropicBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'claude-sonnet-4.6',
  messages: [{ role: 'user', content: 'hello there, this is a test message' }],
  ...extra,
})

const openaiBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'claude-sonnet-4.6',
  messages: [{ role: 'user', content: 'hello there, this is a test message' }],
  ...extra,
})

describe('POST /v1/messages (buffered)', () => {
  it('returns assistant text with usage', async () => {
    live = await startServer({ client: fakeClient(textEvents('Hello!', 11, 3)) })

    const { status, body } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(status).toBe(200)
    const message = body as { content: unknown[]; stop_reason: string; usage: unknown; role: string }
    expect(message.role).toBe('assistant')
    expect(message.content).toEqual([{ type: 'text', text: 'Hello!' }])
    expect(message.stop_reason).toBe('end_turn')
    expect(message.usage).toEqual({ input_tokens: 11, output_tokens: 3 })
  })

  it('orders thinking before text and reports tool_use as the stop reason', async () => {
    const events: KiroStreamEvent[] = [
      { type: 'text', text: 'working' },
      { type: 'thinking', text: 'let me think' },
      { type: 'tool_use', toolUse: { toolUseId: 'toolu_1', name: 'Read', input: { path: 'a.ts' } } },
      { type: 'done', inputTokens: 4, outputTokens: 9 },
    ]
    live = await startServer({ client: fakeClient(events) })

    const { body } = await postJson(live.url, '/v1/messages', anthropicBody())

    const message = body as { content: { type: string }[]; stop_reason: string }
    expect(message.content.map((block) => block.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(message.stop_reason).toBe('tool_use')
  })

  it('always returns at least one content block', async () => {
    live = await startServer({ client: fakeClient([{ type: 'done', inputTokens: 1, outputTokens: 0 }]) })

    const { body } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect((body as { content: unknown[] }).content).toEqual([{ type: 'text', text: '' }])
  })
})

describe('POST /v1/messages (streaming)', () => {
  it('emits a well-formed Anthropic event sequence', async () => {
    live = await startServer({ client: fakeClient(textEvents('Hi', 2, 1)) })

    const { text } = await postSse(live.url, '/v1/messages', anthropicBody({ stream: true }))
    const events = parseSse(text).map((entry) => entry.event)

    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  it('returns a pre-stream context overflow as HTTP 400 so the client can compact', async () => {
    const upstream = new RuntimeApiError(500, JSON.stringify({ reason_code: 'ContextWindowOverflow' }))
    live = await startServer({ client: failingClient(upstream) })

    const { status, body } = await postJson(live.url, '/v1/messages', anthropicBody({ stream: true }))

    expect(status).toBe(400)
    expect((body as { error: { type: string; message: string } }).error).toMatchObject({
      type: 'invalid_request_error',
    })
    expect((body as { error: { message: string } }).error.message).toContain('maximum context length')
  })

  it('closes a text block before opening a thinking block', async () => {
    const events: KiroStreamEvent[] = [
      { type: 'text', text: 'a' },
      { type: 'thinking', text: 'b' },
      { type: 'text', text: 'c' },
      { type: 'done', inputTokens: 1, outputTokens: 1 },
    ]
    live = await startServer({ client: fakeClient(events) })

    const { text } = await postSse(live.url, '/v1/messages', anthropicBody({ stream: true }))
    const parsed = parseSse(text)

    // Each switch of block kind must close the open block before starting the next.
    const sequence = parsed
      .filter((entry) => entry.event?.startsWith('content_block'))
      .map((entry) => entry.event)
    expect(sequence).toEqual([
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
    ])

    // Block indices must increase monotonically from zero.
    const indices = parsed
      .filter((entry) => entry.event === 'content_block_start')
      .map((entry) => (entry.data as { index: number }).index)
    expect(indices).toEqual([0, 1, 2])
  })

  it('reports tool_use as the stream stop reason', async () => {
    const events: KiroStreamEvent[] = [
      { type: 'tool_use', toolUse: { toolUseId: 'toolu_9', name: 'Bash', input: { cmd: 'ls' } } },
      { type: 'done', inputTokens: 1, outputTokens: 2 },
    ]
    live = await startServer({ client: fakeClient(events) })

    const { text } = await postSse(live.url, '/v1/messages', anthropicBody({ stream: true }))
    const delta = parseSse(text).find((entry) => entry.event === 'message_delta')

    expect(delta).toBeDefined()
    expect((delta?.data as { delta: { stop_reason: string } } | undefined)?.delta.stop_reason).toBe('tool_use')
  })
})

describe('POST /v1/chat/completions', () => {
  it('returns an OpenAI completion', async () => {
    live = await startServer({ client: fakeClient(textEvents('Yo', 3, 4)) })

    const { status, body } = await postJson(live.url, '/v1/chat/completions', openaiBody())

    expect(status).toBe(200)
    const completion = body as {
      object: string
      choices: { message: { content: string }; finish_reason: string }[]
      usage: unknown
    }
    expect(completion.object).toBe('chat.completion')
    expect(completion.choices[0]?.message.content).toBe('Yo')
    expect(completion.choices[0]?.finish_reason).toBe('stop')
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })
  })

  it('uses null content and tool_calls for a tool-only reply', async () => {
    const events: KiroStreamEvent[] = [
      { type: 'tool_use', toolUse: { toolUseId: 'call_1', name: 'get_time', input: {} } },
      { type: 'done', inputTokens: 1, outputTokens: 1 },
    ]
    live = await startServer({ client: fakeClient(events) })

    const { body } = await postJson(live.url, '/v1/chat/completions', openaiBody())

    const choice = (body as { choices: { message: { content: null; tool_calls: unknown[] }; finish_reason: string }[] }).choices[0]
    expect(choice?.message.content).toBeNull()
    expect(choice?.finish_reason).toBe('tool_calls')
    expect(choice?.message.tool_calls).toHaveLength(1)
  })

  it('terminates a stream with a usage chunk then [DONE]', async () => {
    live = await startServer({ client: fakeClient(textEvents('stream me', 6, 8)) })

    const { text } = await postSse(live.url, '/v1/chat/completions', openaiBody({ stream: true }))
    const parsed = parseSse(text)

    expect(parsed[parsed.length - 1]?.data).toBe('[DONE]')
    const final = parsed[parsed.length - 2]?.data as { choices: { finish_reason: string }[]; usage: unknown }
    expect(final.choices[0]?.finish_reason).toBe('stop')
    expect(final.usage).toEqual({ prompt_tokens: 6, completion_tokens: 8, total_tokens: 14 })
  })

  it('sends reasoning as reasoning_content deltas', async () => {
    const events: KiroStreamEvent[] = [
      { type: 'thinking', text: 'pondering' },
      { type: 'done', inputTokens: 1, outputTokens: 1 },
    ]
    live = await startServer({ client: fakeClient(events) })

    const { text } = await postSse(live.url, '/v1/chat/completions', openaiBody({ stream: true }))
    const deltas = parseSse(text)
      .map((entry) => entry.data)
      .filter((data): data is { choices: { delta: { reasoning_content?: string } }[] } => typeof data === 'object' && data !== null)
      .flatMap((data) => data.choices?.map((choice) => choice.delta.reasoning_content) ?? [])

    expect(deltas).toContain('pondering')
  })
})

describe('error mapping', () => {
  it('maps a pre-stream context overflow to the Anthropic compaction shape', async () => {
    const upstream = new RuntimeApiError(400, JSON.stringify({ reason: 'REQUEST_BODY_INVALID' }))
    live = await startServer({ client: failingClient(upstream) })

    const { status, body } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(status).toBe(400)
    const error = body as { type: string; error: { type: string; message: string } }
    expect(error.type).toBe('error')
    expect(error.error.type).toBe('invalid_request_error')
    // Claude Code keys its reactive compaction off this wording.
    expect(error.error.message).toContain('maximum context length')
  })

  it('maps a pre-stream context overflow to the OpenAI code', async () => {
    const upstream = new RuntimeApiError(400, JSON.stringify({ reason: 'ContextWindowOverflow' }))
    live = await startServer({ client: failingClient(upstream) })

    const { status, body } = await postJson(live.url, '/v1/chat/completions', openaiBody())

    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('context_length_exceeded')
  })

  it('delivers a mid-stream failure inside the open SSE stream', async () => {
    const upstream = new RuntimeApiError(500, 'boom')
    live = await startServer({ client: partialThenFailClient([{ type: 'text', text: 'partial' }], upstream) })

    const { status, text } = await postSse(live.url, '/v1/messages', anthropicBody({ stream: true }))

    // Headers were already sent, so the status stays 200 and the error rides
    // inside the stream.
    expect(status).toBe(200)
    const errorEvent = parseSse(text).find((entry) => entry.event === 'error')
    expect(errorEvent).toBeDefined()
  })

  it('keeps a buffered partial failure as a normal HTTP error', async () => {
    const upstream = new RuntimeApiError(500, 'boom')
    live = await startServer({ client: partialThenFailClient([{ type: 'text', text: 'partial' }], upstream) })

    const { status, body } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(status).toBe(503)
    expect((body as { error: { type: string } }).error.type).toBe('overloaded_error')
  })

  it('maps upstream 429 to 429 with Retry-After', async () => {
    const upstream = new RuntimeApiError(429, 'slow down', { retryAfterSeconds: 7 })
    live = await startServer({ client: failingClient(upstream) })

    const { status, headers, body } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(status).toBe(429)
    expect(headers.get('retry-after')).toBe('7')
    expect((body as { error: { type: string } }).error.type).toBe('rate_limit_error')
  })

  it('maps an upstream 5xx to 503', async () => {
    live = await startServer({ client: failingClient(new RuntimeApiError(502, 'bad gateway')) })

    const { status } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(status).toBe(503)
  })

  it('keeps upstream error detail out of the client message by default', async () => {
    const upstream = new RuntimeApiError(500, 'secret internal trace')
    live = await startServer({ client: failingClient(upstream) })

    const { body } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(JSON.stringify(body)).not.toContain('secret internal trace')
  })
})

describe('request validation', () => {
  it('rejects a malformed tools field with 400, not 500', async () => {
    live = await startServer({ client: fakeClient(textEvents('unused')) })

    const { status, body } = await postJson(live.url, '/v1/messages', anthropicBody({ tools: 42 }))

    expect(status).toBe(400)
    expect((body as { error: { type: string } }).error.type).toBe('invalid_request_error')
  })

  it.each([
    ['missing model', { messages: [{ role: 'user', content: 'hi' }] }],
    ['empty messages', { model: 'claude-sonnet-4.6', messages: [] }],
    ['bad role', { model: 'claude-sonnet-4.6', messages: [{ role: 'system', content: 'x' }] }],
    ['bad max_tokens', { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }], max_tokens: -1 }],
    ['unknown model', { model: 'gpt-4', messages: [{ role: 'user', content: 'x' }] }],
    ['non-boolean stream', { model: 'claude-sonnet-4.6', messages: [{ role: 'user', content: 'x' }], stream: 'yes' }],
  ])('rejects %s with 400', async (_label, payload) => {
    live = await startServer({ client: fakeClient(textEvents('unused')) })

    const { status } = await postJson(live.url, '/v1/messages', payload)

    expect(status).toBe(400)
  })

  it('rejects an OpenAI tool message with no tool_call_id', async () => {
    live = await startServer({ client: fakeClient(textEvents('unused')) })

    const { status } = await postJson(live.url, '/v1/chat/completions', {
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'tool', content: 'result' }],
    })

    expect(status).toBe(400)
  })
})

describe('credit gating', () => {
  it('refuses chat when credits are exhausted and the flag is set', async () => {
    live = await startServer(
      { client: fakeClient(textEvents('unused')), usage: fakeUsage(okUsage(0)) },
      { credits: { required: true } },
    )

    const { status, body } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(status).toBe(400)
    expect((body as { error: { message: string } }).error.message).toContain('exhausted')
  })

  it('serves anyway when the credit check itself fails', async () => {
    const failed = { ok: false as const, error: 'quota endpoint down', fetchedAt: new Date().toISOString() }
    live = await startServer(
      { client: fakeClient(textEvents('served')), usage: fakeUsage(failed) },
      { credits: { required: true } },
    )

    const { status } = await postJson(live.url, '/v1/messages', anthropicBody())

    expect(status).toBe(200)
  })
})

describe('translation reaches the client', () => {
  it('restores the original tool name on the way out', async () => {
    const events: KiroStreamEvent[] = [
      // The upstream sees the sanitized name; the client must see its own.
      { type: 'tool_use', toolUse: { toolUseId: 'toolu_1', name: 'search_files', input: {} } },
      { type: 'done', inputTokens: 1, outputTokens: 1 },
    ]
    const client = fakeClient(events)
    live = await startServer({ client })

    const { body } = await postJson(live.url, '/v1/messages', anthropicBody({
      // A dot is outside Kiro's allowed tool-name charset, so this is renamed.
      tools: [{ name: 'search.files', description: 'search', input_schema: { type: 'object' } }],
    }))

    expect(client.requests[0]?.toolNameMap.get('search_files')).toBe('search.files')
    // The client sees the name it registered, not the sanitized one.
    const content = (body as { content: { type: string; name?: string }[] }).content
    expect(content.find((block) => block.type === 'tool_use')?.name).toBe('search.files')
  })

  it('sends tools and history in the upstream payload', async () => {
    const client = fakeClient(textEvents('ok'))
    live = await startServer({ client })

    await postJson(live.url, '/v1/messages', {
      model: 'claude-sonnet-4.6',
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'first question about something' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
      tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
    })

    const payload = client.requests[0]?.payload
    expect(payload?.conversationState.history).toHaveLength(2)
    const current = payload?.conversationState.currentMessage.userInputMessage
    expect(current?.userInputMessageContext?.tools).toHaveLength(1)
    // The system prompt rides on the first history turn, since Kiro has no
    // system field.
    const firstTurn = payload?.conversationState.history[0]
    expect(JSON.stringify(firstTurn)).toContain('You are helpful.')
  })
})
