/**
 * Shared conversation assembly.
 *
 * Both protocols must fold their own message shape into the same Kiro wire
 * shape: a strict alternation of user and assistant turns, with tool results
 * paired to the tool uses that produced them. That folding logic was previously
 * duplicated between the two translators; it lives here once, parameterized by
 * the per-protocol pieces that genuinely differ.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { TranslationConfig } from '../config/config'
import { MAX_CONTENT_TEXT_BYTES, truncateWithMarker } from '../domain/limits'
import type {
  KiroHistoryEntry,
  KiroImageBlock,
  KiroToolResult,
  KiroToolUse,
  KiroUserInputMessage,
} from '../domain/types'

/** kiro-cli sends origin KIRO_CLI; AI_EDITOR is the IDE. */
export const KIRO_ORIGIN = 'KIRO_CLI'

/** Placeholder text for a turn that carries no content of its own. */
export const CONTINUATION_TEXT = 'Continue.'

const INTERRUPTED_TOOL_RESULT_TEXT = 'Tool use was interrupted before a result was returned.'

/** A protocol-neutral conversation turn. */
export type Turn = {
  role: 'user' | 'assistant'
  text: string
  /** Images attached to the message itself. */
  images: KiroImageBlock[]
  /** Images extracted from tool_result blocks. */
  toolResultImages: KiroImageBlock[]
  toolUses: KiroToolUse[]
  toolResults: KiroToolResult[]
}

export function newTurn(role: 'user' | 'assistant', text = ''): Turn {
  return { role, text, images: [], toolResultImages: [], toolUses: [], toolResults: [] }
}

/**
 * Append a turn, merging into the previous one when both share a role.
 *
 * Clients send a user turn per tool result, but Kiro requires strict
 * alternation, so consecutive same-role turns must collapse. `separateToolResults`
 * keeps a turn that carries tool results from absorbing an unrelated plain-text
 * turn, which would reorder the results relative to their tool uses.
 */
export function appendTurn(turns: Turn[], turn: Turn, options?: { separateToolResults?: boolean }): void {
  const last = turns[turns.length - 1]
  const sameRole = last && last.role === turn.role
  const compatible = options?.separateToolResults
    ? sameRole && (last.toolResults.length === 0) === (turn.toolResults.length === 0)
    : sameRole

  if (!compatible || !last) {
    turns.push(turn)
    return
  }

  if (turn.text) last.text = last.text ? `${last.text}\n${turn.text}` : turn.text
  last.images.push(...turn.images)
  last.toolResultImages.push(...turn.toolResultImages)
  last.toolUses.push(...turn.toolUses)
  last.toolResults.push(...turn.toolResults)
}

/**
 * Ensure every tool use has a matching tool result.
 *
 * A client that was interrupted mid-tool-call sends history where an assistant
 * tool use has no corresponding result. Kiro rejects that shape, so synthesize
 * an error result: the model learns the call did not complete, which is accurate
 * and keeps the conversation valid.
 */
export function repairToolResultPairing(turns: Turn[]): { addedMissingResults: number } {
  const resolved = new Set<string>()
  for (const turn of turns) {
    if (turn.role !== 'user') continue
    for (const result of turn.toolResults) resolved.add(result.toolUseId)
  }

  let added = 0
  let appendedTurn: Turn | undefined

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!
    if (turn.role !== 'assistant') continue

    for (const toolUse of turn.toolUses) {
      if (resolved.has(toolUse.toolUseId)) continue
      const repair = buildInterruptedToolResult(toolUse.toolUseId)
      const nextUser = findNextUserTurn(turns, i + 1)
      if (nextUser) {
        // Unshift so the repair precedes results the client did send.
        nextUser.toolResults.unshift(repair)
      } else {
        if (!appendedTurn) {
          appendedTurn = newTurn('user', CONTINUATION_TEXT)
          turns.push(appendedTurn)
        }
        appendedTurn.toolResults.push(repair)
      }
      resolved.add(toolUse.toolUseId)
      added++
    }
  }

  return { addedMissingResults: added }
}

/**
 * Drop tool results that reference no preceding tool use.
 *
 * Kiro validates pairing in both directions, so an orphan result (from a client
 * that trimmed history mid-conversation) would be rejected upstream.
 */
export function dropOrphanToolResults(turns: Turn[]): { removedOrphanResults: number } {
  let removed = 0
  let previousToolUseIds = new Set<string>()

  for (const turn of turns) {
    if (turn.role === 'assistant') {
      previousToolUseIds = new Set(turn.toolUses.map((toolUse) => toolUse.toolUseId))
      continue
    }
    if (turn.toolResults.length === 0) continue
    const kept = turn.toolResults.filter((result) => previousToolUseIds.has(result.toolUseId))
    removed += turn.toolResults.length - kept.length
    turn.toolResults = kept
    previousToolUseIds = new Set()
  }

  return { removedOrphanResults: removed }
}

export function buildInterruptedToolResult(toolUseId: string): KiroToolResult {
  return { toolUseId, content: [{ text: INTERRUPTED_TOOL_RESULT_TEXT }], status: 'error' }
}

function findNextUserTurn(turns: Turn[], start: number): Turn | undefined {
  for (let i = start; i < turns.length; i++) {
    const turn = turns[i]!
    if (turn.role === 'user') return turn
  }
  return undefined
}

/**
 * Build a Kiro user turn, omitting empty optional fields to match the real
 * kiro-cli wire shape.
 */
export function buildUserInputMessage(
  content: string,
  modelId: string,
  options: {
    envState?: Record<string, string>
    tools?: unknown[] | undefined
    toolResults?: KiroToolResult[]
    images?: KiroImageBlock[]
  } = {},
): KiroUserInputMessage {
  const message: KiroUserInputMessage = {
    content: truncateWithMarker(content, MAX_CONTENT_TEXT_BYTES),
    origin: KIRO_ORIGIN,
    modelId,
  }

  if (options.envState || options.tools?.length || options.toolResults?.length) {
    message.userInputMessageContext = {
      ...(options.envState ? { envState: options.envState } : {}),
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...(options.toolResults?.length ? { toolResults: options.toolResults } : {}),
    }
  }
  if (options.images?.length) message.images = options.images
  return message
}

export function buildAssistantHistoryEntry(turn: Turn): KiroHistoryEntry {
  return {
    assistantResponseMessage: {
      content: truncateWithMarker(turn.text, MAX_CONTENT_TEXT_BYTES),
      toolUses: turn.toolUses,
    },
  }
}

export function buildEnvState(): Record<string, string> {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  return { operatingSystem: os, currentWorkingDirectory: process.cwd() }
}

/**
 * Conversation id assignment.
 *
 * kiro-cli assigns a fresh random id when a session starts and keeps it stable
 * for every turn of that session (confirmed from runtime recordings). The
 * backend rewards a stable id with prefix-cache reuse — observed TTFB drops
 * across turns.
 *
 * KiroLink is stateless per HTTP request, so it remembers a random id keyed by
 * the conversation's immutable anchor (model + system + first user message).
 * That reproduces kiro-cli's behavior without deriving a globally deterministic
 * id from user content. Short, empty, or synthetic anchors are collision-prone
 * and get an ephemeral id that is never stored.
 */
const MIN_ANCHOR_LENGTH = 32
const CONVERSATION_CACHE_MAX = 1000

export type ConversationIdAssigner = {
  assign(modelId: string, system: string, anchorText: string): string
}

export function createConversationIdAssigner(translation: Pick<TranslationConfig, 'randomConversationId'>): ConversationIdAssigner {
  const cache = new Map<string, string>()

  return {
    assign(modelId, system, anchorText) {
      if (translation.randomConversationId) return randomUUID()

      const anchor = anchorText.replace(/\s+/gu, ' ').trim()
      if (anchor.length < MIN_ANCHOR_LENGTH || isSyntheticAnchor(anchor)) return randomUUID()

      const key = createHash('sha1')
        .update(modelId).update('\n')
        .update(system.trim()).update('\n')
        .update(anchor.slice(0, 4096))
        .digest('hex')

      const existing = cache.get(key)
      if (existing !== undefined) {
        // Refresh recency: Map preserves insertion order, so re-inserting moves
        // this key to the newest position for LRU eviction.
        cache.delete(key)
        cache.set(key, existing)
        return existing
      }

      const id = randomUUID()
      cache.set(key, id)
      if (cache.size > CONVERSATION_CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      return id
    },
  }
}

function isSyntheticAnchor(anchor: string): boolean {
  switch (anchor.toLowerCase()) {
    case '':
    case '.':
    case 'continue.':
    case 'begin conversation':
      return true
    default:
      return false
  }
}
