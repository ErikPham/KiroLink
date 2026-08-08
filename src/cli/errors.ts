/**
 * CLI-facing errors.
 *
 * Distinct from the HTTP error hierarchy in errors.ts: those map a request
 * failure to a status code, while these are startup and configuration problems
 * shown to a person in a terminal. What makes them different is `hint` — a
 * concrete next action, because "Auth mode api-key requires a key" tells the
 * user what is wrong but not what to do about it.
 */

export type CliErrorOptions = {
  /** Concrete next step, e.g. "Run: kirolink setup". */
  hint?: string
  /** Docs or issue URL relevant to this failure. */
  seeAlso?: string
  cause?: unknown
}

export class CliError extends Error {
  override readonly name = 'CliError'
  readonly hint: string | undefined
  readonly seeAlso: string | undefined

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.hint = options.hint
    this.seeAlso = options.seeAlso
  }
}

/**
 * Render an error for the terminal: the message, then the hint indented beneath
 * it so the eye reaches the action without re-reading the message.
 */
export function formatCliError(error: unknown): string {
  if (error instanceof CliError) {
    const lines = [`Error: ${error.message}`]
    if (error.hint) lines.push(`  → ${error.hint}`)
    if (error.seeAlso) lines.push(`  See: ${error.seeAlso}`)
    return `${lines.join('\n')}\n`
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}\n`
}

/** The upstream rejected the credential. */
export function invalidCredentialError(detail: string, mode: 'cli' | 'api-key'): CliError {
  return mode === 'api-key'
    ? new CliError(`Kiro rejected the API key (${detail})`, {
        hint: 'The key may be wrong or issued for a different region. Run: kirolink doctor',
      })
    : new CliError(`Kiro rejected the kiro-cli token (${detail})`, {
        hint: 'The cached token may be stale. Run: kiro-cli login',
      })
}

/** api-key mode selected with no key available from any source. */
export function missingApiKeyError(): CliError {
  return new CliError('Auth mode api-key needs a Kiro API key', {
    hint: 'Run: kirolink setup — or pass --kiro-api-key <key> once and it will be remembered',
  })
}

/** No usable kiro-cli token on disk. */
export function missingTokenError(detail: string): CliError {
  return new CliError(`Could not load a kiro-cli token (${detail})`, {
    hint: 'Run: kiro-cli login — or switch to an API key with: kirolink setup',
  })
}
