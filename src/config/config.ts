/**
 * The complete, immutable KiroLink configuration.
 *
 * Previously 8 fields lived in a ProxyConfig type while 29 environment
 * variables were read at their point of use across 7 modules, and index.ts
 * wrote resolved auth values *back into* process.env so downstream modules
 * could pick them up. That made the real configuration surface invisible,
 * leaked secrets into the environment of any spawned child process, and made
 * two servers in one process impossible.
 *
 * Now: every knob is declared here, resolved once at the edge, and threaded
 * explicitly. `src/config/env.ts` is the only module that reads process.env.
 */

/** Upstream auth selector: `cli` (kiro-cli OAuth, default) or `api-key`. */
export type UpstreamAuthMode = 'cli' | 'api-key'

export type ServerConfig = {
  port: number
  host: string
  /** Require this key from clients (protects the proxy itself). */
  apiKey: string | undefined
  maxBodyBytes: number
}

export type UpstreamConfig = {
  mode: UpstreamAuthMode
  /** Upstream Kiro API key; required when mode is `api-key`. */
  kiroApiKey: string | undefined
  /** Runtime region, e.g. `eu-central-1`. Ignored when `apiUrl` is set. */
  apiRegion: string | undefined
  /** Full runtime URL override. */
  apiUrl: string | undefined
  /** Allow a non-allowlisted host/port for `apiUrl` (development only). */
  allowUntrustedApiUrl: boolean
  /** Explicit kiro-cli token cache path; otherwise discovered. */
  tokenPath: string | undefined
  requestTimeoutMs: number
}

export type ThrottleConfig = {
  maxConcurrent: number
  delayMs: number
}

export type LimitsConfig = {
  maxTools: number
  maxToolSchemaBytes: number
  maxTotalToolSchemaBytes: number
}

export type TranslationConfig = {
  /** Replace Claude Code's large system prompt with a compact one. */
  filterSystemPrompt: boolean
  /** Prepend a thinking directive to the system prompt (fallback path). */
  injectThinkingPrompt: boolean
  /** Send output_config.effort even for models not known to support it. */
  forceThinkingEffort: boolean
  /** Pin thinking effort instead of deriving it from budget_tokens. */
  thinkingEffort: string | undefined
  /** Use a fresh random conversationId per request (disables prefix-cache reuse). */
  randomConversationId: boolean
}

export type CreditsConfig = {
  /** Reject chat requests when remaining credits are 0. */
  required: boolean
}

export type DiagnosticsConfig = {
  verbose: boolean
  quiet: boolean
  /** Emit newline-delimited JSON logs. */
  json: boolean
  /** Include upstream error detail in client-visible messages. */
  exposeUpstreamErrors: boolean
  /** Write the request payload to disk when upstream rejects it. */
  dumpFailedPayload: boolean
  dumpFailedPayloadPath: string | undefined
}

/** Identity headers sent upstream, spoofing kiro-cli. */
export type ClientIdentityConfig = {
  kiroCliVersion: string
  userAgent: string | undefined
  amzUserAgent: string | undefined
  codeWhispererOptOut: string
}

export type KiroLinkConfig = {
  server: ServerConfig
  upstream: UpstreamConfig
  throttle: ThrottleConfig
  limits: LimitsConfig
  translation: TranslationConfig
  credits: CreditsConfig
  diagnostics: DiagnosticsConfig
  identity: ClientIdentityConfig
  /** Path of the user config file backing persisted auth settings. */
  configPath: string
}

const MIN_API_KEY_BYTES = 16
const MIN_KIRO_API_KEY_BYTES = 16

export function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Refuse configurations that would expose the proxy without authentication, or
 * accept a key too short to be meaningful.
 */
export function assertSafeBind(server: Pick<ServerConfig, 'host' | 'apiKey'>): void {
  if (server.apiKey !== undefined && Buffer.byteLength(server.apiKey) < MIN_API_KEY_BYTES) {
    throw new Error(`API key must be at least ${MIN_API_KEY_BYTES} bytes`)
  }
  if (!isLocalHost(server.host) && server.apiKey === undefined) {
    throw new Error('Refusing to bind to a non-local host without --api-key or KIROLINK_API_KEY')
  }
}

/** Fail fast when mode is api-key but no usable key is configured. */
export function assertUpstreamConfig(upstream: UpstreamConfig): void {
  if (upstream.mode !== 'api-key') return
  if (!upstream.kiroApiKey) {
    throw new Error('Auth mode api-key requires --kiro-api-key, KIROLINK_KIRO_API_KEY, or a saved key in the config file')
  }
  if (Buffer.byteLength(upstream.kiroApiKey) < MIN_KIRO_API_KEY_BYTES) {
    throw new Error(`KIROLINK_KIRO_API_KEY must be at least ${MIN_KIRO_API_KEY_BYTES} bytes`)
  }
}

/** Human-readable auth selection for startup logs and --help. */
export function describeUpstream(upstream: UpstreamConfig): string {
  if (upstream.mode === 'api-key') {
    if (upstream.apiUrl) return 'api-key (KIROLINK_API_URL override)'
    return `api-key (region=${upstream.apiRegion ?? 'us-east-1'})`
  }
  if (upstream.kiroApiKey) {
    return 'cli (kiro-cli cache; Kiro API key ignored — use --auth api-key)'
  }
  return 'cli (kiro-cli cache)'
}

/**
 * Parse an auth mode string.
 * Accepts cli | kiro-cli | oauth → cli, and api-key | apikey | api_key → api-key.
 */
export function parseAuthMode(raw: string | undefined): UpstreamAuthMode {
  const value = raw?.trim().toLowerCase()
  if (!value || value === 'cli' || value === 'kiro-cli' || value === 'oauth') return 'cli'
  if (value === 'api-key' || value === 'apikey' || value === 'api_key') return 'api-key'
  throw new Error(`Invalid auth mode "${raw}". Use: cli | api-key`)
}
