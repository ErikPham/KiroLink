/**
 * Adapter registry.
 *
 * Adding a protocol means adding one adapter here; the router and the event pump
 * need no changes.
 */

import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { KiroLinkConfig } from '../config/config'
import { anthropicContextWindowErrorBody, openAIContextWindowErrorBody } from '../errors'
import type { ProtocolAdapter } from './adapter'
import { anthropicToKiro, validateAnthropicRequest } from './anthropic/translate'
import type { AnthropicRequest } from './anthropic/types'
import { AnthropicJsonWriter, AnthropicStreamWriter } from './anthropic/writer'
import { createConversationIdAssigner, type ConversationIdAssigner } from './conversation'
import { openaiToKiro, validateOpenAIRequest } from './openai/translate'
import type { OpenAIRequest } from './openai/types'
import { OpenAIJsonWriter, OpenAIStreamWriter } from './openai/writer'

export function createAnthropicAdapter(
  config: KiroLinkConfig,
  conversationIds: ConversationIdAssigner,
): ProtocolAdapter<AnthropicRequest> {
  return {
    name: 'anthropic',
    parseRequest: validateAnthropicRequest,
    toKiroRequest: (request) => anthropicToKiro(request, config, conversationIds),
    createWriter: (res: ServerResponse, request) =>
      request.stream
        ? new AnthropicStreamWriter(res, request.model)
        : new AnthropicJsonWriter(res, request.model),
    contextWindowErrorBody: () => anthropicContextWindowErrorBody(`req_${randomUUID()}`),
    describeRequest: (request) =>
      `model=${request.model} stream=${request.stream === true} tools=${request.tools?.length ?? 0} messages=${request.messages.length}`,
    metricsFor: (request) => ({ model: request.model, stream: request.stream === true }),
  }
}

export function createOpenAIAdapter(
  config: KiroLinkConfig,
  conversationIds: ConversationIdAssigner,
): ProtocolAdapter<OpenAIRequest> {
  return {
    name: 'openai',
    parseRequest: validateOpenAIRequest,
    toKiroRequest: (request) => openaiToKiro(request, config, conversationIds),
    createWriter: (res: ServerResponse, request) => {
      const id = `chatcmpl-${randomUUID()}`
      return request.stream
        ? new OpenAIStreamWriter(res, request.model, id)
        : new OpenAIJsonWriter(res, request.model, id)
    },
    contextWindowErrorBody: openAIContextWindowErrorBody,
    describeRequest: (request) =>
      `model=${request.model} stream=${request.stream === true} tools=${request.tools?.length ?? 0} messages=${request.messages.length}`,
    metricsFor: (request) => ({ model: request.model, stream: request.stream === true }),
  }
}

export type AdapterSet = {
  anthropic: ProtocolAdapter<AnthropicRequest>
  openai: ProtocolAdapter<OpenAIRequest>
}

export function createAdapters(config: KiroLinkConfig): AdapterSet {
  // One assigner shared by both protocols: a conversation resumed through a
  // different endpoint should still map to the same upstream conversation id.
  const conversationIds = createConversationIdAssigner(config.translation)
  return {
    anthropic: createAnthropicAdapter(config, conversationIds),
    openai: createOpenAIAdapter(config, conversationIds),
  }
}
