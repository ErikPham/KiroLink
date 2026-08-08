/**
 * The only module in KiroLink that reads process.env.
 *
 * Environment variables are one *source* feeding this resolver, not a runtime
 * lookup mechanism. Everything downstream receives a typed KiroLinkConfig.
 *
 * Naming: KIROLINK_* is canonical. The legacy KIRO_PROXY_* names are still
 * honored so existing scripts keep working; `readEnv` checks the canonical name
 * first and falls back to the legacy alias.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_TOOLS,
  DEFAULT_MAX_TOOL_SCHEMA_BYTES,
  DEFAULT_MAX_TOTAL_TOOL_SCHEMA_BYTES,
} from '../domain/limits'
import type { KiroLinkConfig, UpstreamAuthMode } from './config'
import { parseAuthMode } from './config'

export type Env = NodeJS.ProcessEnv

const CANONICAL_PREFIX = 'KIROLINK_'
const LEGACY_PREFIX = 'KIRO_PROXY_'

const DEFAULT_PORT = 4119
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_DELAY_MS = 200
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
const MIN_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_KIRO_CLI_VERSION = '2.5.1'

/**
 * CLI-supplied overrides. Undefined means "not specified", which is distinct
 * from an explicit empty value, so precedence (CLI > env > file > default) can
 * be resolved correctly.
 */
export type CliOverrides = {
  port?: string | undefined
  host?: string | undefined
  quiet?: boolean | undefined
  verbose?: boolean | undefined
  json?: boolean | undefined
  maxConcurrent?: string | undefined
  delay?: string | undefined
  apiKey?: string | undefined
  auth?: string | undefined
  kiroApiKey?: string | undefined
  apiRegion?: string | undefined
}

/** Auth settings persisted to the user config file. */
export type StoredAuthSettings = {
  auth?: UpstreamAuthMode
  kiroApiKey?: string
  apiRegion?: string
}

/** Where each resolved auth value came from — surfaced by --verbose. */
export type AuthSources = { auth: string; kiroApiKey: string; apiRegion: string }

export type LoadConfigResult = {
  config: KiroLinkConfig
  sources: AuthSources
}

/** Read a setting, preferring the canonical name over the legacy alias. */
function readEnv(env: Env, name: string, ...extraLegacyNames: string[]): string | undefined {
  const candidates = [`${CANONICAL_PREFIX}${name}`, `${LEGACY_PREFIX}${name}`, ...extraLegacyNames]
  for (const candidate of candidates) {
    const value = env[candidate]?.trim()
    if (value) return value
  }
  return undefined
}

function readBool(env: Env, name: string): boolean {
  const value = readEnv(env, name)?.toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function readPort(value: string | undefined, fallback: number): number {
  const port = readPositiveInteger(value, fallback, 'port')
  if (port > 65_535) throw new Error('port must be between 1 and 65535')
  return port
}

export function normalizeRegion(raw: string | undefined): string | undefined {
  const region = raw?.trim()
  if (!region) return undefined
  return /^[a-z0-9-]+$/u.test(region) ? region : undefined
}

export function defaultUserConfigPath(env: Env = process.env): string {
  const override = readEnv(env, 'CONFIG')
  if (override) return override
  const base = env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config')
  return join(base, 'kirolink', 'config.json')
}

/**
 * Resolve the full configuration from CLI flags, environment, and the stored
 * config file, in that order of precedence.
 */
export function loadConfig(input: {
  cli?: CliOverrides
  env?: Env
  stored?: StoredAuthSettings
  configPath?: string
} = {}): LoadConfigResult {
  const env = input.env ?? process.env
  const cli = input.cli ?? {}
  const stored = input.stored ?? {}

  const envAuth = readEnv(env, 'AUTH', `${LEGACY_PREFIX}AUTH_MODE`, `${CANONICAL_PREFIX}AUTH_MODE`)
  const authRaw = cli.auth ?? envAuth ?? stored.auth
  const mode = parseAuthMode(authRaw)
  const authSource = cli.auth !== undefined ? 'cli' : envAuth ? 'env' : stored.auth ? 'config' : 'default'

  const envKiroApiKey = readEnv(env, 'KIRO_API_KEY')
  const kiroApiKey = (cli.kiroApiKey ?? envKiroApiKey ?? stored.kiroApiKey)?.trim() || undefined
  const kiroApiKeySource = cli.kiroApiKey !== undefined ? 'cli' : envKiroApiKey ? 'env' : stored.kiroApiKey ? 'config' : 'none'

  const envRegion = readEnv(env, 'API_REGION')
  const apiRegionRaw = cli.apiRegion ?? envRegion ?? stored.apiRegion
  const apiRegion = normalizeRegion(apiRegionRaw)
  if (apiRegionRaw !== undefined && apiRegion === undefined) {
    throw new Error('api-region must be a simple region id (e.g. us-east-1, eu-central-1)')
  }
  const apiRegionSource = cli.apiRegion !== undefined ? 'cli' : envRegion ? 'env' : stored.apiRegion ? 'config' : 'none'

  const config: KiroLinkConfig = {
    server: {
      port: readPort(cli.port ?? readEnv(env, 'PORT'), DEFAULT_PORT),
      host: cli.host ?? readEnv(env, 'HOST') ?? DEFAULT_HOST,
      apiKey: (cli.apiKey ?? readEnv(env, 'API_KEY'))?.trim() || undefined,
      maxBodyBytes: readPositiveInteger(readEnv(env, 'MAX_BODY_BYTES'), DEFAULT_MAX_BODY_BYTES, 'MAX_BODY_BYTES'),
    },
    upstream: {
      mode,
      kiroApiKey,
      apiRegion,
      apiUrl: readEnv(env, 'API_URL'),
      allowUntrustedApiUrl: readBool(env, 'ALLOW_UNTRUSTED_API_URL'),
      tokenPath: readEnv(env, 'TOKEN_PATH'),
      requestTimeoutMs: readRequestTimeout(env),
    },
    throttle: {
      maxConcurrent: readPositiveInteger(cli.maxConcurrent ?? readEnv(env, 'MAX_CONCURRENT'), DEFAULT_MAX_CONCURRENT, 'max-concurrent'),
      delayMs: readPositiveInteger(cli.delay ?? readEnv(env, 'DELAY_MS'), DEFAULT_DELAY_MS, 'delay'),
    },
    limits: {
      maxTools: readPositiveInteger(readEnv(env, 'MAX_TOOLS'), DEFAULT_MAX_TOOLS, 'MAX_TOOLS'),
      maxToolSchemaBytes: readPositiveInteger(readEnv(env, 'MAX_TOOL_SCHEMA_BYTES'), DEFAULT_MAX_TOOL_SCHEMA_BYTES, 'MAX_TOOL_SCHEMA_BYTES'),
      maxTotalToolSchemaBytes: readPositiveInteger(readEnv(env, 'MAX_TOTAL_TOOL_SCHEMA_BYTES'), DEFAULT_MAX_TOTAL_TOOL_SCHEMA_BYTES, 'MAX_TOTAL_TOOL_SCHEMA_BYTES'),
    },
    translation: {
      // The legacy NO_PROMPT_FILTER escape hatch wins over FILTER_SYSTEM_PROMPT,
      // matching the previous behavior where both were checked together.
      filterSystemPrompt: readBool(env, 'FILTER_SYSTEM_PROMPT') && !readBool(env, 'NO_PROMPT_FILTER'),
      injectThinkingPrompt: readBool(env, 'INJECT_THINKING_PROMPT'),
      forceThinkingEffort: readBool(env, 'FORCE_THINKING_EFFORT'),
      thinkingEffort: readEnv(env, 'THINKING_EFFORT'),
      randomConversationId: readBool(env, 'RANDOM_CONVERSATION_ID'),
    },
    credits: {
      required: readBool(env, 'REQUIRE_CREDITS'),
    },
    diagnostics: {
      verbose: cli.verbose ?? false,
      quiet: cli.quiet ?? false,
      json: cli.json ?? readBool(env, 'LOG_JSON'),
      exposeUpstreamErrors: readBool(env, 'EXPOSE_UPSTREAM_ERRORS'),
      dumpFailedPayload: readBool(env, 'DUMP_FAILED_PAYLOAD'),
      dumpFailedPayloadPath: readEnv(env, 'FAILED_PAYLOAD_PATH'),
    },
    identity: {
      kiroCliVersion: readEnv(env, 'KIRO_CLI_VERSION', 'KIRO_CLI_VERSION') ?? DEFAULT_KIRO_CLI_VERSION,
      userAgent: readEnv(env, 'USER_AGENT'),
      amzUserAgent: readEnv(env, 'AMZ_USER_AGENT'),
      codeWhispererOptOut: readEnv(env, 'CODEWHISPERER_OPTOUT') ?? 'true',
    },
    configPath: input.configPath ?? defaultUserConfigPath(env),
  }

  return { config, sources: { auth: authSource, kiroApiKey: kiroApiKeySource, apiRegion: apiRegionSource } }
}

/**
 * A timeout below 30s is rejected rather than clamped: the runtime routinely
 * takes minutes for long generations, so a too-small value is far more likely
 * to be a mistake than an intent.
 */
function readRequestTimeout(env: Env): number {
  const raw = readEnv(env, 'REQUEST_TIMEOUT_MS')
  if (raw === undefined) return DEFAULT_REQUEST_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < MIN_REQUEST_TIMEOUT_MS) {
    throw new Error(`REQUEST_TIMEOUT_MS must be at least ${MIN_REQUEST_TIMEOUT_MS}`)
  }
  return Math.floor(value)
}
