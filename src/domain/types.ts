/**
 * Kiro wire types and normalized stream events.
 *
 * This module must stay dependency-free: it is the shared vocabulary between
 * the transport (src/kiro), the protocol adapters (src/protocol), and the HTTP
 * server. Previously these types lived inside the HTTP client, which forced
 * every module that touched a domain type to import node:https and the retry
 * loop with it, and created import cycles.
 */

export type KiroToolUse = { toolUseId: string; name: string; input: Record<string, unknown> }

export type KiroStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; toolUse: KiroToolUse }
  | { type: 'done'; inputTokens: number; outputTokens: number }

export type KiroImageBlock = { format: string; source: { bytes: string } }

export type KiroToolResult = {
  toolUseId: string
  content: { text: string }[]
  status: 'success' | 'error'
}

export type KiroUserInputMessageContext = {
  envState?: Record<string, string>
  tools?: unknown[]
  toolResults?: KiroToolResult[]
}

/** The Kiro wire shape for a user turn (current message or a history entry). */
export type KiroUserInputMessage = {
  content: string
  origin?: string
  modelId?: string
  userInputMessageContext?: KiroUserInputMessageContext
  images?: KiroImageBlock[]
}

/** The Kiro wire shape for an assistant turn (history entries only). */
export type KiroAssistantResponseMessage = {
  content: string
  toolUses: KiroToolUse[]
}

/** Kiro conversation history is a strict alternation of user/assistant turns. */
export type KiroHistoryEntry =
  | { userInputMessage: KiroUserInputMessage }
  | { assistantResponseMessage: KiroAssistantResponseMessage }

/**
 * The JSON body sent to GenerateAssistantResponse. Every field here is
 * serialized; processing metadata that must not reach the wire lives on
 * KiroRequest instead.
 */
export type KiroPayload = {
  conversationState: {
    chatTriggerType: string
    conversationId: string
    currentMessage: { userInputMessage: KiroUserInputMessage }
    history: KiroHistoryEntry[]
    agentContinuationId?: string | undefined
    agentTaskType?: string | undefined
  }
  /** Required for OAuth; omitted for api_key auth (Kiro API keys have no profile ARN). */
  profileArn?: string
  agentMode?: 'VIBE' | 'SPEC' | 'AUTOPILOT' | 'SUPERVISED' | undefined
  additionalModelRequestFields?: Record<string, unknown> | undefined
  inferenceConfig?: { maxTokens?: number } | undefined
}

/**
 * A translated request ready to send: the serializable payload plus the
 * metadata the transport needs but must never serialize.
 *
 * `toolNameMap` maps the sanitized tool name sent upstream back to the
 * client's original name, so tool_use events can be renamed on the way out.
 * Keeping it beside the payload rather than inside it removes the previous
 * delete-before-stringify hazard.
 */
export type KiroRequest = {
  payload: KiroPayload
  toolNameMap: ReadonlyMap<string, string>
}

export function isUserHistoryEntry(entry: KiroHistoryEntry): entry is { userInputMessage: KiroUserInputMessage } {
  return 'userInputMessage' in entry
}

export function isAssistantHistoryEntry(entry: KiroHistoryEntry): entry is { assistantResponseMessage: KiroAssistantResponseMessage } {
  return 'assistantResponseMessage' in entry
}
