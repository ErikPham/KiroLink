import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { execFile } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { RuntimeApiError } from './errors'

const TOKEN_CACHE_DIR = join(homedir(), '.aws/sso/cache')
const TOKEN_FILENAMES = ['kiro-auth-token-cli.json', 'kiro-auth-token.json'] as const
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
const MAX_CONTENT_TEXT_BYTES = 128 * 1024
const MAX_TOOL_RESULT_TEXT_BYTES = 64 * 1024

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

type TokenCandidate = {
  path: string
  token: KiroToken
  mtimeMs: number
  preferredNameRank: number
}

export async function loadToken(): Promise<KiroToken> {
  // Return cached if still valid
  if (cachedToken) {
    const expiresAt = new Date(cachedToken.expiresAt).getTime()
    if (Date.now() < expiresAt - 60_000) return cachedToken
  }

  // Read from file
  const tokenPath = await resolveTokenPath()
  const token = await readTokenFile(tokenPath)

  const expiresAt = new Date(token.expiresAt).getTime()
  if (Date.now() > expiresAt - 60_000) {
    debug('[token] Expired, refreshing via kiro-cli...')
    await refreshTokenSerialized()
    const freshPath = await resolveTokenPath()
    const freshToken = await readTokenFile(freshPath)
    cachedToken = freshToken
    return freshToken
  }
  cachedToken = token
  return token
}

export async function resolveTokenPath(cacheDir = TOKEN_CACHE_DIR, explicitPath = process.env['KIRO_PROXY_TOKEN_PATH']): Promise<string> {
  if (explicitPath) return explicitPath

  const preferredPaths = TOKEN_FILENAMES.map((filename) => join(cacheDir, filename))
  const candidates = [...preferredPaths]

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true })
    const discovered = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !TOKEN_FILENAMES.includes(entry.name as typeof TOKEN_FILENAMES[number]))
      .map((entry) => join(cacheDir, entry.name))
    candidates.push(...discovered)
  } catch (error) {
    throw new Error(`Unable to read Kiro token cache directory ${cacheDir}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const validCandidates: TokenCandidate[] = []
  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      const [token, info] = await Promise.all([readTokenFile(candidate), stat(candidate)])
      validCandidates.push({
        path: candidate,
        token,
        mtimeMs: info.mtimeMs,
        preferredNameRank: preferredNameScore(candidate),
      })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (validCandidates.length > 0) {
    validCandidates.sort(compareTokenCandidates)
    return validCandidates[0]!.path
  }

  const searched = candidates.map((candidate) => `- ${candidate}`).join('\n')
  throw new Error(`Could not find a valid Kiro token file. Searched:\n${searched}${lastError ? `\nLast error: ${lastError.message}` : ''}`)
}

async function readTokenFile(path: string): Promise<KiroToken> {
  const raw = await readFile(path, 'utf8')
  const token = JSON.parse(raw) as KiroToken
  validateToken(token)
  return token
}

function compareTokenCandidates(a: TokenCandidate, b: TokenCandidate): number {
  const aFresh = tokenFreshnessScore(a.token)
  const bFresh = tokenFreshnessScore(b.token)
  if (aFresh !== bFresh) return bFresh - aFresh
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  if (a.preferredNameRank !== b.preferredNameRank) return a.preferredNameRank - b.preferredNameRank
  return a.path.localeCompare(b.path)
}

function tokenFreshnessScore(token: KiroToken): number {
  const expiresAt = new Date(token.expiresAt).getTime()
  return Number.isFinite(expiresAt) ? expiresAt : 0
}

function preferredNameScore(path: string): number {
  const filename = path.split('/').pop() ?? path
  const index = TOKEN_FILENAMES.indexOf(filename as typeof TOKEN_FILENAMES[number])
  return index === -1 ? TOKEN_FILENAMES.length : index
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

export async function callKiroApi(payload: KiroPayload, onEvent: (event: KiroStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  // Truncate payload if too large
  truncatePayload(payload)
  let pairingRepairs = repairKiroToolResultPairing(payload)
  if (payloadSize(payload) > MAX_PAYLOAD_BYTES) {
    truncatePayload(payload)
    pairingRepairs = mergeToolPairingRepairStats(pairingRepairs, repairKiroToolResultPairing(payload))
  }
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
    debug(`[runtime] request ${summarizeKiroPayload(payload, body, pairingRepairs)}`)

    if (!token.profileArn) throw new Error('Kiro token does not contain profileArn')

    const resp = await new Promise<IncomingMessage>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Request aborted')); return }
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
      signal?.addEventListener('abort', () => req.destroy(new Error('Request aborted')), { once: true })
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
      debug(`[runtime] failed request ${summarizeKiroPayload(payload, body, pairingRepairs)}`)
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

type ToolPairingRepairStats = { addedMissingResults: number; removedOrphanResults: number }

function mergeToolPairingRepairStats(a: ToolPairingRepairStats, b: ToolPairingRepairStats): ToolPairingRepairStats {
  return {
    addedMissingResults: a.addedMissingResults + b.addedMissingResults,
    removedOrphanResults: a.removedOrphanResults + b.removedOrphanResults,
  }
}

function payloadSize(payload: KiroPayload): number {
  return Buffer.byteLength(JSON.stringify(payload))
}

export function repairKiroToolResultPairing(payload: KiroPayload): ToolPairingRepairStats {
  const stats = { addedMissingResults: 0, removedOrphanResults: 0 }
  let previousToolUseIds: string[] = []
  const entries = [...payload.conversationState.history, payload.conversationState.currentMessage]

  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const user = entry['userInputMessage']
    if (isRecord(user)) {
      repairUserToolResults(user, previousToolUseIds, stats)
      previousToolUseIds = []
      continue
    }

    const assistant = entry['assistantResponseMessage']
    if (!isRecord(assistant)) continue
    previousToolUseIds = Array.isArray(assistant['toolUses'])
      ? assistant['toolUses'].map(readToolUseId).filter((id): id is string => !!id)
      : []
  }

  return stats
}

function repairUserToolResults(message: Record<string, unknown>, expectedToolUseIds: string[], stats: ToolPairingRepairStats): void {
  const context = message['userInputMessageContext']
  const expected = new Set(expectedToolUseIds)
  const contextRecord = isRecord(context) ? context : undefined
  const rawToolResults = contextRecord && Array.isArray(contextRecord['toolResults']) ? contextRecord['toolResults'] : []

  const kept: unknown[] = []
  for (const result of rawToolResults) {
    const id = readToolResultId(result)
    if (!id || !expected.has(id)) {
      stats.removedOrphanResults++
      continue
    }
    expected.delete(id)
    kept.push(result)
  }

  for (const toolUseId of expected) {
    kept.push(buildInterruptedRuntimeToolResult(toolUseId))
    stats.addedMissingResults++
  }

  if (!contextRecord && !kept.length) return
  const targetContext = contextRecord ?? ensureMessageContext(message)
  if (kept.length) targetContext['toolResults'] = kept
  else delete targetContext['toolResults']
}

function ensureMessageContext(message: Record<string, unknown>): Record<string, unknown> {
  const existing = message['userInputMessageContext']
  if (isRecord(existing)) return existing
  const context: Record<string, unknown> = { envState: {} }
  message['userInputMessageContext'] = context
  return context
}

function readToolUseId(toolUse: unknown): string | undefined {
  return isRecord(toolUse) && typeof toolUse['toolUseId'] === 'string' ? toolUse['toolUseId'] : undefined
}

function readToolResultId(result: unknown): string | undefined {
  return isRecord(result) && typeof result['toolUseId'] === 'string' ? result['toolUseId'] : undefined
}

function buildInterruptedRuntimeToolResult(toolUseId: string): { toolUseId: string; content: { text: string }[]; status: string } {
  return {
    toolUseId,
    content: [{ text: 'Tool use was interrupted before a result was returned.' }],
    status: 'error',
  }
}

function summarizeKiroPayload(payload: KiroPayload, body: string, repairs: ToolPairingRepairStats): string {
  const current = payload.conversationState.currentMessage.userInputMessage
  const currentRecord = isRecord(current) ? current : {}
  const context = isRecord(currentRecord['userInputMessageContext']) ? currentRecord['userInputMessageContext'] : {}
  const tools = Array.isArray(context['tools']) ? context['tools'].length : 0
  const currentToolResults = Array.isArray(context['toolResults']) ? context['toolResults'].length : 0
  const content = typeof currentRecord['content'] === 'string' ? currentRecord['content'] : ''
  const fields = [
    `body_bytes=${Buffer.byteLength(body)}`,
    `modelId=${String(currentRecord['modelId'] ?? '')}`,
    `history_len=${payload.conversationState.history.length}`,
    `current_content_bytes=${Buffer.byteLength(content)}`,
    `tools=${tools}`,
    `current_tool_results=${currentToolResults}`,
    `repairs=missing:${repairs.addedMissingResults},orphan:${repairs.removedOrphanResults}`,
    `history_head=${summarizeHistoryHead(payload.conversationState.history)}`,
    `history_tail=${summarizeHistoryTail(payload.conversationState.history)}`,
  ]
  return fields.join(' ')
}

function summarizeHistoryHead(history: unknown[]): string {
  return summarizeHistorySlice(history, 0, Math.min(6, history.length))
}

function summarizeHistoryTail(history: unknown[]): string {
  const start = Math.max(0, history.length - 8)
  return summarizeHistorySlice(history, start, history.length)
}

function summarizeHistorySlice(history: unknown[], start: number, end: number): string {
  const parts: string[] = []
  for (let i = start; i < end; i++) {
    const entry = history[i]
    if (!isRecord(entry)) {
      parts.push(`${i}:unknown`)
      continue
    }
    const user = entry['userInputMessage']
    if (isRecord(user)) {
      const context = isRecord(user['userInputMessageContext']) ? user['userInputMessageContext'] : {}
      const toolResults = Array.isArray(context['toolResults']) ? context['toolResults'].length : 0
      const images = Array.isArray(user['images']) ? user['images'].length : 0
      parts.push(`${i}:user(c=${stringBytes(user['content'])},tr=${toolResults},img=${images})`)
      continue
    }
    const assistant = entry['assistantResponseMessage']
    if (isRecord(assistant)) {
      const toolUses = Array.isArray(assistant['toolUses']) ? assistant['toolUses'].length : 0
      parts.push(`${i}:assistant(c=${stringBytes(assistant['content'])},tu=${toolUses})`)
      continue
    }
    parts.push(`${i}:unknown`)
  }
  return parts.join(',')
}

function stringBytes(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value) : 0
}

function prefixKeepCount(history: unknown[]): number {
  const keep = Math.min(2, history.length)
  if (keep === 0) return 0

  const lastPrefixEntry = history[keep - 1]
  if (!isAssistantWithToolUses(lastPrefixEntry)) return keep

  return Math.min(keep + 1, history.length)
}

function isAssistantWithToolUses(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  const assistant = entry['assistantResponseMessage']
  return isRecord(assistant) && Array.isArray(assistant['toolUses']) && assistant['toolUses'].length > 0
}

export function truncatePayload(payload: KiroPayload): void {
  const size = () => payloadSize(payload)
  if (size() <= MAX_PAYLOAD_BYTES) return

  const history = payload.conversationState.history
  // Smart truncation: keep system priming plus any required tool result turn.
  const keepStart = prefixKeepCount(history)
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

  if (size() <= MAX_PAYLOAD_BYTES) return
  truncateMessage(payload.conversationState.currentMessage.userInputMessage)
  for (const entry of history) truncateHistoryEntry(entry)

  while (history.length > keepStart && size() > MAX_PAYLOAD_BYTES) {
    history.splice(keepStart, 1)
  }
}

function truncateHistoryEntry(entry: unknown): void {
  if (!isRecord(entry)) return
  if (isRecord(entry['userInputMessage'])) truncateMessage(entry['userInputMessage'])
  if (isRecord(entry['assistantResponseMessage'])) {
    const message = entry['assistantResponseMessage']
    truncateStringField(message, 'content', MAX_CONTENT_TEXT_BYTES)
  }
}

function truncateMessage(message: unknown): void {
  if (!isRecord(message)) return
  truncateStringField(message, 'content', MAX_CONTENT_TEXT_BYTES)
  const context = message['userInputMessageContext']
  if (isRecord(context) && Array.isArray(context['toolResults'])) {
    for (const result of context['toolResults']) truncateToolResult(result)
  }
}

function truncateToolResult(result: unknown): void {
  if (!isRecord(result) || !Array.isArray(result['content'])) return
  for (const block of result['content']) {
    if (isRecord(block)) truncateStringField(block, 'text', MAX_TOOL_RESULT_TEXT_BYTES)
  }
}

function truncateStringField(record: Record<string, unknown>, key: string, maxBytes: number): void {
  const value = record[key]
  if (typeof value !== 'string') return
  if (Buffer.byteLength(value) <= maxBytes) return
  record[key] = `${truncateUtf8(value, maxBytes)}\n[truncated]`
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  for (const char of value) {
    const next = Buffer.byteLength(char)
    if (bytes + next > maxBytes) break
    bytes += next
    out += char
  }
  return out
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
  onEvent({ type: 'tool_use', toolUse: { toolUseId: s.toolUseId, name: s.name, input: normalizeToolInputForClient(s.name, input) } })
}

export function normalizeToolInputForClient(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!isAskUserQuestionTool(name)) return input
  if (Array.isArray(input['questions'])) return normalizeAskUserQuestionInput(input)

  const question = readString(input, 'question') ?? readString(input, 'prompt') ?? 'Please choose an option?'
  const rawChoices = readArray(input, 'options') ?? readArray(input, 'choices') ?? []
  const options = normalizeAskUserOptions(rawChoices)
  if (options.length < 2) return input

  return {
    questions: [{
      question: ensureQuestionMark(question),
      header: shortHeader(readString(input, 'header') ?? question),
      options,
      multiSelect: input['multiSelect'] === true || input['multi_select'] === true,
    }],
  }
}

function isAskUserQuestionTool(name: string): boolean {
  return name === 'AskUserQuestion' || name === 'askUserQuestion' || name === 'ask_user_question' || name === 'ask_user'
}

function normalizeAskUserQuestionInput(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    questions: (input['questions'] as unknown[]).map((question) => {
      if (!isRecord(question)) return question
      const rawOptions = Array.isArray(question['options'])
        ? question['options']
        : Array.isArray(question['choices'])
          ? question['choices']
          : []
      return {
        ...question,
        question: ensureQuestionMark(readString(question, 'question') ?? 'Please choose an option?'),
        header: shortHeader(readString(question, 'header') ?? readString(question, 'question') ?? 'Question'),
        options: normalizeAskUserOptions(rawOptions),
        multiSelect: question['multiSelect'] === true || question['multi_select'] === true,
      }
    }),
  }
}

function normalizeAskUserOptions(rawOptions: unknown[]): { label: string; description: string; preview?: string }[] {
  return rawOptions.slice(0, 4).map((option, index) => {
    if (typeof option === 'string') return { label: shortLabel(option, index), description: option }
    if (isRecord(option)) {
      const label = shortLabel(readString(option, 'label') ?? readString(option, 'title') ?? readString(option, 'value') ?? `Option ${index + 1}`, index)
      const description = readString(option, 'description') ?? readString(option, 'detail') ?? label
      const preview = readString(option, 'preview')
      return preview ? { label, description, preview } : { label, description }
    }
    return { label: `Option ${index + 1}`, description: String(option) }
  })
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key]
  return Array.isArray(value) ? value : undefined
}

function shortHeader(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 12) || 'Question'
}

function shortLabel(value: string, index: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 40) || `Option ${index + 1}`
}

function ensureQuestionMark(value: string): string {
  const trimmed = value.trim()
  return /[?？]$/u.test(trimmed) ? trimmed : `${trimmed}?`
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
