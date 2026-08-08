/**
 * Tool specification translation.
 *
 * Kiro constrains tool names more tightly than either client protocol, so names
 * are sanitized on the way out and mapped back on the way in. Both directions of
 * the map are returned: request-side (original → sanitized) so historical tool
 * uses in the conversation match the specs sent alongside them, and
 * response-side (sanitized → original) so tool_use events name the tool the
 * client actually registered.
 */

import type { LimitsConfig } from '../config/config'
import { InvalidRequestError } from '../errors'

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u
const MAX_TOOL_NAME_LENGTH = 64

export type ToolDefinition = { name: string; description: string; input_schema: unknown }

export type ToolSpecResult = {
  specs: unknown[]
  /** sanitized → original, applied to outbound tool_use events. */
  responseNameMap: Map<string, string>
  /** original → sanitized, applied to inbound tool uses in history. */
  requestNameMap: Map<string, string>
}

export function buildToolSpecs(tools: ToolDefinition[], limits: LimitsConfig, source: string): ToolSpecResult {
  if (tools.length > limits.maxTools) {
    throw new InvalidRequestError(`${source} tool count exceeds ${limits.maxTools}`)
  }

  const responseNameMap = new Map<string, string>()
  const requestNameMap = new Map<string, string>()
  const originalNames = new Set<string>()
  const usedNames = new Set<string>()
  let totalSchemaBytes = 0

  const specs = tools.map((tool) => {
    if (originalNames.has(tool.name)) {
      throw new InvalidRequestError(`${source} tool name is duplicated: ${tool.name}`)
    }
    originalNames.add(tool.name)

    const name = allocateToolName(tool.name, usedNames)
    usedNames.add(name)
    if (name !== tool.name) responseNameMap.set(name, tool.name)
    requestNameMap.set(tool.name, name)

    const schemaBytes = Buffer.byteLength(JSON.stringify(tool.input_schema ?? {}))
    if (schemaBytes > limits.maxToolSchemaBytes) {
      throw new InvalidRequestError(`${source} tool schema is too large: ${tool.name}`)
    }
    totalSchemaBytes += schemaBytes
    if (totalSchemaBytes > limits.maxTotalToolSchemaBytes) {
      throw new InvalidRequestError(`${source} tool schemas are too large`)
    }

    return { toolSpecification: { name, description: tool.description, inputSchema: { json: tool.input_schema } } }
  })

  return { specs, responseNameMap, requestNameMap }
}

/**
 * Sanitization can map two distinct client names onto the same Kiro name, so
 * collisions get a numeric suffix.
 */
function allocateToolName(original: string, used: Set<string>): string {
  const sanitized = sanitizeToolName(original)
  if (!used.has(sanitized)) return sanitized

  const stem = sanitized.slice(0, MAX_TOOL_NAME_LENGTH - 4)
  for (let index = 2; ; index++) {
    const candidate = `${stem}_${index}`
    if (!used.has(candidate)) return candidate
  }
}

export function sanitizeToolName(name: string): string {
  if (typeof name !== 'string' || !name) return 'tool'
  if (TOOL_NAME_PATTERN.test(name)) return name

  let clean = name
  // MCP namespaces (mcp__server__tool) blow the length budget; keep the first
  // and last segment, which are the distinguishing parts.
  if (clean.includes('__')) {
    const parts = clean.split('__')
    clean = parts.length > 2 ? `${parts[0]}_${parts[parts.length - 1]!}` : parts.join('_')
  }
  clean = clean.replace(/[^A-Za-z0-9_-]/gu, '_')
  if (clean.length > MAX_TOOL_NAME_LENGTH) clean = clean.slice(0, MAX_TOOL_NAME_LENGTH)
  return clean || 'tool'
}

export function assertValidToolUseId(id: string | undefined, source: string): asserts id is string {
  if (typeof id !== 'string' || !TOOL_USE_ID_PATTERN.test(id)) {
    throw new InvalidRequestError(`${source} id is invalid: ${String(id)}`)
  }
}

/**
 * A tool result must reference a tool use already seen in the conversation,
 * otherwise Kiro rejects the payload.
 */
export function assertKnownToolResultId(id: string | undefined, seenToolUseIds: Set<string>, source: string): void {
  assertValidToolUseId(id, `${source} tool_result`)
  if (!seenToolUseIds.has(id)) {
    throw new InvalidRequestError(`${source} tool_result references an unknown tool_use id: ${id}`)
  }
}
