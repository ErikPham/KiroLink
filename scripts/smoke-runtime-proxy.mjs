#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_PROMPT = 'Reply with exactly: OK'
const DEFAULT_ROUNDTRIP_PROMPT = 'Use smoke_tool_0 with value ping. Do not answer directly.'
const DEFAULT_MODEL = 'claude-sonnet-4.6'

function usage() {
  process.stdout.write(`Usage: pnpm run runtime:smoke -- [options]

Starts the built proxy locally and sends one minimal Anthropic-compatible
request through it. This calls the live Kiro runtime and may consume quota.

Options:
  --model <id>      Model id (default: ${DEFAULT_MODEL})
  --prompt <text>   Prompt (default: "${DEFAULT_PROMPT}")
  --port <port>     Local port (default: random high port)
  --tools <n>       Include n no-op Anthropic tools (default: 0)
  --roundtrip       Verify tool_use -> tool_result -> final answer
  --tool-result <s> Tool result text for --roundtrip (default: "tool returned: pong")
  -h, --help        Show this help

Run pnpm build first if dist/index.js does not exist.
`)
}

function parseArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    prompt: DEFAULT_PROMPT,
    port: String(45000 + Math.floor(Math.random() * 1000)),
    tools: '0',
    roundtrip: false,
    toolResult: 'tool returned: pong',
    promptProvided: false,
  }
  const readValue = (arg, index) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
    return value
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '-h' || arg === '--help') return { help: true, options }
    if (arg === '--model') options.model = readValue(arg, i++)
    else if (arg === '--prompt') { options.prompt = readValue(arg, i++); options.promptProvided = true }
    else if (arg === '--port') options.port = readValue(arg, i++)
    else if (arg === '--tools') options.tools = readValue(arg, i++)
    else if (arg === '--roundtrip') options.roundtrip = true
    else if (arg === '--tool-result') options.toolResult = readValue(arg, i++)
    else throw new Error(`Unknown option: ${arg}`)
  }
  return { help: false, options }
}

function buildSmokeTools(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `smoke_tool_${i}`,
    description: 'No-op smoke test tool. The model should not call this unless explicitly asked.',
    input_schema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      additionalProperties: false,
    },
  }))
}

async function waitForHealth(port, child) {
  const url = `http://127.0.0.1:${port}/health`
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) throw new Error(`proxy exited before health check completed with code ${child.exitCode}`)
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error('proxy health check timed out')
}

async function sendMessage(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: 'Bearer smoke',
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
}

function summarizeMessageResult(result) {
  return {
    status: result.status,
    ok: result.ok,
    stop_reason: result.body?.stop_reason,
    content: result.body?.content,
  }
}

async function runSingleSmoke(options, port, tools) {
  return sendMessage(port, {
    model: options.model,
    max_tokens: 32,
    messages: [{ role: 'user', content: options.prompt }],
    ...(tools.length ? { tools } : {}),
  })
}

async function runRoundtripSmoke(options, port, tools) {
  const prompt = options.promptProvided ? options.prompt : DEFAULT_ROUNDTRIP_PROMPT
  const first = await sendMessage(port, {
    model: options.model,
    max_tokens: 64,
    messages: [{ role: 'user', content: prompt }],
    tools,
  })
  const toolUse = first.body?.content?.find?.((block) => block.type === 'tool_use')
  let second = null

  if (toolUse) {
    second = await sendMessage(port, {
      model: options.model,
      max_tokens: 64,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: [toolUse] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: options.toolResult }] },
      ],
      tools,
    })
  }

  return {
    first,
    second,
    pass: first.ok && Boolean(toolUse) && Boolean(second?.ok) && second?.body?.stop_reason === 'end_turn',
  }
}

async function main() {
  const { help, options } = parseArgs(process.argv.slice(2))
  if (help) {
    usage()
    return
  }

  const dist = resolve('dist/index.js')
  if (!existsSync(dist)) throw new Error('dist/index.js not found. Run `pnpm build` first.')
  const toolCount = options.roundtrip && options.tools === '0' ? 1 : Number(options.tools)
  if (!Number.isSafeInteger(toolCount) || toolCount < 0) throw new Error('--tools must be a non-negative integer')
  if (options.roundtrip && toolCount < 1) throw new Error('--roundtrip requires at least one tool')
  const tools = buildSmokeTools(toolCount)

  const child = spawn(process.execPath, [dist, '--host', '127.0.0.1', '--port', options.port, '--quiet'], {
    env: { ...process.env, KIRO_PROXY_DUMP_FAILED_PAYLOAD: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  try {
    await waitForHealth(options.port, child)
    if (options.roundtrip) {
      const result = await runRoundtripSmoke(options, options.port, tools)
      process.stdout.write(JSON.stringify({
        mode: 'roundtrip',
        ok: result.pass,
        model: options.model,
        tools: toolCount,
        first: summarizeMessageResult(result.first),
        second: result.second ? summarizeMessageResult(result.second) : null,
      }, null, 2) + '\n')
      if (!result.pass) process.exitCode = 1
    } else {
      const result = await runSingleSmoke(options, options.port, tools)
      process.stdout.write(JSON.stringify({
        mode: 'single',
        status: result.status,
        ok: result.ok,
        model: options.model,
        tools: toolCount,
        body: result.body,
      }, null, 2) + '\n')
      if (!result.ok) process.exitCode = 1
    }
  } finally {
    child.kill('SIGTERM')
    if (stderr.trim()) process.stderr.write(stderr)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('Run `pnpm run runtime:smoke -- --help` for usage.\n')
  process.exitCode = 1
})
