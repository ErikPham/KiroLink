/**
 * kiro-cli secret store: the SQLite half, which is the only tier that can be
 * exercised without touching the developer's own keyring.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadKiroToken } from '../../src/kiro/auth'
import { readSecretStoreToken } from '../../src/kiro/secret-store'

const NO_KEYRING = { keyring: false } as const

const sqlite = await import('node:sqlite').catch(() => null)
// node:sqlite landed in Node 22.5; the package still supports 18.
const withSqlite = sqlite ? describe : describe.skip

function storedToken(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'a'.repeat(40),
    refresh_token: 'r'.repeat(20),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    profile_arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF',
    provider: 'google',
    ...overrides,
  })
}

async function storeDb(rows: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kirolink-store-'))
  const path = join(dir, 'data.sqlite3')
  const db = new (sqlite as { DatabaseSync: new (p: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): void }
    close(): void
  } }).DatabaseSync(path)
  db.exec('create table auth_kv (key text primary key, value text)')
  const insert = db.prepare('insert into auth_kv (key, value) values (?, ?)')
  for (const [key, value] of Object.entries(rows)) insert.run(key, value)
  db.close()
  return path
}

describe('readSecretStoreToken', () => {
  it('returns null when the store does not exist', async () => {
    await expect(readSecretStoreToken({ ...NO_KEYRING, dbPath: '/nonexistent/data.sqlite3' })).resolves.toBeNull()
  })
})

withSqlite('readSecretStoreToken with a database', () => {
  it('normalizes the snake_case shape kiro-cli writes', async () => {
    const dbPath = await storeDb({ 'kirocli:social:token': storedToken() })

    await expect(readSecretStoreToken({ ...NO_KEYRING, dbPath })).resolves.toMatchObject({
      accessToken: 'a'.repeat(40),
      refreshToken: 'r'.repeat(20),
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCDEF',
    })
  })

  it('prefers the login that expires latest when several are stored', async () => {
    const later = new Date(Date.now() + 7_200_000).toISOString()
    const dbPath = await storeDb({
      'kirocli:social:token': storedToken({ expires_at: new Date(Date.now() + 60_000).toISOString() }),
      'kirocli:odic:token': storedToken({ expires_at: later, access_token: 'b'.repeat(40) }),
    })

    await expect(readSecretStoreToken({ ...NO_KEYRING, dbPath })).resolves.toMatchObject({
      accessToken: 'b'.repeat(40),
      expiresAt: later,
    })
  })

  it('ignores entries that are not a usable token', async () => {
    const dbPath = await storeDb({
      'kirocli:social:token': '{not json',
      'kirocli:odic:token': JSON.stringify({ client_id: 'x', client_secret: 'y' }),
    })

    await expect(readSecretStoreToken({ ...NO_KEYRING, dbPath })).resolves.toBeNull()
  })

  it('ignores a database without the auth_kv table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-store-'))
    const dbPath = join(dir, 'data.sqlite3')
    await writeFile(dbPath, 'not a database')

    await expect(readSecretStoreToken({ ...NO_KEYRING, dbPath })).resolves.toBeNull()
  })
})

withSqlite('loadKiroToken across both stores', () => {
  async function cacheDirWith(expiresAt: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-cache-'))
    await writeFile(
      join(dir, 'kiro-auth-token-cli.json'),
      JSON.stringify({
        accessToken: 'f'.repeat(40),
        refreshToken: 'r'.repeat(20),
        expiresAt,
        profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/FILE',
      }),
    )
    return dir
  }

  it('finds the secret store when the file cache holds no token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-cache-'))
    const dbPath = await storeDb({ 'kirocli:social:token': storedToken() })

    const found = await loadKiroToken(dir, undefined, { ...NO_KEYRING, dbPath })

    expect(found.origin).toBe('kiro-cli secret store')
    expect(found.token.accessToken).toBe('a'.repeat(40))
  })

  it('prefers whichever store holds the later expiry', async () => {
    const dbPath = await storeDb({
      'kirocli:social:token': storedToken({ expires_at: new Date(Date.now() + 60_000).toISOString() }),
    })
    const dir = await cacheDirWith(new Date(Date.now() + 7_200_000).toISOString())

    const found = await loadKiroToken(dir, undefined, { ...NO_KEYRING, dbPath })

    expect(found.token.accessToken).toBe('f'.repeat(40))
    expect(found.origin).toContain('kiro-auth-token-cli.json')
  })

  it('reports both stores when neither has a credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kirolink-cache-'))

    await expect(loadKiroToken(dir, undefined, { ...NO_KEYRING, dbPath: '/nonexistent.sqlite3' }))
      .rejects.toThrow(/secret store[\s\S]*Searched/u)
  })
})
