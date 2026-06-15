#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function usage() {
  process.stdout.write(`Usage: pnpm run runtime:analyze -- <recording-dir-or-request-file>

Analyzes sanitized files produced by runtime:record and prints a compact shape
report. This does not read raw recording files.
`)
}

async function readJsonl(path) {
  if (!existsSync(path)) return []
  const raw = await readFile(path, 'utf8')
  return raw.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line))
}

function detectPaths(input) {
  const abs = resolve(input)
  if (statSync(abs).isDirectory()) {
    return {
      requestPath: join(abs, 'requests.sanitized.jsonl'),
      responsePath: join(abs, 'responses.sanitized.jsonl'),
    }
  }
  return { requestPath: abs, responsePath: null }
}

function keys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []
}

function detectRequestFormat(request) {
  if (request?.conversation_id && request?.user_input_message) return 'kiro-cli-recording-v2'
  if (request?.conversationState?.currentMessage) return 'codewhisperer-service'
  return 'unknown'
}

function summarizeTools(request) {
  const ctx = request?.user_input_message?.user_input_message_context
    ?? request?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext
  const tools = Array.isArray(ctx?.tools) ? ctx.tools : []
  return tools.slice(0, 5).map((tool) => {
    if (tool.ToolSpecification) {
      return {
        wrapper: 'ToolSpecification',
        schemaKey: tool.ToolSpecification.input_schema ? 'input_schema' : 'unknown',
        name: tool.ToolSpecification.name ?? null,
      }
    }
    if (tool.toolSpecification) {
      return {
        wrapper: 'toolSpecification',
        schemaKey: tool.toolSpecification.inputSchema ? 'inputSchema' : 'unknown',
        name: tool.toolSpecification.name ?? null,
      }
    }
    return { wrapper: keys(tool)[0] ?? 'unknown', schemaKey: 'unknown', name: null }
  })
}

function summarizeResponses(events) {
  const kinds = []
  for (const event of events) {
    const kind = event.kind ?? event[':event-type'] ?? event.eventType ?? 'unknown'
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

function warningsFor(report) {
  const warnings = []
  if (report.request.format === 'kiro-cli-recording-v2') {
    warnings.push('Kiro CLI recording uses snake_case/internal wrappers. Treat it as an oracle for drift, not proof that the proxy service body should be rewritten wholesale.')
  }
  if (report.request.toolSpecs.some((tool) => tool.wrapper === 'ToolSpecification')) {
    warnings.push('Recorded CLI tools use ToolSpecification/input_schema; proxy service payload currently uses toolSpecification/inputSchema. Change only after a live validation error proves the service body needs the CLI wrapper.')
  }
  if (report.responses.kinds.includes('AssistantResponseEvent')) {
    warnings.push('Recorded responses use kind/data event wrappers; proxy parser must keep supporting these names.')
  }
  return warnings
}

async function main() {
  const arg = process.argv.slice(2).find((value) => value !== '--')
  if (!arg || arg === '-h' || arg === '--help') {
    usage()
    process.exitCode = arg ? 0 : 1
    return
  }

  const { requestPath, responsePath } = detectPaths(arg)
  const requests = await readJsonl(requestPath)
  const responses = responsePath ? await readJsonl(responsePath) : []
  const request = requests[0] ?? null

  const userMessage = request?.user_input_message ?? request?.conversationState?.currentMessage?.userInputMessage ?? null
  const context = userMessage?.user_input_message_context ?? userMessage?.userInputMessageContext ?? null
  const report = {
    requestPath,
    responsePath,
    request: {
      format: detectRequestFormat(request),
      topLevelKeys: keys(request),
      userMessageKeys: keys(userMessage),
      contextKeys: keys(context),
      modelId: userMessage?.model_id ?? userMessage?.modelId ?? null,
      historyLength: Array.isArray(request?.history) ? request.history.length : request?.conversationState?.history?.length ?? null,
      toolCount: Array.isArray(context?.tools) ? context.tools.length : 0,
      toolSpecs: summarizeTools(request),
    },
    responses: {
      eventCount: responses.length,
      kinds: summarizeResponses(responses),
    },
  }

  process.stdout.write(JSON.stringify({ ...report, warnings: warningsFor(report) }, null, 2) + '\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
