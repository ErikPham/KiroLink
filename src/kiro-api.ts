import { readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { execFile } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { RuntimeApiError } from './errors'

const TOKEN_PATH = join(homedir(), '.aws/sso/cache/kiro-auth-token-cli.json')
const API_URL = 'https://runtime.us-east-1.kiro.dev/'
const ALLOWED_API_HOSTS = new Set([
  'codewhisperer.us-east-1.amazonaws.com',
  'q.us-east-1.amazonaws.com',
  'runtime.us-east-1.kiro.dev',
])
const MAX_PAYLOAD_BYTES = 900 * 1024
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1000
const MAX_RETRY_AFTER_MS = 60_000
const REQUEST_TIMEOUT_MS = 120_000
const MAX_ERROR_BODY_BYTES = 16 * 1024

export let verbose = false
export function setVerbose(v: boolean): void { verbose = v }
function debug(msg: string): void { if (verbose) process.stderr.write(msg + '\n') }

// Token cache + refresh mutex
let cachedToken: KiroToken | null = null
let refreshPromise: Promise<void> | null = null

export type KiroToken = { accessToken: string; refreshToken: string; expiresAt: string; profileArn: string }
export type KiroToolUse = { toolUseId: string; name: string; input: Record<string, unknown> }
export type KiroStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; toolUse: KiroToolUse }
  | { type: 'done'; inputTokens: number; outputTokens: number }

export type KiroPayload = {
  conversationState: {
    chatTriggerType: string
    conversationId: string
    currentMessage: { userInputMessage: unknown }
    history: unknown[]
    agentContinuationId?: string | undefined
    agentTaskType?: string | undefined
  }
  profileArn: string
  agentMode?: 'VIBE' | 'SPEC' | 'AUTOPILOT' | 'SUPERVISED' | undefined
  additionalModelRequestFields?: Record<string, unknown> | undefined
  inferenceConfig?: { maxTokens?: number } | undefined
  /** Maps sanitized tool names → original names (not serialized to API) */
  toolNameMap?: Map<string, string> | undefined
}

export async function loadToken(): Promise<KiroToken> {
  // Return cached if still valid
  if (cachedToken) {
    const expiresAt = new Date(cachedToken.expiresAt).getTime()
    if (Date.now() < expiresAt - 60_000) return cachedToken
  }

  // Read from file
  const raw = await readFile(process.env['KIRO_PROXY_TOKEN_PATH'] ?? TOKEN_PATH, 'utf8')
  const token = JSON.parse(raw) as KiroToken
  validateToken(token)

  const expiresAt = new Date(token.expiresAt).getTime()
  if (Date.now() > expiresAt - 60_000) {
    debug('[token] Expired, refreshing via kiro-cli...')
    await refreshTokenSerialized()
    const fresh = await readFile(process.env['KIRO_PROXY_TOKEN_PATH'] ?? TOKEN_PATH, 'utf8')
    const freshToken = JSON.parse(fresh) as KiroToken
    validateToken(freshToken)
    cachedToken = freshToken
    return freshToken
  }
  cachedToken = token
  return token
}

/** Ensures only one refresh runs at a time */
function refreshTokenSerialized(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = refreshTokenViaCli().finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

function refreshTokenViaCli(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('kiro-cli', ['chat', '--list-models'], { timeout: 15_000 }, (err) => {
      if (err) reject(new Error(`Token refresh failed: ${err.message}`))
      else resolve()
    })
  })
}

export async function callKiroApi(payload: KiroPayload, onEvent: (event: KiroStreamEvent) => void): Promise<void> {
  // Truncate payload if too large
  truncatePayload(payload)
  const toolNameMap = payload.toolNameMap
  delete payload.toolNameMap

  // Wrap onEvent to restore original tool names
  const wrappedOnEvent = toolNameMap && toolNameMap.size > 0
    ? (event: KiroStreamEvent) => {
        if (event.type === 'tool_use') {
          const original = toolNameMap.get(event.toolUse.name)
          if (original) event.toolUse.name = original
        }
        onEvent(event)
      }
    : onEvent

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await loadToken()
    payload.profileArn = token.profileArn
    const body = JSON.stringify(payload)

    if (!token.profileArn) throw new Error('Kiro token does not contain profileArn')

    const resp = await new Promise<IncomingMessage>((resolve, reject) => {
      const url = resolveKiroApiUrl()
      const req = request({ hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, method: 'POST', headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${token.accessToken}`,
        'User-Agent': userAgent(),
        'x-amz-user-agent': amzUserAgent(),
        'x-amzn-codewhisperer-optout': codeWhispererOptOut(),
        'Amz-Sdk-Invocation-Id': crypto.randomUUID(),
        'Amz-Sdk-Request': 'attempt=1; max=3',
        'Accept': '*/*',
      } }, resolve)
      req.on('error', reject)
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Kiro API request timed out')))
      req.end(body)
    })

    if (resp.statusCode === 429 && attempt < MAX_RETRIES) {
      const retryAfterMs = parseRetryAfterMs(resp.headers['retry-after'])
      await consume(resp)
      const delay = retryAfterMs ?? RETRY_DELAY_MS * (attempt + 1)
      debug(`[retry] 429 rate limited, waiting ${delay}ms...`)
      await sleep(delay)
      continue
    }

    if (resp.statusCode === 403 && attempt === 0) {
      // Token might have just expired between check and use
      await consume(resp)
      cachedToken = null
      debug('[retry] 403, forcing token refresh...')
      await refreshTokenSerialized()
      continue
    }

    if (resp.statusCode !== 200) {
      const errBody = await consumeText(resp, MAX_ERROR_BODY_BYTES)
      debug(`[debug] payload keys: ${JSON.stringify(Object.keys(payload.conversationState.currentMessage))}`)
      const msg = payload.conversationState.currentMessage.userInputMessage as Record<string, unknown>
      debug(`[debug] modelId=${msg['modelId']} content_len=${String(msg['content']).length} history_len=${payload.conversationState.history.length}`)
      debug(`[runtime] upstream ${resp.statusCode ?? 500}: ${errBody}`)
      if (process.env['KIRO_PROXY_DUMP_FAILED_PAYLOAD'] === '1') {
        await writeFile(process.env['KIRO_PROXY_FAILED_PAYLOAD_PATH'] ?? join(tmpdir(), 'kiro-failed-payload.json'), JSON.stringify(payload, null, 2), { mode: 0o600 })
      }
      throw new RuntimeApiError(resp.statusCode ?? 500, errBody, retryAfterSeconds(resp.headers['retry-after']))
    }

    await parseEventStream(resp, wrappedOnEvent)
    return
  }
  throw new Error('Max retries exceeded')
}

export function resolveKiroApiUrl(): URL {
  const url = new URL(process.env['KIRO_PROXY_API_URL'] ?? API_URL)
  const allowUntrusted = process.env['KIRO_PROXY_ALLOW_UNTRUSTED_API_URL'] === '1'
  if (url.protocol !== 'https:') {
    throw new Error('KIRO_PROXY_API_URL must use https')
  }
  if (url.username || url.password) {
    throw new Error('KIRO_PROXY_API_URL must not contain credentials')
  }
  if (url.pathname !== '/' && url.pathname !== '/generateAssistantResponse') {
    throw new Error('KIRO_PROXY_API_URL path must be / or /generateAssistantResponse')
  }
  if (url.search || url.hash) {
    throw new Error('KIRO_PROXY_API_URL must not include query or fragment')
  }
  if (url.port && url.port !== '443' && !allowUntrusted) {
    throw new Error('KIRO_PROXY_API_URL must not use a custom port')
  }
  if (!ALLOWED_API_HOSTS.has(url.hostname) && !allowUntrusted) {
    throw new Error(`Refusing to send Kiro token to untrusted API host: ${url.hostname}`)
  }
  return url
}

export function validateToken(token: KiroToken): void {
  if (!token || typeof token !== 'object') throw new Error('Kiro token file is invalid')
  if (typeof token.accessToken !== 'string' || token.accessToken.length < 16) throw new Error('Kiro token file is missing accessToken')
  if (typeof token.profileArn !== 'string' || !token.profileArn.startsWith('arn:')) throw new Error('Kiro token file is missing profileArn')
  if (typeof token.expiresAt !== 'string' || Number.isNaN(new Date(token.expiresAt).getTime())) throw new Error('Kiro token file is missing expiresAt')
}

export function truncatePayload(payload: KiroPayload): void {
  const size = () => Buffer.byteLength(JSON.stringify(payload))
  if (size() <= MAX_PAYLOAD_BYTES) return

  const history = payload.conversationState.history
  // Smart truncation: keep first 2 (system priming) + last 4 (recent context)
  const keepStart = Math.min(2, history.length)
  const keepEnd = 4
  while (history.length > keepStart + keepEnd && size() > MAX_PAYLOAD_BYTES) {
    history.splice(keepStart, 1)
  }
  // Insert truncation notice after priming
  if (history.length > keepStart) {
    const entry = history[keepStart] as Record<string, unknown>
    if (entry['userInputMessage']) {
      const uim = entry['userInputMessage'] as Record<string, unknown>
      uim['content'] = '[Earlier conversation truncated]\n' + String(uim['content'] ?? '')
    }
  }
}

function kiroCliVersion(): string {
  return process.env['KIRO_CLI_VERSION'] ?? '2.5.1'
}

function osTag(): string {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
}

// Exact User-Agent format captured from kiro-cli 2.5.1 (AWS Rust SDK).
// Override with KIRO_PROXY_USER_AGENT to match your exact build.
function userAgent(): string {
  if (process.env['KIRO_PROXY_USER_AGENT']) return process.env['KIRO_PROXY_USER_AGENT']!
  const v = kiroCliVersion()
  return `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/${osTag()} lang/rust/1.92.0 exec-env/AmazonQ-For-CLI Version/${v} md/appVersion-${v} app/AmazonQ-For-CLI`
}

function amzUserAgent(): string {
  if (process.env['KIRO_PROXY_AMZ_USER_AGENT']) return process.env['KIRO_PROXY_AMZ_USER_AGENT']!
  const v = kiroCliVersion()
  return `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/${osTag()} lang/rust/1.92.0 exec-env/AmazonQ-For-CLI Version/${v} m/F app/AmazonQ-For-CLI`
}

function codeWhispererOptOut(): string {
  return process.env['KIRO_PROXY_CODEWHISPERER_OPTOUT'] ?? 'true'
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

function retryAfterSeconds(header: string | string[] | undefined): number | undefined {
  const ms = parseRetryAfterMs(header)
  return ms === undefined ? undefined : Math.ceil(ms / 1000)
}

function parseRetryAfterMs(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return undefined

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)

  const dateMs = Date.parse(raw)
  if (Number.isNaN(dateMs)) return undefined
  return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS)
}

async function parseEventStream(stream: IncomingMessage, onEvent: (event: KiroStreamEvent) => void): Promise<void> {
  let inputTokens = 0, outputTokens = 0
  let currentToolUse: { toolUseId: string; name: string; inputBuf: string } | null = null
  let lastAssistantContent = '', lastReasoningContent = ''
  const buf = { data: Buffer.alloc(0) }

  for await (const chunk of stream) {
    buf.data = Buffer.concat([buf.data, chunk as Buffer])
    while (buf.data.length >= 12) {
      const totalLength = buf.data.readUInt32BE(0)
      if (totalLength < 16) { debug(`[stream] Skipping invalid frame length: ${totalLength}`); buf.data = buf.data.subarray(4); continue }
      if (buf.data.length < totalLength) break
      const headersLength = buf.data.readUInt32BE(4)
      if (headersLength > totalLength - 16) { debug(`[stream] Skipping invalid headers length: ${headersLength}`); buf.data = buf.data.subarray(totalLength); continue }
      const headersBuf = buf.data.subarray(12, 12 + headersLength)
      const payloadBuf = buf.data.subarray(12 + headersLength, totalLength - 4)
      buf.data = buf.data.subarray(totalLength)

      const headerEventType = extractEventType(headersBuf)
      if (!payloadBuf.length) continue

      let event: Record<string, unknown>
      try { event = JSON.parse(payloadBuf.toString()) as Record<string, unknown> } catch { continue }
      const normalized = normalizeKiroStreamEvent(headerEventType, event)
      const eventType = normalized.eventType
      event = normalized.event

      const usage = findUsage(event)
      if (usage) {
        inputTokens = readTokenCount(usage, inputTokens, 'inputTokens', 'input_tokens', 'uncached_input_tokens')
        outputTokens = readTokenCount(usage, outputTokens, 'outputTokens', 'output_tokens')
      }

      switch (eventType) {
        case 'assistantResponseEvent': {
          const content = event['content'] as string | undefined
          if (content) { const d = norm(content, lastAssistantContent); lastAssistantContent = content; if (d) onEvent({ type: 'text', text: d }) }
          break
        }
        case 'reasoningContentEvent': {
          const text = (event['text'] ?? event['content'] ?? event['reasoningContent'] ?? event['reasoning_content']) as string | undefined
          if (text) { const d = norm(text, lastReasoningContent); lastReasoningContent = text; if (d) onEvent({ type: 'thinking', text: d }) }
          break
        }
        case 'toolUseEvent': {
          const toolUseId = (event['toolUseId'] ?? event['tool_use_id'] ?? '') as string
          const name = (event['name'] ?? '') as string
          const stop = event['stop'] as boolean | undefined
          const input = event['input'] as string | Record<string, unknown> | undefined

          if (name && !currentToolUse) currentToolUse = { toolUseId: toolUseId || `toolu_${crypto.randomUUID()}`, name, inputBuf: '' }
          else if (name && currentToolUse && currentToolUse.name !== name) { finishTool(currentToolUse, onEvent); currentToolUse = { toolUseId: toolUseId || `toolu_${crypto.randomUUID()}`, name, inputBuf: '' } }

          if (currentToolUse && input) { currentToolUse.inputBuf += typeof input === 'string' ? input : JSON.stringify(input) }
          if (stop && currentToolUse) { finishTool(currentToolUse, onEvent); currentToolUse = null }
          break
        }
      }
    }
  }
  if (currentToolUse) finishTool(currentToolUse, onEvent)
  onEvent({ type: 'done', inputTokens, outputTokens })
}

export function normalizeKiroStreamEvent(eventType: string, event: Record<string, unknown>): { eventType: string; event: Record<string, unknown> } {
  let normalizedType = eventType
  let normalizedEvent = event

  if (!normalizedType && typeof event['kind'] === 'string') normalizedType = event['kind'] as string
  if (isRecord(event['data'])) normalizedEvent = event['data']

  switch (normalizedType) {
    case 'AssistantResponseEvent': normalizedType = 'assistantResponseEvent'; break
    case 'ReasoningEvent': normalizedType = 'reasoningContentEvent'; break
    case 'ToolUseEvent': normalizedType = 'toolUseEvent'; break
    case 'MessageMetadataEvent': normalizedType = 'messageMetadataEvent'; break
    case 'ContextUsageEvent': normalizedType = 'contextUsageEvent'; break
    case 'MeteringEvent': normalizedType = 'meteringEvent'; break
  }

  return { eventType: normalizedType, event: normalizedEvent }
}

function finishTool(s: { toolUseId: string; name: string; inputBuf: string }, onEvent: (e: KiroStreamEvent) => void): void {
  let input: Record<string, unknown> = {}
  try { input = JSON.parse(s.inputBuf) as Record<string, unknown> } catch {}
  onEvent({ type: 'tool_use', toolUse: { toolUseId: s.toolUseId, name: s.name, input } })
}

function norm(chunk: string, prev: string): string {
  if (!prev) return chunk
  if (chunk === prev) return ''
  if (chunk.startsWith(prev)) return chunk.slice(prev.length)
  const max = Math.min(prev.length, chunk.length)
  for (let i = max; i > 0; i--) { if (prev.endsWith(chunk.slice(0, i))) return chunk.slice(i) }
  return chunk
}

function extractEventType(headers: Buffer): string {
  let offset = 0
  while (offset < headers.length) {
    const nameLen = headers[offset]!; offset++
    if (offset + nameLen > headers.length) break
    const name = headers.subarray(offset, offset + nameLen).toString(); offset += nameLen
    if (offset >= headers.length) break
    const vt = headers[offset]!; offset++
    if (vt === 7) {
      if (offset + 2 > headers.length) break
      const vl = (headers[offset]! << 8) | headers[offset + 1]!; offset += 2
      if (offset + vl > headers.length) break
      const value = headers.subarray(offset, offset + vl).toString(); offset += vl
      if (name === ':event-type') return value
    } else if (vt === 6) { if (offset + 2 > headers.length) break; const l = (headers[offset]! << 8) | headers[offset + 1]!; offset += 2 + l }
    else { const s: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }; offset += s[vt] ?? 0 }
  }
  return ''
}

function findUsage(e: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof e['inputTokens'] === 'number' || typeof e['input_tokens'] === 'number' || typeof e['output_tokens'] === 'number') return e
  if (typeof e['usage'] === 'object' && e['usage'] !== null) return e['usage'] as Record<string, unknown>
  if (typeof e['metadata'] === 'object' && e['metadata'] !== null) return e['metadata'] as Record<string, unknown>
  return null
}

function readTokenCount(source: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    if (typeof source[key] === 'number') return source[key] as number
  }
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function consume(stream: IncomingMessage): Promise<void> {
  for await (const _ of stream) {}
}

async function consumeText(stream: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buf.length
    if (size <= maxBytes) {
      chunks.push(buf)
    } else if (!truncated) {
      const remaining = maxBytes - (size - buf.length)
      if (remaining > 0) chunks.push(buf.subarray(0, remaining))
      truncated = true
    }
  }
  return Buffer.concat(chunks).toString() + (truncated ? '...[truncated]' : '')
}
