/**
 * Extended-thinking translation.
 *
 * Kiro expresses reasoning depth as a coarse effort level in
 * additionalModelRequestFields, while Anthropic clients express it as a token
 * budget and OpenAI clients as a reasoning_effort string. This maps between the
 * three.
 */

import type { TranslationConfig } from '../config/config'
import { InvalidRequestError } from '../errors'

/** Models known to accept output_config.effort. */
const EFFORT_MODELS = new Set(['claude-opus-4.7', 'claude-opus-4.6', 'claude-sonnet-4.6'])

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = typeof EFFORT_LEVELS[number]

/**
 * Fallback for runtimes that ignore output_config. Opt-in only, because it
 * consumes context and alters the system prompt the client wrote.
 */
export const THINKING_PROMPT = 'enabled 200000'

/** Budget thresholds, descending; the first match wins. */
const BUDGET_THRESHOLDS: [number, EffortLevel][] = [
  [64_000, 'max'],
  [32_000, 'xhigh'],
  [12_000, 'high'],
  [4_000, 'medium'],
]

export type ThinkingRequest = { type: string; budget_tokens?: number } | undefined

export function isThinkingEnabled(thinking: ThinkingRequest): boolean {
  return thinking?.type === 'enabled' || thinking?.type === 'adaptive'
}

/**
 * Build additionalModelRequestFields. Returns undefined when thinking is off or
 * the model is not known to support the field, so an unsupported request is not
 * sent a field the runtime would reject.
 */
export function buildAdditionalModelRequestFields(
  modelId: string,
  thinking: ThinkingRequest,
  translation: TranslationConfig,
): Record<string, unknown> | undefined {
  if (!isThinkingEnabled(thinking)) return undefined
  if (!EFFORT_MODELS.has(modelId) && !translation.forceThinkingEffort) return undefined
  return { output_config: { effort: resolveEffort(thinking, translation) } }
}

function resolveEffort(thinking: ThinkingRequest, translation: TranslationConfig): EffortLevel {
  if (translation.thinkingEffort) return normalizeEffort(translation.thinkingEffort)
  const budget = thinking?.budget_tokens ?? 0
  for (const [threshold, level] of BUDGET_THRESHOLDS) {
    if (budget >= threshold) return level
  }
  return 'low'
}

/** Convert an OpenAI reasoning_effort into the equivalent token budget. */
export function effortToBudget(effort: string): number {
  const level = normalizeEffort(effort)
  const match = BUDGET_THRESHOLDS.find(([, candidate]) => candidate === level)
  return match ? match[0] : 1_024
}

export function normalizeEffort(value: string): EffortLevel {
  const normalized = value.toLowerCase()
  // OpenAI's "minimal" has no Kiro equivalent; the lowest level is closest.
  if (normalized === 'minimal') return 'low'
  if ((EFFORT_LEVELS as readonly string[]).includes(normalized)) return normalized as EffortLevel
  throw new InvalidRequestError(`Unsupported thinking effort: ${value}`)
}
