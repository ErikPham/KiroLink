#!/usr/bin/env node
import { spawn } from 'node:child_process'

const DEFAULT_MODEL = 'claude-sonnet-4.6'

function usage() {
  process.stdout.write(`Usage: pnpm run runtime:matrix -- [options]

Runs the key live compatibility checks for KiroLink and prints a compact
summary. This consumes Kiro quota because every case hits the live runtime.

Options:
  --model <id>      Model id (default: ${DEFAULT_MODEL})
  --full            Include a stricter all-ok probe for camel-only requests
  --image           Include the current vision smoke case (expected to fail until fixed)
  -h, --help        Show this help
`)
}

function parseArgs(argv) {
  const options = { model: DEFAULT_MODEL, full: false, image: false }
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
    else if (arg === '--full') options.full = true
    else if (arg === '--image') options.image = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return { help: false, options }
}

function runNodeScript(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', reject)
  })
}

function parseJsonResult(name, result) {
  const text = result.stdout.trim()
  if (!text) throw new Error(`${name} did not produce JSON output`)
  try {
    return JSON.parse(text)
  } catch (error) {
    const details = result.stderr.trim() || text.slice(0, 500)
    throw new Error(`${name} produced invalid JSON: ${details}`)
  }
}

function summarizeProbeCase(name, json) {
  return {
    name,
    ok: Boolean(json.pass),
    kind: 'probe',
    detail: json.results.map((result) => `${result.shape}:${result.status}:${result.expectation?.pass ? 'pass' : 'fail'}`).join(', '),
  }
}

function summarizeSmokeCase(name, json) {
  if (json.mode === 'roundtrip') {
    return {
      name,
      ok: Boolean(json.ok),
      kind: 'smoke',
      detail: `first=${json.first?.stop_reason ?? 'unknown'}, second=${json.second?.stop_reason ?? 'missing'}`,
    }
  }
  if (json.mode === 'stream') {
    return {
      name,
      ok: Boolean(json.ok) && Boolean(json.has_done) && Number(json.data_events ?? 0) > 0,
      kind: 'smoke',
      detail: `status=${json.status ?? 'unknown'}, api=${json.api ?? 'unknown'}, events=${json.data_events ?? 0}, done=${json.has_done ? 'yes' : 'no'}`,
    }
  }
  return {
    name,
    ok: Boolean(json.ok),
    kind: 'smoke',
    detail: `status=${json.status ?? 'unknown'}, api=${json.api ?? 'unknown'}, stop=${json.body?.stop_reason ?? json.body?.choices?.[0]?.finish_reason ?? 'unknown'}, tools=${json.tools ?? 0}`,
  }
}

async function main() {
  const { help, options } = parseArgs(process.argv.slice(2))
  if (help) {
    usage()
    return
  }

  const cases = [
    {
      name: 'baseline-wire-shape',
      script: 'scripts/probe-runtime-shapes.mjs',
      args: ['--shape', 'both', '--model', options.model, '--prompt', 'Reply with exactly: OK'],
      summarize: summarizeProbeCase,
    },
    {
      name: 'thinking-wire-shape',
      script: 'scripts/probe-runtime-shapes.mjs',
      args: ['--shape', 'both', '--model', options.model, '--thinking', '--prompt', 'Reply with exactly: OK'],
      summarize: summarizeProbeCase,
    },
    {
      name: 'tool-use-wire-shape',
      script: 'scripts/probe-runtime-shapes.mjs',
      args: ['--shape', 'both', '--model', options.model, '--tools', '1', '--prompt', 'Use smoke_tool_0 with value ping. Do not answer directly.'],
      summarize: summarizeProbeCase,
    },
    {
      name: 'proxy-smoke-81-tools',
      script: 'scripts/smoke-runtime-proxy.mjs',
      args: ['--model', options.model, '--tools', '81', '--prompt', 'Reply with exactly: OK'],
      summarize: summarizeSmokeCase,
    },
    {
      name: 'proxy-openai-smoke',
      script: 'scripts/smoke-runtime-proxy.mjs',
      args: ['--api', 'openai', '--model', options.model, '--prompt', 'Reply with exactly: OK'],
      summarize: summarizeSmokeCase,
    },
    {
      name: 'proxy-anthropic-stream',
      script: 'scripts/smoke-runtime-proxy.mjs',
      args: ['--model', options.model, '--stream', '--prompt', 'Reply with exactly: OK'],
      summarize: summarizeSmokeCase,
    },
    {
      name: 'proxy-openai-stream',
      script: 'scripts/smoke-runtime-proxy.mjs',
      args: ['--api', 'openai', '--model', options.model, '--stream', '--prompt', 'Reply with exactly: OK'],
      summarize: summarizeSmokeCase,
    },
    {
      name: 'proxy-roundtrip',
      script: 'scripts/smoke-runtime-proxy.mjs',
      args: ['--model', options.model, '--roundtrip', '--tools', '1'],
      summarize: summarizeSmokeCase,
    },
  ]

  if (options.full) {
    cases.push({
      name: 'camel-only-all-ok',
      script: 'scripts/probe-runtime-shapes.mjs',
      args: ['--shape', 'camel', '--expect', 'all-ok', '--model', options.model, '--tools', '1', '--prompt', 'Use smoke_tool_0 with value ping. Do not answer directly.'],
      summarize: summarizeProbeCase,
    })
  }

  if (options.image) {
    cases.push({
      name: 'proxy-image-input',
      script: 'scripts/smoke-runtime-proxy.mjs',
      args: ['--model', options.model, '--image', '--prompt', 'Reply with exactly: OK after reading the image'],
      summarize: summarizeSmokeCase,
    })
  }

  const summary = []
  for (const item of cases) {
    const result = await runNodeScript(item.script, item.args)
    const json = parseJsonResult(item.name, result)
    summary.push(item.summarize(item.name, json))
  }

  const ok = summary.every((item) => item.ok)
  process.stdout.write(JSON.stringify({
    model: options.model,
    ok,
    cases: summary,
  }, null, 2) + '\n')
  if (!ok) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('Run `pnpm run runtime:matrix -- --help` for usage.\n')
  process.exitCode = 1
})
