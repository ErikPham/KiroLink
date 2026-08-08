#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Parses flags, dispatches subcommands, and owns process lifecycle. All behavior
 * lives behind createKiroLink and the command modules.
 */

import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createKiroLink } from './app'
import { listenWithFallback } from './http/listen'
import { assertSafeBind, assertUpstreamConfig, describeUpstream } from './config/config'
import { loadConfig, type CliOverrides, type LoadConfigResult } from './config/env'
import { buildUserConfigToSave, loadUserConfig, saveUserConfig, type UserConfig } from './config/user-config'
import { createAuthProvider } from './kiro/auth'
import { createUsageService, formatUsageLine } from './kiro/usage'
import { createLogger } from './logging/logger'
import { runTraySupervisor, startTray, stopTray, trayStatus } from './tray/supervisor'
import { formatDoctorReport, runDoctor } from './cli/doctor'
import { CliError, formatCliError, missingApiKeyError } from './cli/errors'
import { renderHelp } from './cli/help'
import { isInteractive, PromptCancelledError, style, symbols } from './cli/prompt'
import { runSetup } from './cli/setup'

/** Grace period for in-flight requests during shutdown. */
const SHUTDOWN_GRACE_MS = 5_000

const COMMANDS = ['serve', 'setup', 'doctor', 'tray'] as const
type Command = typeof COMMANDS[number]

const TRAY_ACTIONS = ['start', 'stop', 'status', 'restart', 'run'] as const
type TrayAction = typeof TRAY_ACTIONS[number]

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      'max-concurrent': { type: 'string' },
      delay: { type: 'string' },
      'api-key': { type: 'string' },
      auth: { type: 'string' },
      'kiro-api-key': { type: 'string' },
      'api-region': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.version === true) {
    process.stdout.write(`${await readVersion()}\n`)
    return
  }

  const command = resolveCommand(positionals)

  // The config path can itself be overridden, so it is resolved before the
  // stored file is read.
  const cli = toCliOverrides(values)
  const bootstrap = loadConfig({ cli })
  const stored = await loadUserConfig(bootstrap.config.configPath)
  const resolved = loadConfig({ cli, stored, configPath: bootstrap.config.configPath })

  if (values.help === true) {
    process.stdout.write(renderHelp(resolved.config.configPath))
    return
  }

  switch (command) {
    case 'setup':
      await runSetup({ configPath: resolved.config.configPath, existing: stored })
      return
    case 'doctor':
      await doctorCommand(resolved)
      return
    case 'tray':
      await trayCommand(resolved, positionals[1])
      return
    case 'serve':
      await serveCommand(resolved, stored, cli)
      return
  }
}

async function trayCommand(resolved: LoadConfigResult, rawAction: string | undefined): Promise<void> {
  const action = rawAction ?? 'start'
  if (!(TRAY_ACTIONS as readonly string[]).includes(action)) {
    throw new CliError(`Unknown tray action: ${action}`, { hint: `Available: ${TRAY_ACTIONS.join(', ')}` })
  }

  const { config } = resolved

  switch (action as TrayAction) {
    case 'run': {
      // The detached supervisor body. Not meant to be invoked directly.
      const version = await readVersion()
      const logger = createLogger({ verbose: config.diagnostics.verbose, json: config.diagnostics.json })
      await runTraySupervisor({ config, logger, version })
      return
    }
    case 'start': {
      assertUpstreamConfig(config.upstream)
      const { state, alreadyRunning } = await startTray(config, cliEntryPath())
      process.stdout.write(alreadyRunning
        ? `${symbols.info} Tray already running (pid ${state.pid}) on ${state.baseUrl}\n`
        : `${symbols.pass} Tray started (pid ${state.pid}, ${state.mode}) on ${state.baseUrl}\n`)
      if (state.reason) process.stdout.write(`  ${symbols.warn} ${state.reason}\n`)
      return
    }
    case 'stop': {
      const stopped = await stopTray(config)
      process.stdout.write(stopped ? `${symbols.pass} Tray stopped.\n` : `${symbols.info} No tray was running.\n`)
      return
    }
    case 'restart': {
      await stopTray(config)
      const { state } = await startTray(config, cliEntryPath())
      process.stdout.write(`${symbols.pass} Tray restarted (pid ${state.pid}) on ${state.baseUrl}\n`)
      return
    }
    case 'status': {
      const state = await trayStatus(config)
      if (!state) {
        process.stdout.write(`${symbols.info} Tray is not running.\n`)
        process.exitCode = 1
        return
      }
      process.stdout.write(`${symbols.pass} Tray running\n`)
      process.stdout.write(`  pid       ${state.pid}\n`)
      process.stdout.write(`  mode      ${state.mode}\n`)
      process.stdout.write(`  base URL  ${state.baseUrl}\n`)
      process.stdout.write(`  started   ${state.startedAt}\n`)
      if (state.reason) process.stdout.write(`  note      ${state.reason}\n`)
      return
    }
  }
}

/** Absolute path of this CLI, so the detached supervisor can re-invoke it. */
function cliEntryPath(): string {
  return fileURLToPath(import.meta.url)
}

function resolveCommand(positionals: string[]): Command {
  const first = positionals[0]
  if (first === undefined) return 'serve'
  if ((COMMANDS as readonly string[]).includes(first)) return first as Command
  throw new CliError(`Unknown command: ${first}`, {
    hint: `Available: ${COMMANDS.join(', ')} — or run kirolink --help`,
  })
}

async function doctorCommand(resolved: LoadConfigResult): Promise<void> {
  const { config } = resolved
  const logger = createLogger({ quiet: true })
  const auth = createAuthProvider(config.upstream, logger)
  const usage = createUsageService({ upstream: config.upstream, identity: config.identity, auth, logger })

  const report = await runDoctor({ config, auth, usage })
  process.stdout.write(formatDoctorReport(report, config, symbols))
  if (!report.healthy) process.exitCode = 1
}

async function serveCommand(
  resolved: LoadConfigResult,
  stored: UserConfig,
  cli: CliOverrides,
): Promise<void> {
  let { config, sources } = resolved

  // A first run in api-key mode with no key used to fail with a bare
  // "requires --kiro-api-key". Offer the wizard instead when a human is present.
  if (config.upstream.mode === 'api-key' && !config.upstream.kiroApiKey) {
    if (!isInteractive()) throw missingApiKeyError()
    const setup = await runSetup({
      configPath: config.configPath,
      existing: stored,
      reason: 'No Kiro API key is configured yet.',
    })
    if (!setup.saved) throw missingApiKeyError()
    const reloaded = loadConfig({ cli, stored: setup.config, configPath: config.configPath })
    config = reloaded.config
    sources = reloaded.sources
    stored = setup.config
  }

  assertUpstreamConfig(config.upstream)
  assertSafeBind(config.server)

  // Remember mode, key, and region so the next start needs no re-entry.
  await saveUserConfig(buildUserConfigToSave(config.upstream, stored, sources), config.configPath)

  const version = await readVersion()
  const app = createKiroLink(config, { version })

  // Best-effort: a failed credit lookup must not prevent serving.
  const usage = await app.usage.fetch({ force: true })
  const usageLine = formatUsageLine(usage)

  const port = await listenWithFallback(app.server, config.server.port, config.server.host, {
    onRetry: (busy, next) => process.stderr.write(`Port ${busy} in use, trying ${next}...\n`),
  })
  const baseUrl = `http://${config.server.host}:${port}`
  process.stdout.write(`kirolink listening on ${baseUrl}  auth=${describeUpstream(config.upstream)}\n`)
  process.stdout.write(`  ${usageLine}\n`)
  process.stdout.write(`  ${style.dim(`dashboard ${baseUrl}`)}\n`)
  if (!usage.ok) {
    process.stdout.write(`  ${symbols.warn} ${style.dim('credits unavailable — run: kirolink doctor')}\n`)
  }
  app.logger.log('debug', 'resolved config', {
    path: config.configPath,
    auth: sources.auth,
    key: sources.kiroApiKey,
    region: sources.apiRegion,
  })

  installShutdownHandlers(app.server)
}

function toCliOverrides(values: Record<string, string | boolean | undefined>): CliOverrides {
  return {
    port: asString(values['port']),
    host: asString(values['host']),
    quiet: asBool(values['quiet']),
    verbose: asBool(values['verbose']),
    json: asBool(values['json']),
    maxConcurrent: asString(values['max-concurrent']),
    delay: asString(values['delay']),
    apiKey: asString(values['api-key']),
    auth: asString(values['auth']),
    kiroApiKey: asString(values['kiro-api-key']),
    apiRegion: asString(values['api-region']),
  }
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBool(value: string | boolean | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Graceful shutdown: stop accepting connections, allow in-flight requests a
 * short grace period, then exit.
 */
function installShutdownHandlers(server: Server): void {
  let shuttingDown = false

  const shutdown = (code: number): void => {
    if (shuttingDown) return
    shuttingDown = true

    const timer = setTimeout(() => { process.exit(code) }, SHUTDOWN_GRACE_MS)
    timer.unref()
    server.close(() => {
      clearTimeout(timer)
      process.exit(code)
    })
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { shutdown(0) })
  }

  /**
   * An uncaught exception leaves the process in a state the runtime has declared
   * unsafe. The previous handler logged and continued forever, so a repeating
   * fault became a silent infinite error loop that no supervisor would restart.
   * Log, drain briefly, then exit non-zero so a supervisor can restart cleanly.
   */
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[fatal] uncaught exception: ${error.stack ?? error.message}\n`)
    shutdown(1)
  })
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    process.stderr.write(`[fatal] unhandled rejection: ${detail}\n`)
    shutdown(1)
  })
}

async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(await readFile(url, 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

try {
  await main()
} catch (error) {
  // Ctrl+C at a prompt is a normal exit, not a failure worth a stack trace.
  if (error instanceof PromptCancelledError) {
    process.stderr.write('Cancelled.\n')
    process.exitCode = 130
  } else {
    process.stderr.write(formatCliError(error))
    process.exitCode = 1
  }
}
