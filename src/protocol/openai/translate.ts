/**
 * OpenAI Chat Completions → Kiro payload translation.
 */

import type { KiroLinkConfig } from '../../config/config'
import { MAX_OUTPUT_TOKENS } from '../../domain/limits'
import { normalizeModelId } from '../../domain/models'
import type { KiroHistoryEntry, KiroRequest, KiroToolUse } from '../../domain/types'
import { InvalidRequestError } from '../../errors'
import { isRecord, stringifyToolResultContent } from '../content'
import {
  appendTurn,
  buildAssistantHistoryEntry,
  buildEnvState,
  buildUserInputMessage,
  CONTINUATION_TEXT,
  dropOrphanToolResults,
  newTurn,
  repairToolResultPairing,
  type ConversationIdAssigner,
  type Turn,
} from '../conversation'
import { buildEffectiveSystem } from '../system-prompt'
import { buildAdditionalModelRequestFields, effortToBudget } from '../thinking'
import { assertKnownToolResultId, assertValidToolUseId, buildToolSpecs, sanitizeToolName } from '../tools'
import type { OpenAIMessage, OpenAIRequest } from './types'

/** Text used for a turn that exists only to carry tool results. */
const TOOL_RESULT_TURN_TEXT = 'Here are the tool results.'

export function validateOpenAIRequest(body: unknown): OpenAIRequest {
  if (!isRecord(body)) throw new InvalidRequestError('request body must be a JSON object')

  const model = body['model']
  if (typeof model !== 'string' || !model) throw new InvalidRequestError('model is required')

  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new InvalidRequestError('messages must be a non-empty array')
  }
  for (const message of messages) {
    if (!isRecord(message)) throw new InvalidRequestError('each message must be an object')
    const role = message['role']
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new InvalidRequestError(`unsupported OpenAI message role: ${String(role)}`)
    }
    if (role === 'tool' && !message['tool_call_id']) {
      throw new InvalidRequestError('OpenAI tool message is missing tool_call_id')
    }
    const toolCalls = message['tool_calls']
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
      throw new InvalidRequestError('tool_calls must be an array')
    }
  }

  const tools = body['tools']
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new InvalidRequestError('tools must be an array')
    for (const tool of tools) {
      if (!isRecord(tool) || !isRecord(tool['function']) || typeof tool['function']['name'] !== 'string') {
        throw new InvalidRequestError('each tool must have a function with a name')
      }
    }
  }

  const stream = body['stream']
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw new InvalidRequestError('stream must be a boolean')
  }

  const effort = body['reasoning_effort']
  if (effort !== undefined && typeof effort !== 'string') {
    throw new InvalidRequestError('reasoning_effort must be a string')
  }

  validateMaxTokens(body['max_tokens'])

  return body as unknown as OpenAIRequest
}

function validateMaxTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_OUTPUT_TOKENS) {
    throw new InvalidRequestError(`max_tokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`)
  }
  return value
}

export function openaiToKiro(
  request: OpenAIRequest,
  config: KiroLinkConfig,
  conversationIds: ConversationIdAssigner,
): KiroRequest {
  const modelId = normalizeModelId(request.model)
  if (!modelId) throw new InvalidRequestError(`Unsupported model id: ${request.model}`)

  const maxTokens = validateMaxTokens(request.max_tokens)
  const { specs, responseNameMap, requestNameMap } = buildToolSpecs(
    (request.tools ?? []).map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    })),
    config.limits,
    'OpenAI',
  )

  // OpenAI carries system messages inline; Kiro has no system field, so they are
  // collected and prepended to the current turn.
  const systemParts: string[] = []
  const conversation: OpenAIMessage[] = []
  for (const message of request.messages) {
    if (message.role === 'system') systemParts.push(message.content ?? '')
    else conversation.push(message)
  }
  const systemText = systemParts.join('\n').trim()

  const thinking = request.reasoning_effort
    ? { type: 'enabled', budget_tokens: effortToBudget(request.reasoning_effort) }
    : undefined
  const effectiveSystem = buildEffectiveSystem(systemText, {
    thinking: thinking !== undefined,
    translation: config.translation,
  })

  const turns = buildTurns(conversation, requestNameMap)
  dropOrphanToolResults(turns)
  repairToolResultPairing(turns)

  const history: KiroHistoryEntry[] = []
  for (let i = 0; i < turns.length - 1; i++) {
    const turn = turns[i]!
    if (turn.role === 'user') {
      history.push({
        userInputMessage: buildUserInputMessage(turn.text || CONTINUATION_TEXT, modelId, { toolResults: turn.toolResults }),
      })
    } else {
      history.push(buildAssistantHistoryEntry(turn))
    }
  }

  const current = turns[turns.length - 1]
  if (!current) throw new InvalidRequestError('OpenAI messages must include at least one non-system message')

  const currentIsUser = current.role === 'user'
  const currentText = currentIsUser ? current.text : ''
  const toolResults = currentIsUser ? current.toolResults : []
  const body = currentText || CONTINUATION_TEXT
  const content = effectiveSystem ? `${effectiveSystem}\n\n${body}` : body

  const payload = {
    conversationState: {
      conversationId: conversationIds.assign(modelId, effectiveSystem, anchorText(conversation)),
      history,
      currentMessage: {
        userInputMessage: buildUserInputMessage(content, modelId, {
          envState: buildEnvState(),
          tools: specs.length ? specs : undefined,
          toolResults,
        }),
      },
      chatTriggerType: 'MANUAL',
    },
    agentMode: 'VIBE' as const,
    additionalModelRequestFields: buildAdditionalModelRequestFields(modelId, thinking, config.translation),
    inferenceConfig: maxTokens ? { maxTokens } : undefined,
  }

  return { payload, toolNameMap: responseNameMap }
}

function buildTurns(messages: OpenAIMessage[], requestNameMap: Map<string, string>): Turn[] {
  const turns: Turn[] = []
  const seenToolUseIds = new Set<string>()

  for (const message of messages) {
    const turn = toTurn(message, seenToolUseIds, requestNameMap)
    if (!turn) continue
    // A tool-result turn must not merge with a plain user turn, or the results
    // would be reordered relative to the tool uses they answer.
    appendTurn(turns, turn, { separateToolResults: true })
  }

  return turns
}

function toTurn(
  message: OpenAIMessage,
  seenToolUseIds: Set<string>,
  requestNameMap: Map<string, string>,
): Turn | undefined {
  switch (message.role) {
    case 'user': {
      return newTurn('user', message.content ?? '')
    }
    case 'assistant': {
      const turn = newTurn('assistant', message.content ?? '')
      turn.toolUses = extractToolCalls(message.tool_calls ?? [], seenToolUseIds, requestNameMap)
      return turn
    }
    case 'tool': {
      assertKnownToolResultId(message.tool_call_id, seenToolUseIds, 'OpenAI')
      const turn = newTurn('user', TOOL_RESULT_TURN_TEXT)
      turn.toolResults = [{
        toolUseId: message.tool_call_id!,
        content: [{ text: stringifyToolResultContent(message.content ?? '', 'OpenAI') }],
        status: 'success',
      }]
      return turn
    }
    default:
      return undefined
  }
}

function extractToolCalls(
  toolCalls: NonNullable<OpenAIMessage['tool_calls']>,
  seenToolUseIds: Set<string>,
  requestNameMap: Map<string, string>,
): KiroToolUse[] {
  return toolCalls.map((call) => {
    assertValidToolUseId(call.id, 'OpenAI tool_call')
    if (seenToolUseIds.has(call.id)) {
      throw new InvalidRequestError(`OpenAI tool_call id is duplicated: ${call.id}`)
    }
    seenToolUseIds.add(call.id)
    return {
      toolUseId: call.id,
      name: requestNameMap.get(call.function.name) ?? sanitizeToolName(call.function.name),
      input: parseToolArguments(call.function.arguments, call.id),
    }
  })
}

function parseToolArguments(value: string, id: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new InvalidRequestError(`OpenAI tool_call arguments must be a JSON object: ${id}`)
  }
}

function anchorText(messages: OpenAIMessage[]): string {
  return messages.find((message) => message.role === 'user')?.content ?? ''
}
