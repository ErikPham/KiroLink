/**
 * kiro-cli secret store.
 *
 * kiro-cli 2.x no longer writes its OAuth token to ~/.aws/sso/cache. The token
 * lives in a two-tier store — the OS keyring first, with an `auth_kv` table in
 * kiro-cli's SQLite database as the portable mirror — and is serialized in
 * snake_case rather than the camelCase the SSO file cache uses.
 *
 * Reading it needs no dependency: on macOS `security(1)` is the same binary
 * kiro-cli itself shells out to, and `node:sqlite` covers every platform where
 * the runtime is new enough to have it.
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { KiroToken } from './auth'

/** Login kinds kiro-cli stores, in the order it consults them. */
const TOKEN_KEYS = ['kirocli:social:token', 'kirocli:odic:token', 'kirocli:external-idp:token'] as const

const KEYCHAIN_TIMEOUT_MS = 5_000

export type SecretStoreOptions = {
  /** Override kiro-cli's SQLite database, for tests. */
  dbPath?: string | undefined
  /** Skip the macOS keyring, for tests. */
  keyring?: boolean | undefined
}

/**
 * The freshest token kiro-cli has stored, or null when it has none.
 *
 * A machine can hold several login kinds at once, so every key is read and the
 * latest expiry wins rather than the first hit.
 */
export async function readSecretStoreToken(options: SecretStoreOptions = {}): Promise<KiroToken | null> {
  const found: KiroToken[] = []

  if (options.keyring ?? process.platform === 'darwin') {
    for (const key of TOKEN_KEYS) {
      const token = normalizeToken(await readKeychain(key))
      if (token) found.push(token)
    }
  }

  if (found.length === 0) {
    const rows = await readAuthKv(options.dbPath ?? defaultDbPath())
    for (const key of TOKEN_KEYS) {
      const token = normalizeToken(rows.get(key))
      if (token) found.push(token)
    }
  }

  if (found.length === 0) return null
  found.sort((a, b) => expiryOf(b) - expiryOf(a))
  return found[0]!
}

/** Where the secret store would be, for error messages. */
export function describeSecretStore(options: SecretStoreOptions = {}): string {
  const db = options.dbPath ?? defaultDbPath()
  return (options.keyring ?? process.platform === 'darwin') ? `macOS keychain, then ${db}` : db
}

function defaultDbPath(): string {
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  }
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'kiro-cli', 'data.sqlite3')
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'kiro-cli', 'data.sqlite3')
}

function readKeychain(service: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      // A missing item and a broken keychain are both "nothing here"; the
      // SQLite mirror is the fallback either way.
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
    )
  })
}

const SQLITE_MODULE = 'node:sqlite'

/** The slice of node:sqlite used here; @types/node 20 does not declare it. */
type SqliteDb = {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}
type SqliteModule = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb }

async function readAuthKv(dbPath: string): Promise<Map<string, string>> {
  const rows = new Map<string, string>()

  let db: SqliteDb
  try {
    // Specifier is indirect on purpose: node:sqlite needs Node >= 22.5 and this
    // package supports 18, so it must neither be bundled nor resolved at build
    // time. On a runtime without it an unreadable store is "not logged in".
    const sqlite = (await import(/* @vite-ignore */ SQLITE_MODULE)) as SqliteModule
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return rows
  }

  try {
    for (const row of db.prepare('select key, value from auth_kv').all()) {
      const { key, value } = row as { key?: unknown; value?: unknown }
      if (typeof key === 'string' && typeof value === 'string') rows.set(key, value)
    }
  } catch {
    // Table absent on an older kiro-cli schema.
  } finally {
    db.close()
  }
  return rows
}

function normalizeToken(raw: string | undefined): KiroToken | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const record = parsed as Record<string, unknown>
  const accessToken = pickString(record, 'access_token', 'accessToken')
  const refreshToken = pickString(record, 'refresh_token', 'refreshToken')
  const expiresAt = pickString(record, 'expires_at', 'expiresAt')
  const profileArn = pickString(record, 'profile_arn', 'profileArn')
  if (!accessToken || !expiresAt || !profileArn) return null

  return { accessToken, refreshToken: refreshToken ?? '', expiresAt, profileArn }
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function expiryOf(token: KiroToken): number {
  const at = new Date(token.expiresAt).getTime()
  return Number.isFinite(at) ? at : 0
}
