#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TOKEN_PATH = join(homedir(), '.aws/sso/cache/kiro-auth-token-cli.json')
const API_URL = 'https://runtime.us-east-1.kiro.dev/'
const DEFAULT_MODEL = 'claude-sonnet-4.6'
const DEFAULT_PROMPT = 'Reply with exactly: OK'
const MAX_BODY_BYTES = 16 * 1024

function usage() {
  process.stdout.write(`Usage: pnpm run runtime:probe -- [options]

Sends direct live Kiro runtime probes with sanitized output. This may consume
Kiro quota. It compares service camelCase and Kiro CLI recording-like snake_case
payload shapes without printing tokens or raw request bodies.

Options:
  --shape <name>    camel, snake, or both (default: both)
  --expect <mode>   current, all-ok, or none (default: current)
  --model <id>      Model id (default: ${DEFAULT_MODEL})
  --prompt <text>   Prompt (default: "${DEFAULT_PROMPT}")
  --tools <n>       Include n no-op tools (default: 0)
  --thinking        Include additionalModelRequestFields/output_config
  -h, --help        Show this help
`)
}

function parseArgs(argv) {
  const options = { shape: 'both', expect: 'current', model: DEFAULT_MODEL, prompt: DEFAULT_PROMPT, tools: '0', thinking: false }
  const readValue = (arg, index) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
    return value
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '-h' || arg === '--help') return { help: true, options }
    if (arg === '--shape') options.shape = readValue(arg, i++)
    else if (arg === '--expect') options.expect = readValue(arg, i++)
    else if (arg === '--model') options.model = readValue(arg, i++)
    else if (arg === '--prompt') options.prompt = readValue(arg, i++)
    else if (arg === '--tools') options.tools = readValue(arg, i++)
    else if (arg === '--thinking') options.thinking = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!['camel', 'snake', 'both'].includes(options.shape)) throw new Error('--shape must be camel, snake, or both')
  if (!['current', 'all-ok', 'none'].includes(options.expect)) throw new Error('--expect must be current, all-ok, or none')
  return { help: false, options }
}

async function loadToken() {
  const raw = await readFile(process.env.KIRO_PROXY_TOKEN_PATH ?? TOKEN_PATH, 'utf8')
  const token = JSON.parse(raw)
  if (!token?.accessToken || !token?.profileArn) throw new Error('Kiro token file is missing accessToken/profileArn')
  const expiresAt = new Date(token.expiresAt).getTime()
  if (Number.isFinite(expiresAt) && Date.now() > expiresAt - 60_000) {
    await new Promise((resolve, reject) => {
      execFile('kiro-cli', ['chat', '--list-models'], { timeout: 15_000 }, (err) => err ? reject(err) : resolve())
    })
    return loadToken()
  }
  return token
}

function buildCamelTools(count) {
  return Array.from({ length: count }, (_, i) => ({
    toolSpecification: {
      name: `smoke_tool_${i}`,
      description: 'No-op smoke test tool.',
      inputSchema: { json: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } },
    },
  }))
}

function buildSnakeTools(count) {
  return Array.from({ length: count }, (_, i) => ({
    ToolSpecification: {
      name: `smoke_tool_${i}`,
      description: 'No-op smoke test tool.',
      input_schema: { json: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } },
    },
  }))
}

function envStateCamel() {
  return {
    operatingSystem: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    currentWorkingDirectory: process.cwd(),
  }
}

function envStateSnake() {
  return {
    operating_system: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    current_working_directory: process.cwd(),
    environment_variables: [],
  }
}

function buildPayload(shape, options, profileArn, toolCount) {
  const id = randomUUID()
  if (shape === 'camel') {
    return {
      conversationState: {
        conversationId: id,
        history: [],
        currentMessage: {
          userInputMessage: {
            content: options.prompt,
            userInputMessageContext: {
              envState: envStateCamel(),
              ...(toolCount ? { tools: buildCamelTools(toolCount) } : {}),
            },
            origin: 'KIRO_CLI',
            modelId: options.model,
          },
        },
        chatTriggerType: 'MANUAL',
      },
      profileArn,
      agentMode: 'VIBE',
      ...(options.thinking ? { additionalModelRequestFields: { output_config: { effort: 'low' } } } : {}),
    }
  }

  return {
    conversation_id: id,
    user_input_message: {
      content: options.prompt,
      user_input_message_context: {
        env_state: envStateSnake(),
        git_state: null,
        tool_results: null,
        tools: toolCount ? buildSnakeTools(toolCount) : [],
      },
      user_intent: null,
      images: null,
      model_id: options.model,
    },
    history: [],
    agent_continuation_id: null,
    profile_arn: profileArn,
    agent_mode: 'VIBE',
    ...(options.thinking ? { additional_model_request_fields: { output_config: { effort: 'low' } } } : {}),
  }
}

function summarizePayload(shape, payload, toolCount, thinking) {
  if (shape === 'camel') {
    const current = payload.conversationState?.currentMessage?.userInputMessage
    const context = current?.userInputMessageContext ?? {}
    const firstTool = Array.isArray(context.tools) ? context.tools[0] : undefined
    const toolSpec = firstTool?.toolSpecification
    return {
      topLevelKeys: Object.keys(payload).sort(),
      conversationStateKeys: Object.keys(payload.conversationState ?? {}).sort(),
      messageKeys: Object.keys(current ?? {}).sort(),
      contextKeys: Object.keys(context).sort(),
      toolCount,
      toolWrapper: toolSpec ? 'toolSpecification' : null,
      schemaKey: toolSpec?.inputSchema ? 'inputSchema' : null,
      thinking,
      thinkingKey: payload.additionalModelRequestFields ? 'additionalModelRequestFields' : null,
    }
  }

  const context = payload.user_input_message?.user_input_message_context ?? {}
  const firstTool = Array.isArray(context.tools) ? context.tools[0] : undefined
  const toolSpec = firstTool?.ToolSpecification
  return {
    topLevelKeys: Object.keys(payload).sort(),
    messageKeys: Object.keys(payload.user_input_message ?? {}).sort(),
    contextKeys: Object.keys(context).sort(),
    toolCount,
    toolWrapper: toolSpec ? 'ToolSpecification' : null,
    schemaKey: toolSpec?.input_schema ? 'input_schema' : null,
    thinking,
    thinkingKey: payload.additional_model_request_fields ? 'additional_model_request_fields' : null,
  }
}

function userAgent() {
  const v = process.env.KIRO_CLI_VERSION ?? '2.5.1'
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  return `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/${os} lang/rust/1.92.0 exec-env/AmazonQ-For-CLI Version/${v} md/appVersion-${v} app/AmazonQ-For-CLI`
}

function sendRuntime(payload, token) {
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const url = new URL(process.env.KIRO_PROXY_API_URL ?? API_URL)
    const req = request({
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token.accessToken}`,
        'User-Agent': userAgent(),
        'x-amz-user-agent': userAgent(),
        'x-amzn-codewhisperer-optout': process.env.KIRO_PROXY_CODEWHISPERER_OPTOUT ?? 'true',
        'Amz-Sdk-Invocation-Id': randomUUID(),
        'Amz-Sdk-Request': 'attempt=1; max=1',
        Accept: '*/*',
      },
    }, async (res) => {
      const chunks = []
      let total = 0
      for await (const chunk of res) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total <= MAX_BODY_BYTES) chunks.push(buf)
      }
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated: total > MAX_BODY_BYTES })
    })
    req.setTimeout(120_000, () => req.destroy(new Error('runtime probe timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

function readEventHeaders(buf) {
  let offset = 0
  const headers = {}
  while (offset < buf.length) {
    const nameLen = buf[offset]; offset += 1
    if (!nameLen || offset + nameLen > buf.length) break
    const name = buf.subarray(offset, offset + nameLen).toString(); offset += nameLen
    const valueType = buf[offset]; offset += 1
    if (valueType === 7) {
      const valueLen = buf.readUInt16BE(offset); offset += 2
      headers[name] = buf.subarray(offset, offset + valueLen).toString()
      offset += valueLen
    } else if (valueType === 6) {
      const valueLen = buf.readUInt16BE(offset); offset += 2 + valueLen
    } else {
      const sizes = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
      offset += sizes[valueType] ?? 0
    }
  }
  return headers
}

function summarizeEventStream(body) {
  const events = []
  let offset = 0
  while (offset + 16 <= body.length && events.length < 8) {
    const totalLength = body.readUInt32BE(offset)
    const headersLength = body.readUInt32BE(offset + 4)
    if (totalLength < 16 || offset + totalLength > body.length || headersLength > totalLength - 16) break
    const headers = readEventHeaders(body.subarray(offset + 12, offset + 12 + headersLength))
    const payload = body.subarray(offset + 12 + headersLength, offset + totalLength - 4)
    let json = null
    try { json = payload.length ? JSON.parse(payload.toString()) : null } catch {}
    events.push({
      eventType: headers[':event-type'] ?? null,
      kind: json?.kind ?? null,
      dataKeys: json?.data && typeof json.data === 'object' ? Object.keys(json.data).sort() : json && typeof json === 'object' ? Object.keys(json).sort() : [],
    })
    offset += totalLength
  }
  return events
}

function summarizeBody(res) {
  const contentType = String(res.headers['content-type'] ?? '')
  if (res.status === 200 && res.body.length && !contentType.includes('json')) {
    const events = summarizeEventStream(res.body)
    return { eventCount: events.length, events, truncated: res.truncated }
  }
  const text = res.body.toString()
  try {
    const json = JSON.parse(text)
    return { json: sanitizeJson(json), truncated: res.truncated }
  } catch {
    return { text: text.slice(0, 2000), truncated: res.truncated }
  }
}

function parseJsonBody(res) {
  try {
    return JSON.parse(res.body.toString())
  } catch {
    return null
  }
}

function classifyExpectation(shape, res, options) {
  if (options.expect === 'none') return { mode: options.expect, pass: true, expected: 'not checked' }
  if (options.expect === 'all-ok') {
    return {
      mode: options.expect,
      pass: res.status === 200,
      expected: 'HTTP 200',
    }
  }

  if (shape === 'camel') {
    return {
      mode: options.expect,
      pass: res.status === 200,
      expected: 'HTTP 200 from generated service camelCase shape',
    }
  }

  const json = parseJsonBody(res)
  const rejectedAsInvalidBody = res.status === 400 && json?.reason === 'REQUEST_BODY_INVALID'
  return {
    mode: options.expect,
    pass: rejectedAsInvalidBody,
    expected: 'HTTP 400 REQUEST_BODY_INVALID for Kiro CLI recording-like snake_case shape',
  }
}

function sanitizeJson(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitizeJson)
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = /token|authorization|profileArn|profile_arn/iu.test(key) ? '[REDACTED]' : sanitizeJson(child)
  }
  return out
}

async function main() {
  const { help, options } = parseArgs(process.argv.slice(2))
  if (help) {
    usage()
    return
  }
  const toolCount = Number(options.tools)
  if (!Number.isSafeInteger(toolCount) || toolCount < 0) throw new Error('--tools must be a non-negative integer')

  const shapes = options.shape === 'both' ? ['camel', 'snake'] : [options.shape]
  const token = await loadToken()
  const results = []
  for (const shape of shapes) {
    const payload = buildPayload(shape, options, token.profileArn, toolCount)
    const res = await sendRuntime(payload, token)
    results.push({
      shape,
      status: res.status,
      ok: res.status === 200,
      requestShape: summarizePayload(shape, payload, toolCount, options.thinking),
      response: summarizeBody(res),
      expectation: classifyExpectation(shape, res, options),
    })
  }
  const pass = results.every((result) => result.expectation.pass)
  process.stdout.write(JSON.stringify({ model: options.model, expect: options.expect, pass, results }, null, 2) + '\n')
  if (!pass) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('Run `pnpm run runtime:probe -- --help` for usage.\n')
  process.exitCode = 1
})
