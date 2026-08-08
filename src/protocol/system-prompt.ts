/**
 * System prompt handling.
 *
 * Kiro has no dedicated system field, so the system prompt is prepended to the
 * first user turn. Optionally the large Claude Code system prompt can be
 * replaced with a compact equivalent to save context.
 */

import type { TranslationConfig } from '../config/config'
import { THINKING_PROMPT } from './thinking'

/**
 * Phrases characteristic of Claude Code's system prompt. Two or more matches is
 * treated as a positive identification; a single generic phrase is not enough,
 * since a user's own prompt could contain one.
 */
const CLAUDE_CODE_MARKERS = [
  'you are an interactive agent',
  '# doing tasks',
  '# using your tools',
  '# tone and style',
  'claude code',
]

const MIN_MARKER_MATCHES = 2

const COMPACT_SYSTEM = 'You are a coding assistant. Be concise and actionable. Use tools when available. Follow the user\'s instructions precisely.'

/** Flatten Anthropic's string-or-blocks system field. */
export function extractSystemText(system: string | { type: string; text: string }[] | undefined): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.map((block) => block.text).filter(Boolean).join('\n')
}

/**
 * Apply the optional prompt filter and the optional thinking-prompt prefix.
 */
export function buildEffectiveSystem(
  systemText: string,
  options: { thinking: boolean; translation: TranslationConfig },
): string {
  const filtered = filterSystemPrompt(systemText, options.translation)
  if (options.thinking && options.translation.injectThinkingPrompt) {
    return filtered ? `${THINKING_PROMPT}\n\n${filtered}` : THINKING_PROMPT
  }
  return filtered
}

function filterSystemPrompt(system: string, translation: TranslationConfig): string {
  if (!system || !translation.filterSystemPrompt) return system
  const lower = system.toLowerCase()
  let matches = 0
  for (const marker of CLAUDE_CODE_MARKERS) {
    if (lower.includes(marker)) matches++
  }
  return matches >= MIN_MARKER_MATCHES ? COMPACT_SYSTEM : system
}
