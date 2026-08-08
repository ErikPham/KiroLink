/**
 * Every size limit in one place.
 *
 * These were previously split between the translator and the transport, with
 * two different constants named MAX_TOOL_RESULT_TEXT_BYTES (128KB and 64KB)
 * and two different truncation markers. A large tool result was therefore
 * truncated twice, the second pass cutting through the first pass's marker and
 * destroying the original_bytes diagnostic. Truncation now happens exactly
 * once, in the translator, against these values.
 */

/** Cap for a single message's text content. */
export const MAX_CONTENT_TEXT_BYTES = 128 * 1024

/** Cap for a single tool_result's text. */
export const MAX_TOOL_RESULT_TEXT_BYTES = 64 * 1024

export const MAX_OUTPUT_TOKENS = 100_000
export const MAX_IMAGES = 20

export const DEFAULT_MAX_TOOLS = 256
export const DEFAULT_MAX_TOOL_SCHEMA_BYTES = 128 * 1024
export const DEFAULT_MAX_TOTAL_TOOL_SCHEMA_BYTES = 768 * 1024

/** Default cap on an inbound client request body. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024

/** How much of an upstream error body to retain for diagnostics. */
export const MAX_ERROR_BODY_BYTES = 16 * 1024

/**
 * Truncate to a UTF-8 byte budget without splitting a character.
 * Binary search over code-point boundaries; `slice` never splits a surrogate
 * pair because both halves are counted together by byteLength.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  return value.slice(0, low)
}

/** Truncate text to `maxBytes`, appending a marker that reports the original size. */
export function truncateWithMarker(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return text
  const suffix = `\n[truncated: original_bytes=${bytes}]`
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  return `${truncateUtf8(text, budget)}${suffix}`
}
