/**
 * Persisted user settings.
 *
 * Only auth-related values are stored, so a second run does not require
 * re-entering a key or region. Previously this module imported parseAuthMode
 * from the HTTPS transport module, transitively pulling node:https and the
 * event-stream parser into a pure filesystem concern; it now depends only on
 * the config layer.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UpstreamAuthMode } from './config'
import { parseAuthMode } from './config'
import { normalizeRegion, type AuthSources, type StoredAuthSettings } from './env'

export type UserConfig = StoredAuthSettings

export async function loadUserConfig(path: string): Promise<UserConfig> {
  try {
    const raw = await readFile(path, 'utf8')
    return normalizeUserConfig(JSON.parse(raw) as unknown)
  } catch (error) {
    if (isNotFound(error)) return {}
    throw new Error(`Failed to read config ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export async function saveUserConfig(config: UserConfig, path: string): Promise<void> {
  const body = `${JSON.stringify(normalizeUserConfig(config), null, 2)}\n`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  // Atomic write: temp file then rename. chmod after rename so umask cannot
  // leave secrets world-readable.
  await writeFile(tmp, body, { mode: 0o600, encoding: 'utf8' })
  await rename(tmp, path)
  await chmod(path, 0o600)
}

/**
 * Decide what to persist. A previously saved key or region is retained when the
 * current run does not supply one, so `--auth api-key` keeps working later
 * without re-entering the key.
 *
 * Values that came from the environment are deliberately *not* written back.
 * Only the flags are documented as "remembered"; an env var is a per-invocation
 * override, so persisting it would let one `KIROLINK_AUTH=cli` run silently
 * become the user's permanent default — and would spill a `KIROLINK_KIRO_API_KEY`
 * that was never meant to touch the disk.
 */
export function buildUserConfigToSave(
  resolved: { mode: UpstreamAuthMode; kiroApiKey: string | undefined; apiRegion: string | undefined },
  previous: UserConfig = {},
  sources: Partial<AuthSources> = {},
): UserConfig {
  const fromEnv = (field: keyof AuthSources): boolean => sources[field] === 'env'
  const next: UserConfig = { ...previous }
  if (!fromEnv('auth')) next.auth = resolved.mode

  const kiroApiKey = (fromEnv('kiroApiKey') ? undefined : resolved.kiroApiKey) ?? previous.kiroApiKey
  if (kiroApiKey) next.kiroApiKey = kiroApiKey
  else delete next.kiroApiKey

  const apiRegion = (fromEnv('apiRegion') ? undefined : resolved.apiRegion) ?? previous.apiRegion
  if (apiRegion) next.apiRegion = apiRegion
  else delete next.apiRegion

  return normalizeUserConfig(next)
}

export function normalizeUserConfig(value: unknown): UserConfig {
  if (!value || typeof value !== 'object') return {}
  const obj = value as Record<string, unknown>
  const out: UserConfig = {}

  if (typeof obj['auth'] === 'string') {
    try {
      out.auth = parseAuthMode(obj['auth'])
    } catch {
      // A hand-edited file with an invalid mode falls back to the default
      // rather than blocking startup.
    }
  }
  // Accept camelCase and snake/kebab aliases from hand-edited files.
  const key = pickString(obj, 'kiroApiKey', 'kiro_api_key', 'kiro-api-key')
  if (key) out.kiroApiKey = key
  const region = normalizeRegion(pickString(obj, 'apiRegion', 'api_region', 'api-region'))
  if (region) out.apiRegion = region
  return out
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT')
}
