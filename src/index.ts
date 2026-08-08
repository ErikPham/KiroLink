/**
 * Public library entry point.
 *
 * The package previously exposed only a `bin`, so the perfectly reasonable
 * embeddable API was unreachable from code. These are the supported exports;
 * anything not re-exported here is internal and may change.
 */

export { createKiroLink, type KiroLinkApp, type KiroLinkOverrides } from './app'

export {
  assertSafeBind,
  assertUpstreamConfig,
  describeUpstream,
  isLocalHost,
  parseAuthMode,
  type ClientIdentityConfig,
  type CreditsConfig,
  type DiagnosticsConfig,
  type KiroLinkConfig,
  type LimitsConfig,
  type ServerConfig,
  type ThrottleConfig,
  type TranslationConfig,
  type UpstreamAuthMode,
  type UpstreamConfig,
} from './config/config'

export {
  defaultUserConfigPath,
  loadConfig,
  type AuthSources,
  type CliOverrides,
  type Env,
  type LoadConfigResult,
  type StoredAuthSettings,
} from './config/env'

export {
  buildUserConfigToSave,
  loadUserConfig,
  normalizeUserConfig,
  saveUserConfig,
  type UserConfig,
} from './config/user-config'

export { listModels, normalizeModelId, type ModelDescriptor } from './domain/models'

export type {
  KiroAssistantResponseMessage,
  KiroHistoryEntry,
  KiroImageBlock,
  KiroPayload,
  KiroRequest,
  KiroStreamEvent,
  KiroToolResult,
  KiroToolUse,
  KiroUserInputMessage,
  KiroUserInputMessageContext,
} from './domain/types'

export {
  AuthenticationError,
  InvalidRequestError,
  KiroLinkError,
  MalformedBodyError,
  NotFoundError,
  PayloadTooLargeError,
  RequestAbortedError,
  RuntimeApiError,
  anthropicContextWindowErrorBody,
  isContextWindowOverflow,
  openAIContextWindowErrorBody,
  type ApiErrorType,
} from './errors'

export { createKiroProxyServer, type ServerDeps } from './http/server'

export {
  createAuthProvider,
  loadKiroToken,
  type AuthProvider,
  type KiroAuth,
  type KiroToken,
  type TokenSource,
} from './kiro/auth'
export { readSecretStoreToken, type SecretStoreOptions } from './kiro/secret-store'
export type { KiroClient } from './kiro/client'
export { createHttpKiroClient, type HttpKiroClientDeps } from './kiro/http-client'
export { isAllowedKiroApiHost, resolveKiroApiUrl } from './kiro/endpoint'
export { parseEventStream } from './kiro/stream'
export { createThrottle, type Throttle } from './kiro/throttle'
export {
  createUsageService,
  formatUsageLine,
  summarizeUsageResponse,
  type KiroUsageSummary,
  type UsageService,
} from './kiro/usage'

export { createLogger, createNullLogger, type LogFields, type Logger, type LogLevel } from './logging/logger'

export type { ProtocolAdapter, ResponseWriter } from './protocol/adapter'
export { createAdapters, type AdapterSet } from './protocol/registry'
export type { AnthropicRequest, AnthropicResponse } from './protocol/anthropic/types'
export type { OpenAICompletion, OpenAIRequest } from './protocol/openai/types'
