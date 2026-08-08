/**
 * AWS Event Stream (vnd.amazon.eventstream) parser for Kiro's streaming
 * response, normalizing frames into KiroStreamEvent values and coalescing
 * streamed tool_use input chunks into complete tool calls.
 */

import type { KiroStreamEvent } from '../domain/types'
import type { Logger } from '../logging/logger'

/** Prelude: total length (4) + headers length (4) + prelude CRC (4). */
const PRELUDE_BYTES = 12
/** Prelude plus the trailing message CRC (4). */
const FRAME_OVERHEAD_BYTES = 16

/** Cardinality limits from the client's AskUserQuestion schema. */
const MAX_QUESTIONS = 4
const MIN_OPTIONS = 2
const MAX_OPTIONS = 4
const FALLBACK_OPTIONS = [
  { label: 'Yes', description: 'Proceed with this option.' },
  { label: 'No', description: 'Do not proceed with this option.' },
]

type ToolUseAccumulator = { toolUseId: string; name: string; inputBuf: string }

export async function parseEventStream(
  stream: AsyncIterable<Buffer | string>,
  onEvent: (event: KiroStreamEvent) => void,
  logger: Logger,
): Promise<void> {
  let inputTokens = 0
  let outputTokens = 0
  let currentToolUse: ToolUseAccumulator | null = null
  // The runtime re-sends the full text so far on some frames rather than a
  // delta; `deltaOf` reconciles both shapes against the previous value.
  let lastAssistantContent = ''
  let lastReasoningContent = ''
  let buffer = Buffer.alloc(0)

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])

    while (buffer.length >= PRELUDE_BYTES) {
      const totalLength = buffer.readUInt32BE(0)
      if (totalLength < FRAME_OVERHEAD_BYTES) {
        logger.log('debug', 'skipping frame with invalid length', { totalLength })
        buffer = buffer.subarray(4)
        continue
      }
      if (buffer.length < totalLength) break

      const headersLength = buffer.readUInt32BE(4)
      if (headersLength > totalLength - FRAME_OVERHEAD_BYTES) {
        logger.log('debug', 'skipping frame with invalid headers length', { headersLength })
        buffer = buffer.subarray(totalLength)
        continue
      }

      const headersBuf = buffer.subarray(PRELUDE_BYTES, PRELUDE_BYTES + headersLength)
      const payloadBuf = buffer.subarray(PRELUDE_BYTES + headersLength, totalLength - 4)
      buffer = buffer.subarray(totalLength)

      if (!payloadBuf.length) continue

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(payloadBuf.toString()) as Record<string, unknown>
      } catch {
        logger.log('debug', 'skipping frame with non-JSON payload')
        continue
      }

      const { eventType, event } = normalizeKiroStreamEvent(extractEventType(headersBuf), parsed)

      const usage = findUsage(event)
      if (usage) {
        inputTokens = readTokenCount(usage, inputTokens, 'inputTokens', 'input_tokens', 'uncached_input_tokens')
        outputTokens = readTokenCount(usage, outputTokens, 'outputTokens', 'output_tokens')
      }

      switch (eventType) {
        case 'assistantResponseEvent': {
          const content = readStringField(event, 'content')
          if (content) {
            const delta = deltaOf(content, lastAssistantContent)
            lastAssistantContent = content
            if (delta) onEvent({ type: 'text', text: delta })
          }
          break
        }
        case 'reasoningContentEvent': {
          const text = readStringField(event, 'text', 'content', 'reasoningContent', 'reasoning_content')
          if (text) {
            const delta = deltaOf(text, lastReasoningContent)
            lastReasoningContent = text
            if (delta) onEvent({ type: 'thinking', text: delta })
          }
          break
        }
        case 'toolUseEvent': {
          currentToolUse = accumulateToolUse(event, currentToolUse, onEvent)
          break
        }
        default:
          break
      }
    }
  }

  if (currentToolUse) emitToolUse(currentToolUse, onEvent)
  onEvent({ type: 'done', inputTokens, outputTokens })
}

/**
 * Fold one toolUseEvent frame into the in-progress tool call. A frame with a
 * different name than the one in progress means the previous call ended without
 * an explicit stop, so it is emitted before starting the new one.
 */
function accumulateToolUse(
  event: Record<string, unknown>,
  current: ToolUseAccumulator | null,
  onEvent: (event: KiroStreamEvent) => void,
): ToolUseAccumulator | null {
  const toolUseId = readStringField(event, 'toolUseId', 'tool_use_id') ?? ''
  const name = readStringField(event, 'name') ?? ''
  const stop = event['stop'] === true
  const input = event['input']

  let accumulator = current
  if (name && !accumulator) {
    accumulator = newToolUse(toolUseId, name)
  } else if (name && accumulator && accumulator.name !== name) {
    emitToolUse(accumulator, onEvent)
    accumulator = newToolUse(toolUseId, name)
  }

  if (accumulator && input !== undefined && input !== null) {
    accumulator.inputBuf += typeof input === 'string' ? input : JSON.stringify(input)
  }

  if (stop && accumulator) {
    emitToolUse(accumulator, onEvent)
    return null
  }
  return accumulator
}

function newToolUse(toolUseId: string, name: string): ToolUseAccumulator {
  return { toolUseId: toolUseId || `toolu_${crypto.randomUUID()}`, name, inputBuf: '' }
}

function emitToolUse(accumulator: ToolUseAccumulator, onEvent: (event: KiroStreamEvent) => void): void {
  let input: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(accumulator.inputBuf) as unknown
    if (isRecord(parsed)) input = parsed
  } catch {
    // A truncated or malformed input buffer yields an empty object rather than
    // dropping the tool call: the client still learns which tool was invoked.
  }
  onEvent({
    type: 'tool_use',
    toolUse: {
      toolUseId: accumulator.toolUseId,
      name: accumulator.name,
      input: normalizeToolInputForClient(accumulator.name, input),
    },
  })
}

/**
 * Map the runtime's PascalCase event names and `{kind, data}` envelope onto the
 * camelCase names the parser switches on. Both shapes occur depending on the
 * runtime build.
 */
export function normalizeKiroStreamEvent(
  eventType: string,
  event: Record<string, unknown>,
): { eventType: string; event: Record<string, unknown> } {
  let normalizedType = eventType
  if (!normalizedType && typeof event['kind'] === 'string') normalizedType = event['kind']
  const normalizedEvent = isRecord(event['data']) ? event['data'] : event

  const alias: Record<string, string> = {
    AssistantResponseEvent: 'assistantResponseEvent',
    ReasoningEvent: 'reasoningContentEvent',
    ToolUseEvent: 'toolUseEvent',
    MessageMetadataEvent: 'messageMetadataEvent',
    ContextUsageEvent: 'contextUsageEvent',
    MeteringEvent: 'meteringEvent',
  }

  return { eventType: alias[normalizedType] ?? normalizedType, event: normalizedEvent }
}

/**
 * Reshape AskUserQuestion tool input into the schema Claude Code expects.
 * The runtime emits several looser shapes (a bare question plus options, or
 * options as plain strings); clients reject anything that does not match their
 * own schema, so normalize rather than pass through.
 *
 * The client schema is strict: each question allows only question/header/
 * options/multiSelect, and requires 1-4 questions with 2-4 options each. Any
 * extra key or out-of-range count is rejected as invalid tool parameters.
 */
export function normalizeToolInputForClient(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!isAskUserQuestionTool(name)) return input

  const rawQuestions = readArray(input, 'questions') ?? []
  const questions = rawQuestions
    .slice(0, MAX_QUESTIONS)
    .map((question, index) => normalizeAskUserQuestion(isRecord(question) ? question : { question: String(question) }, index))

  // An absent or empty questions array means the runtime used the flat shape,
  // where the question and options sit directly on the input.
  return { questions: questions.length ? questions : [normalizeAskUserQuestion(input, 0)] }
}

function isAskUserQuestionTool(name: string): boolean {
  return name === 'AskUserQuestion' || name === 'askUserQuestion' || name === 'ask_user_question' || name === 'ask_user'
}

function normalizeAskUserQuestion(record: Record<string, unknown>, index: number): {
  question: string
  header: string
  options: { label: string; description: string; preview?: string }[]
  multiSelect: boolean
} {
  const text = readString(record, 'question') ?? readString(record, 'prompt') ?? `Please choose an option (${index + 1})?`
  const rawOptions = readArray(record, 'options') ?? readArray(record, 'choices') ?? []
  return {
    question: ensureQuestionMark(text),
    header: shortHeader(readString(record, 'header') ?? text),
    options: padAskUserOptions(normalizeAskUserOptions(rawOptions)),
    multiSelect: record['multiSelect'] === true || record['multi_select'] === true,
  }
}

/**
 * The client requires at least two options. Rather than emit a payload it is
 * guaranteed to reject, top up with neutral choices that do not presume an
 * answer; the client always offers a free-text "Other" alongside them.
 */
function padAskUserOptions(
  options: { label: string; description: string; preview?: string }[],
): { label: string; description: string; preview?: string }[] {
  if (options.length >= MIN_OPTIONS) return options

  const padded = [...options]
  for (const fallback of FALLBACK_OPTIONS) {
    if (padded.length >= MIN_OPTIONS) break
    if (!padded.some((option) => option.label === fallback.label)) padded.push({ ...fallback })
  }
  return padded
}

function normalizeAskUserOptions(rawOptions: unknown[]): { label: string; description: string; preview?: string }[] {
  return rawOptions.slice(0, MAX_OPTIONS).map((option, index) => {
    if (typeof option === 'string') return { label: shortLabel(option, index), description: option }
    if (isRecord(option)) {
      const label = shortLabel(
        readString(option, 'label') ?? readString(option, 'title') ?? readString(option, 'value') ?? `Option ${index + 1}`,
        index,
      )
      const description = readString(option, 'description') ?? readString(option, 'detail') ?? label
      const preview = readString(option, 'preview')
      return preview ? { label, description, preview } : { label, description }
    }
    return { label: `Option ${index + 1}`, description: String(option) }
  })
}

/**
 * Reconcile a frame against the previous value: the runtime sometimes sends
 * cumulative text and sometimes a delta, and may re-send an overlapping suffix.
 */
function deltaOf(chunk: string, previous: string): string {
  if (!previous) return chunk
  if (chunk === previous) return ''
  if (chunk.startsWith(previous)) return chunk.slice(previous.length)
  for (let i = Math.min(previous.length, chunk.length); i > 0; i--) {
    if (previous.endsWith(chunk.slice(0, i))) return chunk.slice(i)
  }
  return chunk
}

/** Byte widths of the fixed-size event-stream header value types. */
const HEADER_VALUE_SIZES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
const HEADER_TYPE_STRING = 7
const HEADER_TYPE_BYTES = 6

function extractEventType(headers: Buffer): string {
  let offset = 0
  while (offset < headers.length) {
    const nameLen = headers[offset]!
    offset++
    if (offset + nameLen > headers.length) break
    const name = headers.subarray(offset, offset + nameLen).toString()
    offset += nameLen
    if (offset >= headers.length) break
    const valueType = headers[offset]!
    offset++

    if (valueType === HEADER_TYPE_STRING || valueType === HEADER_TYPE_BYTES) {
      if (offset + 2 > headers.length) break
      const valueLen = headers.readUInt16BE(offset)
      offset += 2
      if (offset + valueLen > headers.length) break
      if (valueType === HEADER_TYPE_STRING && name === ':event-type') {
        return headers.subarray(offset, offset + valueLen).toString()
      }
      offset += valueLen
      continue
    }

    offset += HEADER_VALUE_SIZES[valueType] ?? 0
  }
  return ''
}

function findUsage(event: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof event['inputTokens'] === 'number' || typeof event['input_tokens'] === 'number' || typeof event['output_tokens'] === 'number') {
    return event
  }
  if (isRecord(event['usage'])) return event['usage']
  if (isRecord(event['metadata'])) return event['metadata']
  return null
}

function readTokenCount(source: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number') return value
  }
  return fallback
}

function readStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key]
  return Array.isArray(value) ? value : undefined
}

function shortHeader(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 12) || 'Question'
}

function shortLabel(value: string, index: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 40) || `Option ${index + 1}`
}

function ensureQuestionMark(value: string): string {
  const trimmed = value.trim()
  return /[?？]$/u.test(trimmed) ? trimmed : `${trimmed}?`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
