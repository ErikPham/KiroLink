#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DEFAULT_KIRO_CLI = '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli'
const DEFAULT_PROMPT = 'Reply with exactly: OK'
const MAX_LOG_BYTES = 64 * 1024

function usage() {
  process.stdout.write(`Usage: pnpm run runtime:record -- [options]
       pnpm run runtime:record -- [options] -- <kiro-cli args...>

Records a real Kiro CLI runtime request using KIRO_RECORD_API_REQUESTS_PATH and
KIRO_RECORD_API_RESPONSES_PATH, then writes sanitized copies for inspection.

Options:
  --out <dir>       Output directory (default: private temp directory)
  --prompt <text>   Prompt to send to kiro-cli chat (default: "${DEFAULT_PROMPT}")
  --model <id>      Optional Kiro model id to pass to kiro-cli
  --cli <path>      Kiro CLI binary path (default: KIRO_CLI_BIN or app bundle path)
  -h, --help        Show this help

If you pass args after a literal -- separator, they are forwarded to kiro-cli
exactly as given and replace the default text-only chat invocation.

Raw files may contain prompts, tool output, and auth metadata. Inspect the
*.sanitized.jsonl files first and delete raw files when done.
`)
}

function parseArgs(argv) {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv
  const options = {
    outDir: undefined,
    prompt: DEFAULT_PROMPT,
    model: undefined,
    cli: process.env.KIRO_CLI_BIN || (existsSync(DEFAULT_KIRO_CLI) ? DEFAULT_KIRO_CLI : 'kiro-cli'),
    cliArgs: undefined,
  }

  const readValue = (arg, index) => {
    const value = normalizedArgv[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
    return value
  }

  for (let i = 0; i < normalizedArgv.length; i++) {
    const arg = normalizedArgv[i]
    if (arg === '--') {
      options.cliArgs = normalizedArgv.slice(i + 1)
      break
    }
    if (arg === '-h' || arg === '--help') return { help: true, options }
    if (arg === '--out') options.outDir = readValue(arg, i++)
    else if (arg === '--prompt') options.prompt = readValue(arg, i++)
    else if (arg === '--model') options.model = readValue(arg, i++)
    else if (arg === '--cli') options.cli = readValue(arg, i++)
    else throw new Error(`Unknown option: ${arg}`)
  }

  return { help: false, options }
}

function capAppend(current, chunk) {
  const next = current + chunk
  if (Buffer.byteLength(next) <= MAX_LOG_BYTES) return next
  return next.slice(0, MAX_LOG_BYTES) + '\n...[truncated]\n'
}

function sanitizeString(value) {
  let out = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[REDACTED_JWT]')
    .replace(/arn:aws:[A-Za-z0-9:/_-]+/gu, '[REDACTED_ARN]')

  if (out.length > 1024 && /^[A-Za-z0-9+/=_-]+$/u.test(out)) return `[REDACTED_BASE64 chars=${out.length}]`
  return out
}

function isSensitiveKey(key) {
  return /^(authorization|accessToken|access_token|refreshToken|refresh_token|idToken|id_token|token|profileArn|profile_arn)$/iu.test(key)
}

function isTextKey(key) {
  return /^(content|text|prompt|result|stdout|stderr|errorMessage|error_message)$/iu.test(key)
}

function sanitizeJson(value, key = '') {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) return '[REDACTED]'
    const sanitized = sanitizeString(value)
    if (isTextKey(key)) return `[REDACTED_TEXT chars=${value.length}]`
    return sanitized
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, key))

  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (isSensitiveKey(childKey)) {
      out[childKey] = '[REDACTED]'
    } else {
      out[childKey] = sanitizeJson(childValue, childKey)
    }
  }
  return out
}

function sanitizeLine(line) {
  if (!line.trim()) return line
  try {
    return JSON.stringify(sanitizeJson(JSON.parse(line)))
  } catch {
    return sanitizeString(line)
  }
}

async function sanitizeFile(rawPath, sanitizedPath) {
  if (!existsSync(rawPath)) return false
  await chmod(rawPath, 0o600).catch(() => {})
  const raw = await readFile(rawPath, 'utf8')
  const sanitized = raw.split(/\r?\n/u).map(sanitizeLine).join('\n')
  await writeFile(sanitizedPath, sanitized, { mode: 0o600 })
  return true
}

function runKiro(cli, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => { stdout = capAppend(stdout, chunk.toString()) })
    child.stderr.on('data', (chunk) => { stderr = capAppend(stderr, chunk.toString()) })
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}\n` }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function main() {
  const { help, options } = parseArgs(process.argv.slice(2))
  if (help) {
    usage()
    return
  }

  const outDir = resolve(options.outDir ?? join(tmpdir(), `kirolink-runtime-${Date.now()}`))
  await mkdir(outDir, { recursive: true, mode: 0o700 })

  const requestsRaw = join(outDir, 'requests.raw.jsonl')
  const responsesRaw = join(outDir, 'responses.raw.jsonl')
  const requestsSanitized = join(outDir, 'requests.sanitized.jsonl')
  const responsesSanitized = join(outDir, 'responses.sanitized.jsonl')

  const args = options.cliArgs
    ? [...options.cliArgs]
    : ['chat', '--no-interactive', '--agent-engine', 'v2', '--trust-tools=', '--wrap', 'never']
  if (!options.cliArgs) {
    if (options.model) args.push('--model', options.model)
    args.push(options.prompt)
  }

  const env = {
    ...process.env,
    KIRO_RECORD_API_REQUESTS_PATH: requestsRaw,
    KIRO_RECORD_API_RESPONSES_PATH: responsesRaw,
  }

  process.stderr.write(`Recording Kiro CLI runtime request into ${outDir}\n`)
  process.stderr.write(`Command: ${options.cli} ${args.map((arg) => JSON.stringify(arg)).join(' ')}\n`)

  const result = await runKiro(options.cli, args, env)
  const wroteRequests = await sanitizeFile(requestsRaw, requestsSanitized)
  const wroteResponses = await sanitizeFile(responsesRaw, responsesSanitized)

  await writeFile(join(outDir, 'cli.stdout.txt'), sanitizeString(result.stdout), { mode: 0o600 })
  await writeFile(join(outDir, 'cli.stderr.txt'), sanitizeString(result.stderr), { mode: 0o600 })

  process.stdout.write(JSON.stringify({
    exitCode: result.code,
    outDir,
    sanitizedRequests: wroteRequests ? requestsSanitized : null,
    sanitizedResponses: wroteResponses ? responsesSanitized : null,
    stdout: join(outDir, 'cli.stdout.txt'),
    stderr: join(outDir, 'cli.stderr.txt'),
  }, null, 2) + '\n')

  if (result.code !== 0) {
    process.stderr.write('kiro-cli exited non-zero. If no request file was recorded, run `kiro-cli login` first or try a different --model.\n')
    process.exitCode = result.code
  } else if (!wroteRequests) {
    process.stderr.write('kiro-cli exited successfully, but no request file was recorded. Your installed Kiro CLI may not expose KIRO_RECORD_API_REQUESTS_PATH for this command.\n')
    process.exitCode = 2
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('Run `pnpm run runtime:record -- --help` for usage.\n')
  process.exitCode = 1
})
