/**
 * Anthropic Messages API adapter.
 */

import { randomUUID } from 'node:crypto'

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: string; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking'; thinking: string }

export type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }

export type AnthropicRequest = {
  model: string
  max_tokens?: number
  stream?: boolean
  thinking?: { type: string; budget_tokens?: number }
  system?: string | { type: string; text: string }[]
  messages: AnthropicMessage[]
  tools?: { name: string; description: string; input_schema: unknown }[]
}

export type AnthropicResponse = {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'tool_use'
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

export function buildAnthropicResponse(
  model: string,
  content: AnthropicContentBlock[],
  inputTokens: number,
  outputTokens: number,
): AnthropicResponse {
  return {
    id: `msg_${randomUUID().replace(/-/gu, '')}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}
