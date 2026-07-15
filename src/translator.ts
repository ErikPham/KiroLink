import { createHash, randomUUID } from 'node:crypto'
import type { KiroPayload, KiroToolUse } from './kiro-api'
import { InvalidRequestError } from './errors'

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: string; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking'; thinking: string }
  | { type: string; [key: string]: unknown }

export type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }

export type AnthropicRequest = {
  model: string
  max_tokens?: number
  stream?: boolean
  thinking?: { type: string; budget_tokens?: number }
  system?: string | { type: string; text: string }[]
  messages?: AnthropicMessage[]
  tools?: { name: string; description: string; input_schema: unknown }[]
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u
const MODEL_ID_PATTERN = /^claude-(?:opus|sonnet|haiku)-\d+(?:\.\d+)?$/u
const DEFAULT_MAX_TOOLS = 256
const DEFAULT_MAX_TOOL_SCHEMA_BYTES = 128 * 1024
const DEFAULT_MAX_TOTAL_TOOL_SCHEMA_BYTES = 768 * 1024
const MAX_TOOL_RESULT_TEXT_BYTES = 128 * 1024
const MAX_OUTPUT_TOKENS = 100_000
const MAX_IMAGES = 20
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const EFFORT_MODELS = new Set(['claude-opus-4.7', 'claude-opus-4.6', 'claude-sonnet-4.6'])

// Fallback only. Prefer additionalModelRequestFields; prompt injection is opt-in.
const THINKING_PROMPT = 'enabled 200000'

// kiro-cli sends origin "KIRO_CLI" (not "AI_EDITOR" which is the IDE)
const KIRO_ORIGIN = 'KIRO_CLI'
const SYNTHETIC_IMAGE_TOOL_NAME = 'fs_read'
const SYNTHETIC_IMAGE_TOOL_RESULT_TEXT = 'See images data supplied'
const SYNTHETIC_IMAGE_PLACEHOLDER_PREFIX = '/tmp/kirolink-image'
const TOOL_RESULT_IMAGE_PLACEHOLDER = '[Tool returned an image; the image is attached to this message.]'

type KiroImage = { format: string; source: { bytes: string } }

function buildEnvState(): Record<string, string> {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  return { operatingSystem: os, currentWorkingDirectory: process.cwd() }
}

export function anthropicToKiro(req: AnthropicRequest): KiroPayload {
  const messages = validateAnthropicRequest(req)
  const modelId = mapModelId(req.model)
  const maxTokens = validateMaxTokens(req.max_tokens)
  const systemText = extractSystem(req.system)
  const thinking = req.thinking?.type === 'enabled' || req.thinking?.type === 'adaptive'
  const filtered = filterSystemPrompt(systemText)
  const effectiveSystem = thinking && shouldInjectThinkingPrompt() ? `${THINKING_PROMPT}\n\n${filtered}` : filtered
  const requestedTools = hasAnthropicImageInput(messages)
    ? [syntheticImageToolDefinition(), ...(req.tools ?? [])]
    : (req.tools ?? [])
  const { specs: tools, responseNameMap: toolNameMap, requestNameMap } = buildToolSpecs(requestedTools, 'Anthropic')
  const seenToolUseIds = new Set<string>()

  // Flatten messages into alternating user/assistant for Kiro history
  // Claude Code sends: user, assistant(tool_use), user(tool_result), assistant, ...
  // Kiro expects: strict alternating userInputMessage / assistantResponseMessage
  const flat: { role: 'user' | 'assistant'; text: string; images: KiroImage[]; nativeImages: KiroImage[]; toolUses: KiroToolUse[]; toolResults: unknown[] }[] = []

  for (const msg of messages) {
    const text = extractText(msg.content)
    const images = msg.role === 'user' ? extractImages(msg.content) : []
    const nativeImages: KiroImage[] = []
    const toolUses = msg.role === 'assistant' ? extractToolUses(msg.content, seenToolUseIds, requestNameMap) : []
    const toolResults = msg.role === 'user' ? extractToolResults(msg.content, seenToolUseIds, 'Anthropic', nativeImages) : []

    // Merge consecutive same-role messages
    const last = flat[flat.length - 1]
    if (last && last.role === msg.role) {
      if (text) last.text += '\n' + text
      last.images.push(...images)
      last.nativeImages.push(...nativeImages)
      last.toolUses.push(...toolUses)
      last.toolResults.push(...toolResults)
    } else {
      flat.push({ role: msg.role, text, images, nativeImages, toolUses, toolResults })
    }
  }
  repairMissingToolResults(flat, (toolResults) => ({ role: 'user', text: 'Continue.', images: [], nativeImages: [], toolUses: [], toolResults }))

  // Build history from all except last entry
  const history: unknown[] = []
  for (let i = 0; i < flat.length - 1; i++) {
    const entry = flat[i]!
    if (entry.role === 'user') {
      const imageToolUse = entry.images.length ? buildSyntheticImageToolUse(entry.images) : undefined
      if (imageToolUse) {
        history.push({ userInputMessage: { content: syntheticImagePlaceholderContent(entry.images), origin: KIRO_ORIGIN, modelId } })
        history.push({ assistantResponseMessage: { content: '', toolUses: [imageToolUse] } })
      }
      const content = i === 0 && effectiveSystem ? `${effectiveSystem}\n\n${entry.text}` : entry.text
      const toolResults = imageToolUse ? [buildSyntheticImageToolResult(imageToolUse.toolUseId), ...entry.toolResults] : entry.toolResults
      // Kiro CLI sends history user turns with user_input_message_context = null;
      // only attach context when it carries tool results that must pair with a
      // prior assistant tool use. Omitting envState here trims the payload that is
      // re-sent every turn and keeps the shape closer to real Kiro CLI traffic.
      const uim: Record<string, unknown> = { content: content || 'Continue.', origin: KIRO_ORIGIN, modelId }
      if (toolResults.length) uim['userInputMessageContext'] = { toolResults }
      // Match current-turn behavior: top-level message images + images extracted
      // from tool_result blocks must both stay attached on multi-turn history.
      const historyImages = [...entry.images, ...entry.nativeImages]
      if (historyImages.length > MAX_IMAGES) throw new InvalidRequestError(`image count exceeds ${MAX_IMAGES}`)
      if (historyImages.length) uim['images'] = historyImages
      history.push({ userInputMessage: uim })
    } else {
      history.push({ assistantResponseMessage: { content: entry.text, toolUses: entry.toolUses } })
    }
  }

  // Last entry = current message
  const last = flat[flat.length - 1]
  const userContent = last?.role === 'user' ? last.text : ''
  const currentImages = last?.role === 'user' ? last.images : []
  const currentNativeImages = last?.role === 'user' ? last.nativeImages : []
  const lastToolResults = last?.role === 'user' ? last.toolResults : []
  const currentImageToolUse = last?.role === 'user' && currentImages.length ? buildSyntheticImageToolUse(currentImages) : undefined
  if (currentImageToolUse) {
    history.push({ userInputMessage: { content: syntheticImagePlaceholderContent(currentImages), origin: KIRO_ORIGIN, modelId } })
    history.push({ assistantResponseMessage: { content: '', toolUses: [currentImageToolUse] } })
  }
  const fullContent = (flat.length === 1 || flat[0]?.role !== 'user') && effectiveSystem
    ? `${effectiveSystem}\n\n${userContent}`
    : userContent || 'Continue.'

  const userMsgCtx: Record<string, unknown> = { envState: buildEnvState() }
  if (tools.length) userMsgCtx['tools'] = tools
  const currentToolResults = currentImageToolUse ? [buildSyntheticImageToolResult(currentImageToolUse.toolUseId), ...lastToolResults] : lastToolResults
  if (currentToolResults.length) userMsgCtx['toolResults'] = currentToolResults

  const currentUim: Record<string, unknown> = { content: fullContent, userInputMessageContext: userMsgCtx, origin: KIRO_ORIGIN, modelId }
  const combinedImages = [...currentImages, ...currentNativeImages]
  if (combinedImages.length > MAX_IMAGES) throw new InvalidRequestError(`image count exceeds ${MAX_IMAGES}`)
  if (combinedImages.length) currentUim['images'] = combinedImages

  const anchorMessage = messages.find((m) => m.role === 'user')
  const anchor = anchorMessage ? extractText(anchorMessage.content) : ''

  return {
    conversationState: {
      conversationId: stableConversationId(modelId, effectiveSystem, anchor),
      history,
      currentMessage: { userInputMessage: currentUim },
      chatTriggerType: 'MANUAL',
    },
    profileArn: '',
    agentMode: 'VIBE',
    additionalModelRequestFields: buildAdditionalModelRequestFields(modelId, req.thinking),
    inferenceConfig: maxTokens ? { maxTokens } : undefined,
    toolNameMap: toolNameMap.size > 0 ? toolNameMap : undefined,
  }
}

// Kiro CLI assigns a fresh RANDOM conversationId when a session starts and keeps
// it stable for every turn of that session (confirmed from real Kiro CLI runtime
// recordings: each invocation uses a different random UUID, history user turns have
// context=null / model_id=null, agent_continuation_id=null). The backend rewards a
// stable id with prefix-cache reuse (observed TTFB dropping across turns).
//
// We are stateless per HTTP request, so to reproduce Kiro CLI exactly we remember a
// random id per conversation in-process, keyed by the conversation's immutable
// anchor (model + system + first user message). This mirrors Kiro CLI (random id,
// stable within a session) without deriving a globally-deterministic id. Short,
// empty (e.g. image-only first turn), or synthetic first texts are collision-prone
// and get an ephemeral random id that is never stored or shared. Set
// KIRO_PROXY_RANDOM_CONVERSATION_ID=1 to force pure random everywhere.
const MIN_ANCHOR_LENGTH = 32
const CONVERSATION_CACHE_MAX = 1000
const conversationIdCache = new Map<string, string>() // anchor fingerprint -> random conversationId

function stableConversationId(modelId: string, system: string, firstText: string): string {
  if (process.env['KIRO_PROXY_RANDOM_CONVERSATION_ID'] === '1') return randomUUID()
  const anchor = firstText.replace(/\s+/gu, ' ').trim()
  if (anchor.length < MIN_ANCHOR_LENGTH || isSyntheticConversationAnchor(anchor)) return randomUUID()

  const key = createHash('sha1')
    .update(modelId).update('\n')
    .update(system.trim()).update('\n')
    .update(anchor.slice(0, 4096))
    .digest('hex')

  const existing = conversationIdCache.get(key)
  if (existing !== undefined) {
    // Refresh recency (Map preserves insertion order → move to newest).
    conversationIdCache.delete(key)
    conversationIdCache.set(key, existing)
    return existing
  }

  const id = randomUUID()
  conversationIdCache.set(key, id)
  if (conversationIdCache.size > CONVERSATION_CACHE_MAX) {
    const oldest = conversationIdCache.keys().next().value
    if (oldest !== undefined) conversationIdCache.delete(oldest)
  }
  return id
}

function isSyntheticConversationAnchor(anchor: string): boolean {
  switch (anchor.toLowerCase()) {
    case '':
    case '.':
    case 'continue.':
    case 'begin conversation':
      return true
    default:
      return false
  }
}

function mapModelId(model: string): string {
  if (typeof model !== 'string' || !model) throw new InvalidRequestError('model is required')
  let id = model.replace(/\[1m\]$/u, '').replace(/-\d{8}$/u, '')
  id = id.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)$/u, '$1.$2')
  id = id.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)-\d{8}$/u, '$1.$2')
  if (!MODEL_ID_PATTERN.test(id)) throw new InvalidRequestError(`Unsupported model id: ${model}`)
  return id
}

function extractSystem(system: AnthropicRequest['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.map((b) => b.text).filter(Boolean).join('\n')
}

const CLAUDE_CODE_MARKERS = [
  'you are an interactive agent',
  '# doing tasks',
  '# using your tools',
  '# tone and style',
  'claude code',
]

const COMPACT_SYSTEM = `You are a coding assistant. Be concise and actionable. Use tools when available. Follow the user's instructions precisely.`

/** Optionally strip Claude Code's bloated system prompt. Default preserves client behavior. */
function filterSystemPrompt(system: string): string {
  if (!system || process.env['KIRO_PROXY_FILTER_SYSTEM_PROMPT'] !== '1' || process.env['KIRO_PROXY_NO_PROMPT_FILTER'] === '1') return system
  const lower = system.toLowerCase()
  let matches = 0
  for (const marker of CLAUDE_CODE_MARKERS) {
    if (lower.includes(marker)) matches++
  }
  // If ≥2 markers match, it's Claude Code's system prompt → replace
  if (matches >= 2) return COMPACT_SYSTEM
  return system
}

function extractText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content
  return content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n')
}

function extractImages(content: string | AnthropicContentBlock[]): KiroImage[] {
  if (typeof content === 'string') return []
  const imageBlocks = content.filter((b) => b.type === 'image' && 'source' in b)
  if (imageBlocks.length > MAX_IMAGES) throw new InvalidRequestError(`image count exceeds ${MAX_IMAGES}`)

  return imageBlocks.map(extractImageBlock)
}

function hasAnthropicImageInput(messages: AnthropicMessage[]): boolean {
  return messages.some((msg) => typeof msg.content !== 'string' && msg.content.some((block) => block.type === 'image'))
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

function buildSyntheticImageToolUse(images: KiroImage[]): KiroToolUse {
  return {
    toolUseId: `tooluse_${randomUUID().replace(/-/gu, '')}`,
    name: SYNTHETIC_IMAGE_TOOL_NAME,
    input: {
      operations: [{
        mode: 'Image',
        image_paths: images.map((image, index) => `${SYNTHETIC_IMAGE_PLACEHOLDER_PREFIX}-${index + 1}.${image.format}`),
      }],
    },
  }
}

function buildSyntheticImageToolResult(toolUseId: string): { toolUseId: string; content: { text: string }[]; status: string } {
  return {
    toolUseId,
    content: [{ text: SYNTHETIC_IMAGE_TOOL_RESULT_TEXT }],
    status: 'success',
  }
}

function syntheticImagePlaceholderContent(images: KiroImage[]): string {
  return images.map((image, index) => `${SYNTHETIC_IMAGE_PLACEHOLDER_PREFIX}-${index + 1}.${image.format}`).join('\n')
}

function extractToolUses(content: string | AnthropicContentBlock[], seenToolUseIds: Set<string>, requestNameMap: Map<string, string>): KiroToolUse[] {
  if (typeof content === 'string') return []
  return content.filter((b) => b.type === 'tool_use').map((b) => {
    const block = b as { id: string; name: string; input: Record<string, unknown> }
    validateToolUseId(block.id, 'Anthropic tool_use')
    if (seenToolUseIds.has(block.id)) throw new InvalidRequestError(`Anthropic tool_use id is duplicated: ${block.id}`)
    seenToolUseIds.add(block.id)
    const name = requestNameMap.get(block.name) ?? validateToolName(block.name, 'Anthropic tool_use')
    if (!isRecord(block.input)) throw new InvalidRequestError(`Anthropic tool_use input must be an object: ${block.id}`)
    return { toolUseId: block.id, name, input: block.input }
  })
}

function extractToolResults(content: string | AnthropicContentBlock[] | undefined, seenToolUseIds: Set<string>, source: string, images?: KiroImage[]): unknown[] {
  if (!content || typeof content === 'string') return []
  return content.filter((b) => b.type === 'tool_result').map((b) => {
    const tr = b as { tool_use_id: string; content: unknown; is_error?: boolean }
    validateKnownToolResultId(tr.tool_use_id, seenToolUseIds, source)
    return { toolUseId: tr.tool_use_id, content: [{ text: stringifyToolResultContent(tr.content, source, images) }], status: tr.is_error ? 'error' : 'success' }
  })
}

function repairMissingToolResults<T extends { role: 'user' | 'assistant'; text: string; toolUses: KiroToolUse[]; toolResults: unknown[] }>(
  flat: T[],
  makeUserEntry: (toolResults: unknown[]) => T,
): void {
  const resolvedToolUseIds = collectToolResultIds(flat)
  let appendedUserEntry: T | undefined

  for (let i = 0; i < flat.length; i++) {
    const entry = flat[i]!
    if (entry.role !== 'assistant') continue

    for (const toolUse of entry.toolUses) {
      if (resolvedToolUseIds.has(toolUse.toolUseId)) continue
      const repair = buildInterruptedToolResult(toolUse.toolUseId)
      const nextUser = findNextUserEntry(flat, i + 1)
      if (nextUser) {
        nextUser.toolResults.unshift(repair)
      } else {
        if (!appendedUserEntry) {
          appendedUserEntry = makeUserEntry([])
          flat.push(appendedUserEntry)
        }
        appendedUserEntry.toolResults.push(repair)
      }
      resolvedToolUseIds.add(toolUse.toolUseId)
    }
  }
}

function collectToolResultIds(entries: { role: 'user' | 'assistant'; toolResults: unknown[] }[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.role !== 'user') continue
    for (const result of entry.toolResults) {
      const id = readToolResultId(result)
      if (id) ids.add(id)
    }
  }
  return ids
}

function findNextUserEntry<T extends { role: 'user' | 'assistant' }>(entries: T[], start: number): T | undefined {
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.role === 'user') return entry
  }
  return undefined
}

function readToolResultId(result: unknown): string | undefined {
  return isRecord(result) && typeof result['toolUseId'] === 'string' ? result['toolUseId'] : undefined
}

function buildInterruptedToolResult(toolUseId: string): { toolUseId: string; content: { text: string }[]; status: string } {
  return {
    toolUseId,
    content: [{ text: 'Tool use was interrupted before a result was returned.' }],
    status: 'error',
  }
}

export function buildAnthropicResponse(model: string, contentBlocks: AnthropicContentBlock[], inputTokens: number, outputTokens: number): unknown {
  const hasToolUse = contentBlocks.some((b) => b.type === 'tool_use')
  return { id: `msg_${randomUUID().replace(/-/gu, '')}`, type: 'message', role: 'assistant', content: contentBlocks, model, stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
}

// --- OpenAI types ---

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  name?: string
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type OpenAIRequest = {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  reasoning_effort?: string
  stream?: boolean
  tools?: { type: string; function: { name: string; description: string; parameters: unknown } }[]
}

export function openaiToKiro(req: OpenAIRequest): KiroPayload {
  const inputMessages = validateOpenAIRequest(req)
  const modelId = mapModelId(req.model)
  const maxTokens = validateMaxTokens(req.max_tokens)
  const history: unknown[] = []
  const seenToolUseIds = new Set<string>()
  const { specs: tools, responseNameMap: toolNameMap, requestNameMap } = buildToolSpecs((req.tools ?? []).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })), 'OpenAI')

  // Separate system from conversation
  let systemText = ''
  const msgs: OpenAIMessage[] = []
  for (const m of inputMessages) {
    if (m.role === 'system') systemText += (m.content ?? '') + '\n'
    else msgs.push(m)
  }

  const flat: { role: 'user' | 'assistant'; text: string; toolUses: KiroToolUse[]; toolResults: unknown[] }[] = []
  for (const m of msgs) {
    let entry: { role: 'user' | 'assistant'; text: string; toolUses: KiroToolUse[]; toolResults: unknown[] } | undefined
    if (m.role === 'user') {
      entry = { role: 'user', text: m.content ?? '', toolUses: [], toolResults: [] }
    } else if (m.role === 'assistant') {
      entry = { role: 'assistant', text: m.content ?? '', toolUses: extractOpenAIToolUses(m.tool_calls ?? [], seenToolUseIds, requestNameMap), toolResults: [] }
    } else if (m.role === 'tool') {
      validateKnownToolResultId(m.tool_call_id, seenToolUseIds, 'OpenAI')
      entry = { role: 'user', text: 'Here are the tool results.', toolUses: [], toolResults: [{ toolUseId: m.tool_call_id, content: [{ text: stringifyToolResultContent(m.content ?? '', 'OpenAI') }], status: 'success' }] }
    }

    if (!entry) continue
    const last = flat[flat.length - 1]
    const canMerge = last && last.role === entry.role && (last.toolResults.length === 0) === (entry.toolResults.length === 0)
    if (canMerge) {
      if (entry.text) last.text += last.text ? `\n${entry.text}` : entry.text
      last.toolUses.push(...entry.toolUses)
      last.toolResults.push(...entry.toolResults)
    } else {
      flat.push(entry)
    }
  }
  repairMissingToolResults(flat, (toolResults) => ({ role: 'user', text: 'Continue.', toolUses: [], toolResults }))

  // Build history (all except the current turn)
  for (let i = 0; i < flat.length - 1; i++) {
    const entry = flat[i]!
    if (entry.role === 'user') {
      const uim: Record<string, unknown> = { content: entry.text || 'Continue.', origin: KIRO_ORIGIN, modelId }
      if (entry.toolResults.length) uim['userInputMessageContext'] = { toolResults: entry.toolResults }
      history.push({ userInputMessage: uim })
    } else {
      history.push({ assistantResponseMessage: { content: entry.text, toolUses: entry.toolUses } })
    }
  }

  const last = flat[flat.length - 1]
  const userContent = last?.role === 'user' ? last.text : ''
  const toolResults = last?.role === 'user' ? last.toolResults : []
  if (!last) throw new InvalidRequestError('OpenAI messages must include at least one non-system message')

  const thinking = !!req.reasoning_effort
  const effectiveSystem = thinking && shouldInjectThinkingPrompt() ? `${THINKING_PROMPT}\n\n${systemText.trim()}` : systemText.trim()
  const fullContent = effectiveSystem ? `${effectiveSystem}\n\n${userContent || 'Continue.'}` : userContent || 'Continue.'
  const userMsgCtx: Record<string, unknown> = { envState: buildEnvState() }
  if (tools.length) userMsgCtx['tools'] = tools
  if (toolResults.length) userMsgCtx['toolResults'] = toolResults

  const anchor = msgs.find((m) => m.role === 'user')?.content ?? ''

  return {
    conversationState: {
      conversationId: stableConversationId(modelId, effectiveSystem, anchor),
      history,
      currentMessage: { userInputMessage: { content: fullContent, userInputMessageContext: userMsgCtx, origin: KIRO_ORIGIN, modelId } },
      chatTriggerType: 'MANUAL',
    },
    profileArn: '',
    agentMode: 'VIBE',
    additionalModelRequestFields: buildAdditionalModelRequestFields(modelId, req.reasoning_effort ? { type: 'enabled', budget_tokens: effortBudget(req.reasoning_effort) } : undefined),
    inferenceConfig: maxTokens ? { maxTokens } : undefined,
    toolNameMap: toolNameMap.size > 0 ? toolNameMap : undefined,
  }
}

function buildToolSpecs(tools: { name: string; description: string; input_schema: unknown }[], source: string): { specs: unknown[]; responseNameMap: Map<string, string>; requestNameMap: Map<string, string> } {
  const maxTools = readPositiveLimit('KIRO_PROXY_MAX_TOOLS', DEFAULT_MAX_TOOLS)
  const maxToolSchemaBytes = readPositiveLimit('KIRO_PROXY_MAX_TOOL_SCHEMA_BYTES', DEFAULT_MAX_TOOL_SCHEMA_BYTES)
  const maxTotalToolSchemaBytes = readPositiveLimit('KIRO_PROXY_MAX_TOTAL_TOOL_SCHEMA_BYTES', DEFAULT_MAX_TOTAL_TOOL_SCHEMA_BYTES)

  if (tools.length > maxTools) throw new InvalidRequestError(`${source} tool count exceeds ${maxTools}`)

  const names = new Set<string>()
  const responseNameMap = new Map<string, string>() // sanitized → original
  const requestNameMap = new Map<string, string>() // original → sanitized
  const originalNames = new Set<string>()
  let totalSchemaBytes = 0
  const specs = tools.map((t) => {
    if (originalNames.has(t.name)) throw new InvalidRequestError(`${source} tool name is duplicated: ${t.name}`)
    originalNames.add(t.name)
    const sanitized = validateToolName(t.name, `${source} tool`)
    if (names.has(sanitized)) {
      // Deduplicate by appending index
      let deduped = sanitized
      let idx = 2
      while (names.has(deduped)) { deduped = `${sanitized.slice(0, 60)}_${idx}`; idx++ }
      names.add(deduped)
      responseNameMap.set(deduped, t.name)
      requestNameMap.set(t.name, deduped)
      const schemaBytes = Buffer.byteLength(JSON.stringify(t.input_schema ?? {}))
      if (schemaBytes > maxToolSchemaBytes) throw new InvalidRequestError(`${source} tool schema is too large: ${t.name}`)
      totalSchemaBytes += schemaBytes
      if (totalSchemaBytes > maxTotalToolSchemaBytes) throw new InvalidRequestError(`${source} tool schemas are too large`)
      return { toolSpecification: { name: deduped, description: t.description, inputSchema: { json: t.input_schema } } }
    }
    names.add(sanitized)
    if (sanitized !== t.name) responseNameMap.set(sanitized, t.name)
    requestNameMap.set(t.name, sanitized)

    const schemaBytes = Buffer.byteLength(JSON.stringify(t.input_schema ?? {}))
    if (schemaBytes > maxToolSchemaBytes) throw new InvalidRequestError(`${source} tool schema is too large: ${t.name}`)
    totalSchemaBytes += schemaBytes
    if (totalSchemaBytes > maxTotalToolSchemaBytes) throw new InvalidRequestError(`${source} tool schemas are too large`)

    return { toolSpecification: { name: sanitized, description: t.description, inputSchema: { json: t.input_schema } } }
  })
  return { specs, responseNameMap, requestNameMap }
}

function buildAdditionalModelRequestFields(modelId: string, thinking: AnthropicRequest['thinking']): Record<string, unknown> | undefined {
  if (!thinking || (thinking.type !== 'enabled' && thinking.type !== 'adaptive')) return undefined
  if (!EFFORT_MODELS.has(modelId) && process.env['KIRO_PROXY_FORCE_THINKING_EFFORT'] !== '1') return undefined
  return { output_config: { effort: effortFromThinking(thinking) } }
}

function effortFromThinking(thinking: AnthropicRequest['thinking']): string {
  const override = process.env['KIRO_PROXY_THINKING_EFFORT']
  if (override) return normalizeEffort(override)
  const budget = thinking?.budget_tokens ?? 0
  if (budget >= 64_000) return 'max'
  if (budget >= 32_000) return 'xhigh'
  if (budget >= 12_000) return 'high'
  if (budget >= 4_000) return 'medium'
  return 'low'
}

function effortBudget(effort: string): number {
  switch (normalizeEffort(effort)) {
    case 'max': return 64_000
    case 'xhigh': return 32_000
    case 'high': return 12_000
    case 'medium': return 4_000
    default: return 1_024
  }
}

function normalizeEffort(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized === 'minimal') return 'low'
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh' || normalized === 'max') return normalized
  throw new InvalidRequestError(`Unsupported thinking effort: ${value}`)
}

function shouldInjectThinkingPrompt(): boolean {
  return process.env['KIRO_PROXY_INJECT_THINKING_PROMPT'] === '1'
}

function readPositiveLimit(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidRequestError(`${name} must be a positive integer`)
  return value
}


function validateAnthropicRequest(req: AnthropicRequest): AnthropicMessage[] {
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new InvalidRequestError('messages must be a non-empty array')
  for (const msg of req.messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') throw new InvalidRequestError(`unsupported Anthropic message role: ${String((msg as { role?: unknown }).role)}`)
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) throw new InvalidRequestError('Anthropic message content must be a string or content block array')
  }
  return req.messages
}

function validateOpenAIRequest(req: OpenAIRequest): OpenAIMessage[] {
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new InvalidRequestError('messages must be a non-empty array')
  for (const msg of req.messages) {
    if (msg.role !== 'system' && msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'tool') throw new InvalidRequestError(`unsupported OpenAI message role: ${String((msg as { role?: unknown }).role)}`)
    if (msg.role === 'tool' && !msg.tool_call_id) throw new InvalidRequestError('OpenAI tool message is missing tool_call_id')
  }
  return req.messages
}

function validateMaxTokens(maxTokens: number | undefined): number | undefined {
  if (maxTokens === undefined) return undefined
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_OUTPUT_TOKENS) throw new InvalidRequestError(`max_tokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`)
  return maxTokens
}

function validateToolName(name: string, _source: string): string {
  if (typeof name !== 'string' || !name) return 'tool'
  if (TOOL_NAME_PATTERN.test(name)) return name
  return sanitizeToolName(name)
}

function sanitizeToolName(name: string): string {
  // mcp__server__tool_name → mcp-server-tool_name (shorten namespace)
  let clean = name
  // Collapse double underscores (MCP namespace separator)
  if (clean.includes('__')) {
    const parts = clean.split('__')
    clean = parts.length > 2 ? `${parts[0]}_${parts[parts.length - 1]!}` : parts.join('_')
  }
  // Remove invalid chars
  clean = clean.replace(/[^A-Za-z0-9_-]/gu, '_')
  // Truncate to 64
  if (clean.length > 64) clean = clean.slice(0, 64)
  return clean || 'tool'
}

function validateToolUseId(id: string | undefined, source: string): asserts id is string {
  if (typeof id !== 'string' || !TOOL_USE_ID_PATTERN.test(id)) throw new InvalidRequestError(`${source} id is invalid: ${String(id)}`)
}

function validateKnownToolResultId(id: string | undefined, seenToolUseIds: Set<string>, source: string): void {
  validateToolUseId(id, `${source} tool_result`)
  if (!seenToolUseIds.has(id)) throw new InvalidRequestError(`${source} tool_result references an unknown tool_use id: ${id}`)
}

function extractOpenAIToolUses(toolCalls: NonNullable<OpenAIMessage['tool_calls']>, seenToolUseIds: Set<string>, requestNameMap: Map<string, string>): KiroToolUse[] {
  return toolCalls.map((tc) => {
    validateToolUseId(tc.id, 'OpenAI tool_call')
    if (seenToolUseIds.has(tc.id)) throw new InvalidRequestError(`OpenAI tool_call id is duplicated: ${tc.id}`)
    seenToolUseIds.add(tc.id)
    const name = requestNameMap.get(tc.function.name) ?? validateToolName(tc.function.name, 'OpenAI tool_call')
    return { toolUseId: tc.id, name, input: parseToolInput(tc.function.arguments, tc.id) }
  })
}

function parseToolInput(value: string, id: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new InvalidRequestError(`OpenAI tool_call arguments must be a JSON object: ${id}`)
  }
}

function stringifyToolResultContent(content: unknown, source: string, images?: KiroImage[]): string {
  if (Array.isArray(content)) return stringifyToolResultParts(content, source, images)
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  if (typeof text !== 'string') throw new InvalidRequestError(`${source} tool_result content is not serializable`)
  return truncateToolResultText(text)
}

function stringifyToolResultParts(parts: unknown[], source: string, images?: KiroImage[]): string {
  const textParts: string[] = []
  let imageCount = 0
  for (const part of parts) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      textParts.push(part['text'])
      continue
    }
    if (isImageBlock(part)) {
      if (!images) {
        textParts.push(TOOL_RESULT_IMAGE_PLACEHOLDER)
      } else {
        if (images.length >= MAX_IMAGES) throw new InvalidRequestError(`image count exceeds ${MAX_IMAGES}`)
        images.push(extractImageBlock(part))
      }
      imageCount++
      continue
    }
    const text = stringifyToolResultContent(part, source)
    if (text) textParts.push(text)
  }
  if (textParts.length) return truncateToolResultText(textParts.join('\n'))
  return imageCount > 0 ? TOOL_RESULT_IMAGE_PLACEHOLDER : ''
}

function isImageBlock(value: unknown): boolean {
  return isRecord(value) && value['type'] === 'image' && isRecord(value['source'])
}

function extractImageBlock(block: unknown): KiroImage {
  if (!isRecord(block) || !isRecord(block['source'])) throw new InvalidRequestError('image block is invalid')
  const src = block['source']
  const sourceType = src['type']
  if (sourceType && sourceType !== 'base64') throw new InvalidRequestError('only base64 image sources are supported')
  const mediaType = src['media_type']
  const data = src['data']
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) throw new InvalidRequestError(`unsupported image media type: ${String(mediaType)}`)
  if (typeof data !== 'string' || !isLikelyBase64(data)) throw new InvalidRequestError('image source must be base64 data')
  const format = mediaType === 'image/jpeg' ? 'jpeg' : mediaType.split('/')[1] || 'png'
  return { format, source: { bytes: data } }
}

function truncateToolResultText(text: string): string {
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_TOOL_RESULT_TEXT_BYTES) return text
  const suffix = `\n[tool_result truncated: original_bytes=${bytes}]`
  const budget = Math.max(0, MAX_TOOL_RESULT_TEXT_BYTES - Buffer.byteLength(suffix))
  return `${truncateUtf8(text, budget)}${suffix}`
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return value.slice(0, low)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLikelyBase64(value: string): boolean {
  if (!value) return false
  if (value.startsWith('data:')) return false
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
}
