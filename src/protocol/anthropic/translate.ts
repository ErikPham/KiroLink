/**
 * Anthropic Messages → Kiro payload translation.
 */

import type { KiroLinkConfig } from '../../config/config'
import { MAX_OUTPUT_TOKENS } from '../../domain/limits'
import { normalizeModelId } from '../../domain/models'
import type { KiroHistoryEntry, KiroImageBlock, KiroRequest, KiroToolResult, KiroToolUse } from '../../domain/types'
import { InvalidRequestError } from '../../errors'
import {
  assertImageCount,
  extractImageBlock,
  isRecord,
  stringifyToolResultContent,
} from '../content'
import {
  appendTurn,
  buildAssistantHistoryEntry,
  buildEnvState,
  buildUserInputMessage,
  CONTINUATION_TEXT,
  dropOrphanToolResults,
  KIRO_ORIGIN,
  newTurn,
  repairToolResultPairing,
  type ConversationIdAssigner,
  type Turn,
} from '../conversation'
import { buildEffectiveSystem, extractSystemText } from '../system-prompt'
import { buildAdditionalModelRequestFields, isThinkingEnabled } from '../thinking'
import { assertKnownToolResultId, assertValidToolUseId, buildToolSpecs, sanitizeToolName } from '../tools'
import type { AnthropicContentBlock, AnthropicMessage, AnthropicRequest } from './types'

/**
 * Kiro has no native image input on the chat path, but it does accept images
 * attached to a tool result. Images are therefore delivered by synthesizing a
 * prior fs_read tool call whose result carries them — the shape kiro-cli itself
 * produces when the user attaches a file.
 */
const SYNTHETIC_IMAGE_TOOL_NAME = 'fs_read'
const SYNTHETIC_IMAGE_TOOL_RESULT_TEXT = 'See images data supplied'
const SYNTHETIC_IMAGE_PLACEHOLDER_PREFIX = '/tmp/kirolink-image'

export function validateAnthropicRequest(body: unknown): AnthropicRequest {
  if (!isRecord(body)) throw new InvalidRequestError('request body must be a JSON object')

  const model = body['model']
  if (typeof model !== 'string' || !model) throw new InvalidRequestError('model is required')

  const messages = body['messages']
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new InvalidRequestError('messages must be a non-empty array')
  }
  for (const message of messages) {
    if (!isRecord(message)) throw new InvalidRequestError('each message must be an object')
    if (message['role'] !== 'user' && message['role'] !== 'assistant') {
      throw new InvalidRequestError(`unsupported Anthropic message role: ${String(message['role'])}`)
    }
    const content = message['content']
    if (typeof content !== 'string' && !Array.isArray(content)) {
      throw new InvalidRequestError('Anthropic message content must be a string or content block array')
    }
  }

  const tools = body['tools']
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new InvalidRequestError('tools must be an array')
    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool['name'] !== 'string' || !tool['name']) {
        throw new InvalidRequestError('each tool must have a name')
      }
    }
  }

  const system = body['system']
  if (system !== undefined && typeof system !== 'string' && !Array.isArray(system)) {
    throw new InvalidRequestError('system must be a string or an array of text blocks')
  }

  const thinking = body['thinking']
  if (thinking !== undefined) {
    if (!isRecord(thinking) || typeof thinking['type'] !== 'string') {
      throw new InvalidRequestError('thinking must be an object with a type')
    }
    const budget = thinking['budget_tokens']
    if (budget !== undefined && (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 0)) {
      throw new InvalidRequestError('thinking.budget_tokens must be a non-negative integer')
    }
  }

  const stream = body['stream']
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw new InvalidRequestError('stream must be a boolean')
  }

  validateMaxTokens(body['max_tokens'])

  return body as unknown as AnthropicRequest
}

function validateMaxTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_OUTPUT_TOKENS) {
    throw new InvalidRequestError(`max_tokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`)
  }
  return value
}

export function anthropicToKiro(
  request: AnthropicRequest,
  config: KiroLinkConfig,
  conversationIds: ConversationIdAssigner,
): KiroRequest {
  const modelId = normalizeModelId(request.model)
  if (!modelId) throw new InvalidRequestError(`Unsupported model id: ${request.model}`)

  const maxTokens = validateMaxTokens(request.max_tokens)
  const thinking = isThinkingEnabled(request.thinking)
  const effectiveSystem = buildEffectiveSystem(extractSystemText(request.system), {
    thinking,
    translation: config.translation,
  })

  // The synthetic image tool must be declared for the synthesized tool call in
  // history to be valid.
  const declaredTools = hasImageInput(request.messages)
    ? [syntheticImageToolDefinition(), ...(request.tools ?? [])]
    : (request.tools ?? [])
  const { specs, responseNameMap, requestNameMap } = buildToolSpecs(declaredTools, config.limits, 'Anthropic')

  const turns = buildTurns(request.messages, requestNameMap)
  dropOrphanToolResults(turns)
  repairToolResultPairing(turns)

  const history: KiroHistoryEntry[] = []
  for (let i = 0; i < turns.length - 1; i++) {
    const turn = turns[i]!
    if (turn.role !== 'user') {
      history.push(buildAssistantHistoryEntry(turn))
      continue
    }
    // The system prompt rides on the first user turn, since Kiro has no system field.
    const content = i === 0 && effectiveSystem ? joinSystem(effectiveSystem, turn.text) : turn.text
    pushUserTurn(history, turn, content || CONTINUATION_TEXT, modelId)
  }

  const current = turns[turns.length - 1]
  if (!current) throw new InvalidRequestError('messages must be a non-empty array')

  const currentIsUser = current.role === 'user'
  const currentText = currentIsUser ? current.text : ''
  const currentImages = currentIsUser ? current.images : []
  const currentToolResults = currentIsUser ? [...current.toolResults] : []
  const currentToolResultImages = currentIsUser ? current.toolResultImages : []

  // A single-turn conversation, or one whose first turn is an assistant message,
  // has no earlier user turn to carry the system prompt.
  const systemBelongsHere = effectiveSystem !== '' && (turns.length === 1 || turns[0]?.role !== 'user')
  const content = systemBelongsHere ? joinSystem(effectiveSystem, currentText) : currentText || CONTINUATION_TEXT

  const imageToolUse = currentImages.length ? buildSyntheticImageToolUse(currentImages) : undefined
  if (imageToolUse) {
    history.push({ userInputMessage: { content: syntheticImagePlaceholder(currentImages), origin: KIRO_ORIGIN, modelId } })
    history.push({ assistantResponseMessage: { content: '', toolUses: [imageToolUse] } })
    currentToolResults.unshift(buildSyntheticImageToolResult(imageToolUse.toolUseId))
  }

  const images = [...currentImages, ...currentToolResultImages]
  assertImageCount(images.length)

  const payload = {
    conversationState: {
      conversationId: conversationIds.assign(modelId, effectiveSystem, anchorText(request.messages)),
      history,
      currentMessage: {
        userInputMessage: buildUserInputMessage(content, modelId, {
          envState: buildEnvState(),
          tools: specs.length ? specs : undefined,
          toolResults: currentToolResults,
          images,
        }),
      },
      chatTriggerType: 'MANUAL',
    },
    agentMode: 'VIBE' as const,
    additionalModelRequestFields: buildAdditionalModelRequestFields(modelId, request.thinking, config.translation),
    inferenceConfig: maxTokens ? { maxTokens } : undefined,
  }

  return { payload, toolNameMap: responseNameMap }
}

function pushUserTurn(history: KiroHistoryEntry[], turn: Turn, content: string, modelId: string): void {
  const toolResults = [...turn.toolResults]
  let images = [...turn.images, ...turn.toolResultImages]

  if (turn.images.length) {
    const imageToolUse = buildSyntheticImageToolUse(turn.images)
    history.push({ userInputMessage: { content: syntheticImagePlaceholder(turn.images), origin: KIRO_ORIGIN, modelId } })
    history.push({ assistantResponseMessage: { content: '', toolUses: [imageToolUse] } })
    toolResults.unshift(buildSyntheticImageToolResult(imageToolUse.toolUseId))
    images = [...turn.images, ...turn.toolResultImages]
  }

  assertImageCount(images.length)
  // kiro-cli sends history user turns with no envState; omitting it here trims
  // a payload that is re-sent every turn and matches real traffic.
  history.push({ userInputMessage: buildUserInputMessage(content, modelId, { toolResults, images }) })
}

function buildTurns(messages: AnthropicMessage[], requestNameMap: Map<string, string>): Turn[] {
  const turns: Turn[] = []
  const seenToolUseIds = new Set<string>()

  for (const message of messages) {
    const turn = newTurn(message.role, extractText(message.content))
    if (message.role === 'user') {
      turn.images = extractImages(message.content)
      turn.toolResults = extractToolResults(message.content, seenToolUseIds, turn.toolResultImages)
    } else {
      turn.toolUses = extractToolUses(message.content, seenToolUseIds, requestNameMap)
    }
    appendTurn(turns, turn)
  }

  return turns
}

function joinSystem(system: string, text: string): string {
  return text ? `${system}\n\n${text}` : `${system}\n\n${CONTINUATION_TEXT}`
}

function anchorText(messages: AnthropicMessage[]): string {
  const first = messages.find((message) => message.role === 'user')
  return first ? extractText(first.content) : ''
}

function extractText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function extractImages(content: string | AnthropicContentBlock[]): KiroImageBlock[] {
  if (typeof content === 'string') return []
  const blocks = content.filter((block) => block.type === 'image' && 'source' in block)
  assertImageCount(blocks.length)
  return blocks.map(extractImageBlock)
}

function hasImageInput(messages: AnthropicMessage[]): boolean {
  return messages.some((message) =>
    typeof message.content !== 'string' && message.content.some((block) => block.type === 'image'))
}

function extractToolUses(
  content: string | AnthropicContentBlock[],
  seenToolUseIds: Set<string>,
  requestNameMap: Map<string, string>,
): KiroToolUse[] {
  if (typeof content === 'string') return []
  return content
    .filter((block) => block.type === 'tool_use')
    .map((block) => {
      const toolUse = block as { id: string; name: string; input: Record<string, unknown> }
      assertValidToolUseId(toolUse.id, 'Anthropic tool_use')
      if (seenToolUseIds.has(toolUse.id)) {
        throw new InvalidRequestError(`Anthropic tool_use id is duplicated: ${toolUse.id}`)
      }
      seenToolUseIds.add(toolUse.id)
      if (!isRecord(toolUse.input)) {
        throw new InvalidRequestError(`Anthropic tool_use input must be an object: ${toolUse.id}`)
      }
      return {
        toolUseId: toolUse.id,
        name: requestNameMap.get(toolUse.name) ?? sanitizeToolName(toolUse.name),
        input: toolUse.input,
      }
    })
}

function extractToolResults(
  content: string | AnthropicContentBlock[],
  seenToolUseIds: Set<string>,
  images: KiroImageBlock[],
): KiroToolResult[] {
  if (typeof content === 'string') return []
  return content
    .filter((block) => block.type === 'tool_result')
    .map((block) => {
      const result = block as { tool_use_id: string; content: unknown; is_error?: boolean }
      assertKnownToolResultId(result.tool_use_id, seenToolUseIds, 'Anthropic')
      return {
        toolUseId: result.tool_use_id,
        content: [{ text: stringifyToolResultContent(result.content, 'Anthropic', images) }],
        status: result.is_error ? ('error' as const) : ('success' as const),
      }
    })
}

function syntheticImageToolDefinition(): { name: string; description: string; input_schema: unknown } {
  return {
    name: SYNTHETIC_IMAGE_TOOL_NAME,
    description: 'Read image attachments prepared by the client before model analysis.',
    input_schema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['Image'] },
              image_paths: { type: 'array', items: { type: 'string' } },
            },
            required: ['mode', 'image_paths'],
          },
        },
      },
      required: ['operations'],
    },
  }
}

function buildSyntheticImageToolUse(images: KiroImageBlock[]): KiroToolUse {
  return {
    toolUseId: `tooluse_${crypto.randomUUID().replace(/-/gu, '')}`,
    name: SYNTHETIC_IMAGE_TOOL_NAME,
    input: { operations: [{ mode: 'Image', image_paths: imagePaths(images) }] },
  }
}

function buildSyntheticImageToolResult(toolUseId: string): KiroToolResult {
  return { toolUseId, content: [{ text: SYNTHETIC_IMAGE_TOOL_RESULT_TEXT }], status: 'success' }
}

function syntheticImagePlaceholder(images: KiroImageBlock[]): string {
  return imagePaths(images).join('\n')
}

function imagePaths(images: KiroImageBlock[]): string[] {
  return images.map((image, index) => `${SYNTHETIC_IMAGE_PLACEHOLDER_PREFIX}-${index + 1}.${image.format}`)
}
