/**
 * Content block extraction shared by the protocol adapters: images, and the
 * flattening of structured tool_result content into the single text block Kiro
 * accepts.
 */

import { MAX_IMAGES, MAX_TOOL_RESULT_TEXT_BYTES, truncateWithMarker } from '../domain/limits'
import type { KiroImageBlock } from '../domain/types'
import { InvalidRequestError } from '../errors'

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Placeholder used when a tool returns an image but the surrounding context
 * cannot carry image attachments.
 */
export const TOOL_RESULT_IMAGE_PLACEHOLDER = '[Tool returned an image; the image is attached to this message.]'

export function isImageBlock(value: unknown): boolean {
  return isRecord(value) && value['type'] === 'image' && isRecord(value['source'])
}

export function extractImageBlock(block: unknown): KiroImageBlock {
  if (!isRecord(block) || !isRecord(block['source'])) throw new InvalidRequestError('image block is invalid')
  const source = block['source']

  const sourceType = source['type']
  if (sourceType && sourceType !== 'base64') {
    throw new InvalidRequestError('only base64 image sources are supported')
  }

  const mediaType = source['media_type']
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new InvalidRequestError(`unsupported image media type: ${String(mediaType)}`)
  }

  const data = source['data']
  if (typeof data !== 'string' || !isLikelyBase64(data)) {
    throw new InvalidRequestError('image source must be base64 data')
  }

  // Kiro names the format without the "image/" prefix, and expects "jpeg".
  const format = mediaType === 'image/jpeg' ? 'jpeg' : mediaType.split('/')[1] || 'png'
  return { format, source: { bytes: data } }
}

export function assertImageCount(count: number): void {
  if (count > MAX_IMAGES) throw new InvalidRequestError(`image count exceeds ${MAX_IMAGES}`)
}

/**
 * Flatten tool_result content into one text block.
 *
 * When `images` is supplied, image blocks found inside the result are moved onto
 * it (the caller attaches them to the enclosing message, since Kiro carries
 * images at message level, not inside tool results). Otherwise a placeholder
 * records that an image was present.
 */
export function stringifyToolResultContent(content: unknown, source: string, images?: KiroImageBlock[]): string {
  if (Array.isArray(content)) return stringifyToolResultParts(content, source, images)
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  if (typeof text !== 'string') throw new InvalidRequestError(`${source} tool_result content is not serializable`)
  return truncateWithMarker(text, MAX_TOOL_RESULT_TEXT_BYTES)
}

function stringifyToolResultParts(parts: unknown[], source: string, images?: KiroImageBlock[]): string {
  const textParts: string[] = []
  let imageCount = 0

  for (const part of parts) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      textParts.push(part['text'])
      continue
    }
    if (isImageBlock(part)) {
      imageCount++
      if (images) {
        assertImageCount(images.length + 1)
        images.push(extractImageBlock(part))
      } else {
        textParts.push(TOOL_RESULT_IMAGE_PLACEHOLDER)
      }
      continue
    }
    const text = stringifyToolResultContent(part, source)
    if (text) textParts.push(text)
  }

  if (textParts.length) return truncateWithMarker(textParts.join('\n'), MAX_TOOL_RESULT_TEXT_BYTES)
  // An image-only result still needs non-empty text: Kiro rejects an empty one.
  return imageCount > 0 ? TOOL_RESULT_IMAGE_PLACEHOLDER : ''
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLikelyBase64(value: string): boolean {
  if (!value) return false
  // A data: URL means the client sent a URL rather than raw base64.
  if (value.startsWith('data:')) return false
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
}
