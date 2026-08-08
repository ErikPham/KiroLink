/**
 * OpenAI Chat Completions API adapter types.
 */

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

export type OpenAIToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

export type OpenAIUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }

export type OpenAIChunk = {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: {
      content?: string
      reasoning_content?: string
      tool_calls?: (OpenAIToolCall & { index: number })[]
    }
    finish_reason: 'stop' | 'tool_calls' | null
  }[]
  usage?: OpenAIUsage
}

export type OpenAICompletion = {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: OpenAIToolCall[] }
    finish_reason: 'stop' | 'tool_calls'
  }[]
  usage: OpenAIUsage
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function buildUsage(inputTokens: number, outputTokens: number): OpenAIUsage {
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens }
}
