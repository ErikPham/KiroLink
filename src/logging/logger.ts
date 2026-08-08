/**
 * Logger port.
 *
 * Replaces the previous arrangement of a module-level `verbose` boolean plus
 * `setDebugSink()` calls that pushed a function into two other modules at
 * import time. Loggers are now passed explicitly, so a second server instance
 * (or a test) can have its own without touching process-global state.
 *
 * `fields` is an optional structured record: text sinks render it as
 * `key=value` pairs, and a JSON sink can emit it verbatim, so operators can
 * aggregate on it. Field builders are only invoked when the level is enabled,
 * which keeps the expensive payload summarization off the hot path.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, string | number | boolean | undefined>

export type Logger = {
  isEnabled(level: LogLevel): boolean
  log(level: LogLevel, message: string, fields?: LogFields): void
  /** Emit only if `debug` is enabled; `build` is skipped otherwise. */
  lazyDebug(build: () => { message: string; fields?: LogFields }): void
}

export type LoggerOptions = {
  /** Emit debug-level records. */
  verbose?: boolean
  /** Suppress info-level records (request traces). Warnings and errors still emit. */
  quiet?: boolean
  /** Emit newline-delimited JSON instead of human-readable text. */
  json?: boolean
  /** Sink for rendered lines. Defaults to stderr. */
  write?: (line: string) => void
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => { process.stderr.write(line) })
  const minLevel = options.verbose ? 'debug' : options.quiet ? 'warn' : 'info'
  const threshold = LEVEL_ORDER[minLevel]

  const isEnabled = (level: LogLevel): boolean => LEVEL_ORDER[level] >= threshold

  const log = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (!isEnabled(level)) return
    write(options.json ? renderJson(level, message, fields) : renderText(level, message, fields))
  }

  return {
    isEnabled,
    log,
    lazyDebug(build) {
      if (!isEnabled('debug')) return
      const record = build()
      log('debug', record.message, record.fields)
    },
  }
}

/** A logger that discards everything. */
export function createNullLogger(): Logger {
  return {
    isEnabled: () => false,
    log: () => {},
    lazyDebug: () => {},
  }
}

function renderText(level: LogLevel, message: string, fields?: LogFields): string {
  const rendered = formatFields(fields)
  const prefix = level === 'info' ? '' : `[${level}] `
  return `${prefix}${message}${rendered ? ` ${rendered}` : ''}\n`
}

function renderJson(level: LogLevel, message: string, fields?: LogFields): string {
  const record: Record<string, unknown> = { time: new Date().toISOString(), level, message }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) record[key] = value
    }
  }
  return `${JSON.stringify(record)}\n`
}

function formatFields(fields?: LogFields): string {
  if (!fields) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) parts.push(`${key}=${value}`)
  }
  return parts.join(' ')
}
