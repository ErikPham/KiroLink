import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { callKiroApi, setVerbose, type KiroStreamEvent } from './kiro-api'
import { anthropicToKiro, buildAnthropicResponse, openaiToKiro, type AnthropicContentBlock, type AnthropicRequest, type OpenAIRequest } from './translator'
import { configureThrottle, throttled } from './throttle'
import type { ProxyConfig } from './config'
import { assertSafeBind, isLocalHost } from './config'
import { InvalidRequestError, RuntimeApiError } from './errors'

export function createKiroProxyServer(config: ProxyConfig): Server {
  assertSafeBind(config)
  configureThrottle(config.maxConcurrent, config.delayMs)
  setVerbose(config.verbose)
  const log = config.quiet ? () => {} : (msg: string) => process.stderr.write(`${msg}\n`)

  return createServer((req, res) => { void handle(req, res, config, log) })
}

async function handle(req: IncomingMessage, res: ServerResponse, config: ProxyConfig, log: (msg: string) => void): Promise<void> {
  const path = req.url?.split('?')[0] ?? ''
  log(`${req.method} ${path}`)

  setCorsHeaders(req, res, config)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    if (req.method === 'HEAD' && path === '/') { res.writeHead(200); res.end(); return }
    if (req.method === 'GET' && path === '/health') { json(res, 200, { ok: true }); return }

    if (config.apiKey && !checkAuth(req, config.apiKey)) { json(res, 401, { error: { type: 'authentication_error', message: 'Unauthorized' } }); return }

    if (req.method === 'POST' && (path === '/api/event_logging/batch' || path === '/api/event_logging/v2/batch')) { await drain(req, config.maxBodyBytes); json(res, 200, { status: 'ok' }); return }

    if (req.method === 'GET' && path === '/v1/models') { json(res, 200, modelsResponse()); return }
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') { const r = await body<AnthropicRequest>(req, config.maxBodyBytes); json(res, 200, { input_tokens: Math.max(1, Math.ceil(JSON.stringify(r).length / 4)) }); return }
    if (req.method === 'POST' && path === '/v1/messages') {
      const request = await body<AnthropicRequest>(req, config.maxBodyBytes)
      log(`  → model=${request.model} stream=${request.stream} tools=${request.tools?.length ?? 0}`)
      await handleMessages(res, request, log)
      return
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      const request = await body<OpenAIRequest>(req, config.maxBodyBytes)
      log(`  → model=${request.model} stream=${request.stream} tools=${request.tools?.length ?? 0}`)
      await handleOpenAI(res, request, log)
      return
    }
    json(res, 404, { error: { type: 'not_found_error', message: 'Not found' } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`  ✗ ${msg}`)
    const headers = error instanceof RuntimeApiError && error.retryAfterSeconds !== undefined
      ? { 'Retry-After': String(error.retryAfterSeconds) }
      : undefined
    if (!res.headersSent) json(res, statusForError(error), { error: { type: errorTypeForError(error), message: msg } }, headers)
    else { sse(res, 'error', { type: 'error', error: { type: 'api_error', message: msg } }); res.end() }
  }
}

async function handleMessages(res: ServerResponse, request: AnthropicRequest, log: (msg: string) => void): Promise<void> {
  const model = request.model
  const payload = anthropicToKiro(request)

  if (request.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const msgId = `msg_${randomUUID().replace(/-/gu, '')}`
    sse(res, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })

    let idx = 0, inText = false, inThink = false, hasToolUse = false, inTok = 0, outTok = 0
    const closeBlock = () => { sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx }); idx++ }

    await throttled(() => callKiroApi(payload, (ev) => {
      switch (ev.type) {
        case 'text':
          if (inThink) { closeBlock(); inThink = false }
          if (!inText) { sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }); inText = true }
          sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: ev.text } })
          break
        case 'thinking':
          if (inText) { closeBlock(); inText = false }
          if (!inThink) { sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } }); inThink = true }
          sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: ev.text } })
          break
        case 'tool_use':
          if (inText) { closeBlock(); inText = false }
          if (inThink) { closeBlock(); inThink = false }
          hasToolUse = true
          sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: ev.toolUse.toolUseId, name: ev.toolUse.name, input: {} } })
          sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(ev.toolUse.input) } })
          closeBlock()
          break
        case 'done': inTok = ev.inputTokens; outTok = ev.outputTokens; break
      }
    }))

    if (inText || inThink) closeBlock()
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outTok } })
    sse(res, 'message_stop', { type: 'message_stop' })
    res.end()
    log(`  ✓ stream done`)
    return
  }

  // Non-stream
  const blocks: AnthropicContentBlock[] = []
  let thinkBuf = '', textBuf = '', inTok = 0, outTok = 0
  await throttled(() => callKiroApi(payload, (ev) => {
    switch (ev.type) {
      case 'text': textBuf += ev.text; break
      case 'thinking': thinkBuf += ev.text; break
      case 'tool_use': if (textBuf) { blocks.push({ type: 'text', text: textBuf }); textBuf = '' }; blocks.push({ type: 'tool_use', id: ev.toolUse.toolUseId, name: ev.toolUse.name, input: ev.toolUse.input }); break
      case 'done': inTok = ev.inputTokens; outTok = ev.outputTokens; break
    }
  }))
  if (thinkBuf) blocks.unshift({ type: 'thinking', thinking: thinkBuf })
  if (textBuf) blocks.push({ type: 'text', text: textBuf })
  if (!blocks.length) blocks.push({ type: 'text', text: '' })
  json(res, 200, buildAnthropicResponse(model, blocks, inTok, outTok))
  log(`  ✓ done`)
}

function modelsResponse(): unknown {
  const families = ['claude-opus', 'claude-sonnet', 'claude-haiku']
  const versions = ['4', '4.5', '4-5', '4.6', '4-6', '4.7', '4-7', '4.8', '4-8']
  const ids: string[] = []
  for (const f of families) for (const v of versions) { ids.push(`${f}-${v}`); ids.push(`${f}-${v}[1m]`) }
  ids.push('claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-haiku-4-20250414', 'claude-sonnet-4-8-20260611', 'claude-opus-4-8-20260611', 'claude-sonnet-4.5-20250620', 'claude-opus-4.5-20250620', 'claude-sonnet-4-6-20260601', 'claude-opus-4-6-20260601')
  return { object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'anthropic', modalities: { input: ['text', 'image'], output: ['text'] }, capabilities: { vision: true, image: true } })) }
}

function checkAuth(req: IncomingMessage, key: string): boolean {
  const auth = firstHeader(req.headers['authorization'])
  if (auth === `Bearer ${key}`) return true
  const xkey = firstHeader(req.headers['x-api-key'])
  return xkey === key
}

async function drain(req: IncomingMessage, maxBytes: number): Promise<void> {
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw new Error('Request body is too large')
  }
}
async function body<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buf.length
    if (size > maxBytes) throw new Error('Request body is too large')
    chunks.push(buf)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as T
  } catch {
    throw new Error('Invalid JSON request body')
  }
}
function json(res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>): void { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)) }
function sse(res: ServerResponse, event: string, data: unknown): void { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

function setCorsHeaders(req: IncomingMessage, res: ServerResponse, config: ProxyConfig): void {
  const origin = firstHeader(req.headers.origin)
  if (!origin) return
  if (isLocalHost(config.host) && isLocalOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key')
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return isLocalHost(url.hostname)
  } catch {
    return false
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function statusForError(error: unknown): number {
  if (!(error instanceof Error)) return 500
  if (error instanceof InvalidRequestError) return 400
  if (error instanceof RuntimeApiError) {
    if (error.statusCode === 429) return 429
    if (error.statusCode === 400 || error.statusCode === 413) return error.statusCode
    if (error.statusCode >= 500 && error.statusCode <= 599) return 503
    return 502
  }
  if (error.message === 'Request body is too large') return 413
  if (error.message === 'Invalid JSON request body') return 400
  return 500
}

function errorTypeForError(error: unknown): string {
  if (!(error instanceof Error)) return 'api_error'
  if (error instanceof InvalidRequestError || error.message === 'Request body is too large' || error.message === 'Invalid JSON request body') return 'invalid_request_error'
  if (error instanceof RuntimeApiError) {
    if (error.statusCode === 429) return 'rate_limit_error'
    if (error.statusCode === 400 || error.statusCode === 413) return 'invalid_request_error'
  }
  return 'api_error'
}

async function handleOpenAI(res: ServerResponse, request: OpenAIRequest, log: (msg: string) => void): Promise<void> {
  const model = request.model
  const payload = openaiToKiro(request)
  const chatId = `chatcmpl-${randomUUID()}`

  if (request.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })

    let hasToolCalls = false
    let toolCallIdx = 0
    let inTok = 0, outTok = 0

    await throttled(() => callKiroApi(payload, (ev) => {
      switch (ev.type) {
        case 'text':
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] })}\n\n`)
          break
        case 'thinking':
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: ev.text }, finish_reason: null }] })}\n\n`)
          break
        case 'tool_use':
          hasToolCalls = true
          const args = JSON.stringify(ev.toolUse.input)
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIdx, id: ev.toolUse.toolUseId, type: 'function', function: { name: ev.toolUse.name, arguments: args } }] }, finish_reason: null }] })}\n\n`)
          toolCallIdx++
          break
        case 'done': inTok = ev.inputTokens; outTok = ev.outputTokens; break
      }
    }))

    res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok } })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    log(`  ✓ stream done`)
    return
  }

  // Non-stream
  let content = '', reasoning = '', inTok = 0, outTok = 0
  const toolCalls: { id: string; type: string; function: { name: string; arguments: string } }[] = []

  await throttled(() => callKiroApi(payload, (ev) => {
    switch (ev.type) {
      case 'text': content += ev.text; break
      case 'thinking': reasoning += ev.text; break
      case 'tool_use': toolCalls.push({ id: ev.toolUse.toolUseId, type: 'function', function: { name: ev.toolUse.name, arguments: JSON.stringify(ev.toolUse.input) } }); break
      case 'done': inTok = ev.inputTokens; outTok = ev.outputTokens; break
    }
  }))

  const message: Record<string, unknown> = { role: 'assistant', content: content || null }
  if (reasoning) message['reasoning_content'] = reasoning
  if (toolCalls.length) message['tool_calls'] = toolCalls

  json(res, 200, {
    id: chatId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  })
  log(`  ✓ done`)
}
