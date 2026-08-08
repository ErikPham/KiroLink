/**
 * AWS event-stream parsing.
 */

import { describe, expect, it } from 'vitest'
import type { KiroStreamEvent } from '../../src/domain/types'
import { normalizeKiroStreamEvent, normalizeToolInputForClient, parseEventStream } from '../../src/kiro/stream'
import { silentLogger } from '../support/harness'

/** Build a single vnd.amazon.eventstream frame. */
function frame(eventType: string, payload: unknown): Buffer {
  const headerName = Buffer.from(':event-type')
  const headerValue = Buffer.from(eventType)
  const headers = Buffer.concat([
    Buffer.from([headerName.length]),
    headerName,
    // Value type 7 = string, followed by a big-endian uint16 length.
    Buffer.from([7]),
    (() => {
      const len = Buffer.alloc(2)
      len.writeUInt16BE(headerValue.length)
      return len
    })(),
    headerValue,
  ])
  const body = Buffer.from(JSON.stringify(payload))
  const total = 12 + headers.length + body.length + 4
  const buf = Buffer.alloc(total)
  buf.writeUInt32BE(total, 0)
  buf.writeUInt32BE(headers.length, 4)
  // Prelude CRC and message CRC are not validated by the parser.
  buf.writeUInt32BE(0, 8)
  headers.copy(buf, 12)
  body.copy(buf, 12 + headers.length)
  return buf
}

async function collect(chunks: Buffer[]): Promise<KiroStreamEvent[]> {
  const events: KiroStreamEvent[] = []
  const stream = (async function* generate() {
    for (const chunk of chunks) yield chunk
  })()
  await parseEventStream(stream, (event) => { events.push(event) }, silentLogger)
  return events
}

describe('parseEventStream', () => {
  it('emits text and a final done event', async () => {
    const events = await collect([
      frame('assistantResponseEvent', { content: 'Hello' }),
      frame('messageMetadataEvent', { inputTokens: 12, outputTokens: 3 }),
    ])

    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'done', inputTokens: 12, outputTokens: 3 },
    ])
  })

  it('always ends with done, even for an empty stream', async () => {
    const events = await collect([])
    expect(events).toEqual([{ type: 'done', inputTokens: 0, outputTokens: 0 }])
  })

  it('reassembles a frame split across chunks', async () => {
    const full = frame('assistantResponseEvent', { content: 'split me' })
    const events = await collect([full.subarray(0, 7), full.subarray(7)])

    expect(events[0]).toEqual({ type: 'text', text: 'split me' })
  })

  it('handles several frames in one chunk', async () => {
    const events = await collect([Buffer.concat([
      frame('assistantResponseEvent', { content: 'a' }),
      frame('assistantResponseEvent', { content: 'b' }),
    ])])

    expect(events.filter((event) => event.type === 'text')).toHaveLength(2)
  })

  it('converts cumulative text into deltas', async () => {
    // The runtime re-sends the full text so far on some builds.
    const events = await collect([
      frame('assistantResponseEvent', { content: 'Hel' }),
      frame('assistantResponseEvent', { content: 'Hello' }),
      frame('assistantResponseEvent', { content: 'Hello world' }),
    ])

    expect(events.filter((event): event is { type: 'text'; text: string } => event.type === 'text').map((event) => event.text))
      .toEqual(['Hel', 'lo', ' world'])
  })

  it('drops a repeated identical frame', async () => {
    const events = await collect([
      frame('assistantResponseEvent', { content: 'same' }),
      frame('assistantResponseEvent', { content: 'same' }),
    ])

    expect(events.filter((event) => event.type === 'text')).toHaveLength(1)
  })

  it('emits reasoning as thinking', async () => {
    const events = await collect([frame('reasoningContentEvent', { text: 'pondering' })])
    expect(events[0]).toEqual({ type: 'thinking', text: 'pondering' })
  })

  it('coalesces streamed tool input into one tool_use', async () => {
    const events = await collect([
      frame('toolUseEvent', { toolUseId: 'toolu_1', name: 'Read', input: '{"pa' }),
      frame('toolUseEvent', { toolUseId: 'toolu_1', name: 'Read', input: 'th":"a.ts"}', stop: true }),
    ])

    expect(events[0]).toEqual({
      type: 'tool_use',
      toolUse: { toolUseId: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
    })
  })

  it('flushes a tool_use that never received a stop flag', async () => {
    const events = await collect([frame('toolUseEvent', { toolUseId: 'toolu_2', name: 'Bash', input: '{"cmd":"ls"}' })])

    expect(events[0]).toMatchObject({ type: 'tool_use', toolUse: { name: 'Bash' } })
  })

  it('closes the previous tool when a new name arrives', async () => {
    const events = await collect([
      frame('toolUseEvent', { toolUseId: 'toolu_1', name: 'First', input: '{}' }),
      frame('toolUseEvent', { toolUseId: 'toolu_2', name: 'Second', input: '{}', stop: true }),
    ])

    const names = events
      .filter((event): event is Extract<KiroStreamEvent, { type: 'tool_use' }> => event.type === 'tool_use')
      .map((event) => event.toolUse.name)
    expect(names).toEqual(['First', 'Second'])
  })

  it('keeps a tool_use whose input JSON is malformed', async () => {
    const events = await collect([frame('toolUseEvent', { toolUseId: 'toolu_3', name: 'Broken', input: '{bad', stop: true })])

    // The client still learns which tool was invoked.
    expect(events[0]).toEqual({ type: 'tool_use', toolUse: { toolUseId: 'toolu_3', name: 'Broken', input: {} } })
  })

  it('skips a frame with a non-JSON payload', async () => {
    const bad = frame('assistantResponseEvent', { content: 'x' })
    // Corrupt the payload so JSON.parse fails.
    bad.write('!!!!', 12 + bad.readUInt32BE(4))
    const events = await collect([bad, frame('assistantResponseEvent', { content: 'good' })])

    expect(events.filter((event) => event.type === 'text')).toHaveLength(1)
  })

  it('reads usage from a nested usage object', async () => {
    const events = await collect([frame('meteringEvent', { usage: { input_tokens: 7, output_tokens: 9 } })])
    expect(events.at(-1)).toEqual({ type: 'done', inputTokens: 7, outputTokens: 9 })
  })
})

describe('normalizeKiroStreamEvent', () => {
  it('maps PascalCase runtime names onto parser names', () => {
    expect(normalizeKiroStreamEvent('AssistantResponseEvent', {}).eventType).toBe('assistantResponseEvent')
    expect(normalizeKiroStreamEvent('ReasoningEvent', {}).eventType).toBe('reasoningContentEvent')
    expect(normalizeKiroStreamEvent('ToolUseEvent', {}).eventType).toBe('toolUseEvent')
  })

  it('reads the type from a kind field when the header is absent', () => {
    expect(normalizeKiroStreamEvent('', { kind: 'ToolUseEvent' }).eventType).toBe('toolUseEvent')
  })

  it('unwraps a data envelope', () => {
    const result = normalizeKiroStreamEvent('AssistantResponseEvent', { data: { content: 'inner' } })
    expect(result.event).toEqual({ content: 'inner' })
  })
})

describe('normalizeToolInputForClient', () => {
  it('leaves unrelated tools untouched', () => {
    const input = { path: 'a.ts' }
    expect(normalizeToolInputForClient('Read', input)).toBe(input)
  })

  it('reshapes a bare question plus options into the client schema', () => {
    const result = normalizeToolInputForClient('AskUserQuestion', {
      question: 'Pick one',
      options: ['First', 'Second'],
    })

    const questions = (result as { questions: { question: string; header: string; options: unknown[] }[] }).questions
    expect(questions[0]?.question).toBe('Pick one?')
    expect(questions[0]?.header.length).toBeLessThanOrEqual(12)
    expect(questions[0]?.options).toHaveLength(2)
  })

  it('accepts choices as an alias for options', () => {
    const result = normalizeToolInputForClient('AskUserQuestion', {
      questions: [{ question: 'Which?', choices: [{ label: 'A' }, { label: 'B' }] }],
    })

    const questions = (result as { questions: { options: { label: string }[] }[] }).questions
    expect(questions[0]?.options.map((option) => option.label)).toEqual(['A', 'B'])
  })

  it('omits keys the client schema does not allow', () => {
    const result = normalizeToolInputForClient('AskUserQuestion', {
      questions: [{ id: 'Deploy Target!', question: 'Where?', options: [{ label: 'A' }, { label: 'B' }] }],
    })

    const questions = (result as { questions: Record<string, unknown>[] }).questions
    expect(Object.keys(questions[0]!).sort()).toEqual(['header', 'multiSelect', 'options', 'question'])
  })

  it('pads a single option up to the schema minimum', () => {
    const result = normalizeToolInputForClient('AskUserQuestion', { question: 'Only one?', options: ['A'] })

    const options = (result as { questions: { options: { label: string }[] }[] }).questions[0]!.options
    expect(options.length).toBeGreaterThanOrEqual(2)
    expect(options[0]?.label).toBe('A')
  })

  it('reshapes flat input even when questions is an empty array', () => {
    const result = normalizeToolInputForClient('AskUserQuestion', {
      questions: [],
      question: 'Pick?',
      options: ['A', 'B'],
    })

    const questions = (result as { questions: { question: string }[] }).questions
    expect(questions).toHaveLength(1)
    expect(questions[0]?.question).toBe('Pick?')
  })

  it('caps questions at four', () => {
    const result = normalizeToolInputForClient('AskUserQuestion', {
      questions: Array.from({ length: 6 }, (_, index) => ({
        question: `Q${index}?`,
        options: ['A', 'B'],
      })),
    })

    expect((result as { questions: unknown[] }).questions).toHaveLength(4)
  })

  it('caps options at four', () => {
    const result = normalizeToolInputForClient('AskUserQuestion', {
      question: 'Many?',
      options: ['a', 'b', 'c', 'd', 'e', 'f'],
    })

    expect((result as { questions: { options: unknown[] }[] }).questions[0]?.options).toHaveLength(4)
  })
})
