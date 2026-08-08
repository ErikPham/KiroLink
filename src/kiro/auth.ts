/**
 * Upstream credential resolution.
 *
 * Two modes: kiro-cli OAuth (refreshable) and a Kiro API key (static, no
 * refresh). The OAuth token has two homes — kiro-cli 2.x keeps it in a secret
 * store while older builds and the Kiro IDE write ~/.aws/sso/cache — so both
 * are read and the later expiry wins. Token cache and refresh mutex are
 * instance state rather than module globals, so two providers can coexist and
 * tests do not share a cache.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { ClientIdentityConfig, UpstreamConfig } from '../config/config'
import type { Logger } from '../logging/logger'
import { describeSecretStore, readSecretStoreToken, type SecretStoreOptions } from './secret-store'

const DEFAULT_TOKEN_CACHE_DIR = join(homedir(), '.aws/sso/cache')
const TOKEN_FILENAMES = ['kiro-auth-token-cli.json', 'kiro-auth-token.json'] as const
/** Refresh this long before nominal expiry to avoid mid-flight expiration. */
const EXPIRY_SKEW_MS = 60_000
const REFRESH_TIMEOUT_MS = 15_000

export type KiroToken = { accessToken: string; refreshToken: string; expiresAt: string; profileArn: string }

/** Upstream credential used for GenerateAssistantResponse. */
export type KiroAuth =
  | { mode: 'api_key'; apiKey: string; profileArn?: string }
  | { mode: 'oauth'; accessToken: string; profileArn: string }

type TokenCandidate = {
  path: string
  token: KiroToken
  mtimeMs: number
  preferredNameRank: number
}

export type AuthProvider = {
  load(): Promise<KiroAuth>
  /** Forget any cached credential so the next load re-reads or refreshes. */
  invalidate(): void
  /** Force a kiro-cli token refresh (OAuth only); no-op for api-key mode. */
  refresh(): Promise<void>
}

export function createAuthProvider(
  upstream: UpstreamConfig,
  logger: Logger,
  options: { tokenCacheDir?: string; secretStore?: SecretStoreOptions } = {},
): AuthProvider {
  const cacheDir = options.tokenCacheDir ?? DEFAULT_TOKEN_CACHE_DIR
  const read = (): Promise<KiroToken> =>
    loadKiroToken(cacheDir, upstream.tokenPath, options.secretStore).then((found) => found.token)
  let cachedToken: KiroToken | null = null
  let refreshPromise: Promise<void> | null = null

  /** Serialize refreshes so concurrent 403s trigger only one kiro-cli call. */
  const refresh = (): Promise<void> => {
    refreshPromise ??= refreshTokenViaCli().finally(() => { refreshPromise = null })
    return refreshPromise
  }

  const loadToken = async (): Promise<KiroToken> => {
    if (cachedToken && !isExpiring(cachedToken)) return cachedToken

    const token = await read()
    if (!isExpiring(token)) {
      cachedToken = token
      return token
    }

    logger.log('debug', 'token expired, refreshing via kiro-cli')
    await refresh()
    const fresh = await read()
    cachedToken = fresh
    return fresh
  }

  return {
    async load() {
      if (upstream.mode === 'api-key') {
        const apiKey = upstream.kiroApiKey
        if (!apiKey) {
          throw new Error('Auth mode api-key requires --kiro-api-key, KIROLINK_KIRO_API_KEY, or a saved key in the config file')
        }
        return { mode: 'api_key', apiKey }
      }
      const token = await loadToken()
      return { mode: 'oauth', accessToken: token.accessToken, profileArn: token.profileArn }
    },
    invalidate() {
      cachedToken = null
    },
    async refresh() {
      if (upstream.mode === 'api-key') return
      await refresh()
    },
  }
}

function isExpiring(token: KiroToken): boolean {
  return Date.now() > new Date(token.expiresAt).getTime() - EXPIRY_SKEW_MS
}

/** Headers carrying the credential. */
export function buildAuthHeaders(auth: KiroAuth): Record<string, string> {
  if (auth.mode === 'api_key') {
    return { Authorization: `Bearer ${auth.apiKey}`, tokentype: 'API_KEY' }
  }
  return { Authorization: `Bearer ${auth.accessToken}` }
}

/** Client headers shared by the streaming and REST Kiro endpoints. */
export function buildClientHeaders(
  auth: KiroAuth,
  identity: ClientIdentityConfig,
  accept = '*/*',
): Record<string, string> {
  return {
    ...buildAuthHeaders(auth),
    'User-Agent': userAgent(identity),
    'x-amz-user-agent': amzUserAgent(identity),
    'x-amzn-codewhisperer-optout': identity.codeWhispererOptOut,
    Accept: accept,
  }
}

/**
 * profileArn is required for OAuth and must be absent for API keys (Kiro API
 * keys have no associated profile).
 */
export function resolveProfileArn(auth: KiroAuth): string | undefined {
  if (auth.mode === 'api_key') return auth.profileArn
  if (!auth.profileArn) throw new Error('Kiro token does not contain profileArn')
  return auth.profileArn
}

/** Where a credential was found, so `doctor` can name it. */
export type TokenSource = { token: KiroToken; origin: string }

/**
 * The freshest kiro-cli credential across both stores.
 *
 * Neither store is authoritative — a machine that has run both kiro-cli 2.x and
 * the Kiro IDE carries two tokens, and the stale one is often the file — so
 * both are read and compared by expiry instead of being ranked by source. An
 * explicit path is an override and short-circuits the search.
 */
export async function loadKiroToken(
  cacheDir: string,
  explicitPath?: string | undefined,
  secretStore?: SecretStoreOptions | undefined,
): Promise<TokenSource> {
  if (explicitPath) return { token: await readTokenFile(explicitPath), origin: explicitPath }

  const [fromFile, fromStore] = await Promise.all([
    attempt(async () => {
      const path = await resolveTokenPath(cacheDir)
      return { token: await readTokenFile(path), origin: path }
    }),
    attempt(async () => {
      const token = await readSecretStoreToken(secretStore)
      return token ? { token, origin: 'kiro-cli secret store' } : null
    }),
  ])

  const found = [fromStore.value, fromFile.value].filter((entry): entry is TokenSource => entry !== null)
  if (found.length === 0) {
    const fileDetail = (fromFile.error ?? `No token in ${cacheDir}`).split('\n').join('\n  ')
    throw new Error(
      `Could not find a Kiro credential. Run: kiro-cli login\n` +
        `- kiro-cli secret store (${describeSecretStore(secretStore)}): ${fromStore.error ?? 'no token stored'}\n` +
        `- ${fileDetail}`,
    )
  }
  found.sort((a, b) => tokenFreshnessScore(b.token) - tokenFreshnessScore(a.token))
  return found[0]!
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await fn(), error: null }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function resolveTokenPath(cacheDir: string, explicitPath?: string | undefined): Promise<string> {
  if (explicitPath) return explicitPath

  const candidates = TOKEN_FILENAMES.map((filename) => join(cacheDir, filename))

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      if (TOKEN_FILENAMES.includes(entry.name as typeof TOKEN_FILENAMES[number])) continue
      candidates.push(join(cacheDir, entry.name))
    }
  } catch (error) {
    throw new Error(`Unable to read Kiro token cache directory ${cacheDir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  const valid: TokenCandidate[] = []
  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      const [token, info] = await Promise.all([readTokenFile(candidate), stat(candidate)])
      valid.push({ path: candidate, token, mtimeMs: info.mtimeMs, preferredNameRank: preferredNameScore(candidate) })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (valid.length > 0) {
    valid.sort(compareTokenCandidates)
    return valid[0]!.path
  }

  const searched = candidates.map((candidate) => `- ${candidate}`).join('\n')
  throw new Error(`Could not find a valid Kiro token file. Searched:\n${searched}${lastError ? `\nLast error: ${lastError.message}` : ''}`)
}

async function readTokenFile(path: string): Promise<KiroToken> {
  const token = JSON.parse(await readFile(path, 'utf8')) as KiroToken
  validateToken(token)
  return token
}

/** Prefer the token that expires latest, then the most recently written. */
function compareTokenCandidates(a: TokenCandidate, b: TokenCandidate): number {
  const aFresh = tokenFreshnessScore(a.token)
  const bFresh = tokenFreshnessScore(b.token)
  if (aFresh !== bFresh) return bFresh - aFresh
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  if (a.preferredNameRank !== b.preferredNameRank) return a.preferredNameRank - b.preferredNameRank
  return a.path.localeCompare(b.path)
}

function tokenFreshnessScore(token: KiroToken): number {
  const expiresAt = new Date(token.expiresAt).getTime()
  return Number.isFinite(expiresAt) ? expiresAt : 0
}

function preferredNameScore(path: string): number {
  const filename = path.split('/').pop() ?? path
  const index = TOKEN_FILENAMES.indexOf(filename as typeof TOKEN_FILENAMES[number])
  return index === -1 ? TOKEN_FILENAMES.length : index
}

function refreshTokenViaCli(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('kiro-cli', ['chat', '--list-models'], { timeout: REFRESH_TIMEOUT_MS }, (err) => {
      if (err) reject(new Error(`Token refresh failed: ${err.message}`))
      else resolve()
    })
  })
}

export function validateToken(token: KiroToken): void {
  if (!token || typeof token !== 'object') throw new Error('Kiro token file is invalid')
  if (typeof token.accessToken !== 'string' || token.accessToken.length < 16) throw new Error('Kiro token file is missing accessToken')
  if (typeof token.profileArn !== 'string' || !token.profileArn.startsWith('arn:')) throw new Error('Kiro token file is missing profileArn')
  if (typeof token.expiresAt !== 'string' || Number.isNaN(new Date(token.expiresAt).getTime())) throw new Error('Kiro token file is missing expiresAt')
}

function osTag(): string {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
}

// Exact User-Agent format captured from kiro-cli 2.5.1 (AWS Rust SDK).
export function userAgent(identity: ClientIdentityConfig): string {
  if (identity.userAgent) return identity.userAgent
  const v = identity.kiroCliVersion
  return `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/${osTag()} lang/rust/1.92.0 exec-env/AmazonQ-For-CLI Version/${v} md/appVersion-${v} app/AmazonQ-For-CLI`
}

export function amzUserAgent(identity: ClientIdentityConfig): string {
  if (identity.amzUserAgent) return identity.amzUserAgent
  const v = identity.kiroCliVersion
  return `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/${osTag()} lang/rust/1.92.0 exec-env/AmazonQ-For-CLI Version/${v} m/F app/AmazonQ-For-CLI`
}
