/**
 * Tray supervisor.
 *
 * Owns the proxy lifecycle in the foreground of a detached process, drives the
 * platform helper, and answers `tray status` / `tray stop` through the pid and
 * state files. Falls back to running headless when no helper is available, so
 * the proxy always works even where a tray icon does not.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { openSync } from 'node:fs'
import type { Server } from 'node:http'
import { platform } from 'node:process'
import { createKiroLink, type KiroLinkApp } from '../app'
import type { KiroLinkConfig } from '../config/config'
import { describeUpstream } from '../config/config'
import { listenWithFallback } from '../http/listen'
import { formatUsageLine } from '../kiro/usage'
import type { Logger } from '../logging/logger'
import { buildLinuxTrayHelper, detectLinuxTrayBackend, linuxTrayInstallHint } from './helper-linux'
import { buildMacTrayHelper, isMacTrayAvailable } from './helper-macos'
import { buildWindowsTrayHelper, isWindowsTrayAvailable } from './helper-windows'
import {
  createLineReader,
  encodeNotify,
  encodeStatus,
  isTrayCommand,
  type TrayCommand,
  type TrayStatus,
} from './protocol'
import {
  clearTrayRuntime,
  ensureTrayRuntimeDir,
  isProcessRunning,
  readTrayState,
  runningTray,
  trayLogPath,
  writeTrayPid,
  writeTrayState,
  type TrayMode,
  type TrayState,
} from './runtime'

/** How often the menu and state file are refreshed. */
const REFRESH_INTERVAL_MS = 2_500
/** How long to wait for a detached supervisor to report itself ready. */
const START_TIMEOUT_MS = 30_000
/** Warn once when remaining credits drop below this fraction of the limit. */
const LOW_CREDIT_FRACTION = 0.1

export type TrayHelperSpec = { command: string; args: string[] }

export type SupervisorDeps = {
  config: KiroLinkConfig
  logger: Logger
  version: string
  /** Injected for tests, to avoid spawning a real helper. */
  resolveHelper?: () => Promise<{ helper: TrayHelperSpec; mode: TrayMode; reason?: string }>
  listen?: (server: Server, port: number, host: string) => Promise<number>
}

/**
 * Start a detached supervisor and wait until it reports ready.
 *
 * Readiness is proven by the state file rather than by the process merely being
 * alive, so a helper that dies during startup surfaces as an error instead of a
 * silent no-op.
 */
export async function startTray(
  config: KiroLinkConfig,
  cliEntry: string,
): Promise<{ state: TrayState; alreadyRunning: boolean }> {
  const existing = await runningTray(config.configPath)
  if (existing) return { state: existing, alreadyRunning: true }

  await ensureTrayRuntimeDir(config.configPath)
  await clearTrayRuntime(config.configPath)

  const logPath = trayLogPath(config.configPath)
  const logFd = openSync(logPath, 'a', 0o600)
  const child = spawn(process.execPath, [cliEntry, 'tray', 'run'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, KIROLINK_TRAY_CHILD: '1' },
  })
  // Unref so the launching CLI can exit while the supervisor keeps running.
  child.unref()

  if (child.pid === undefined) {
    throw new Error('Could not start the tray supervisor')
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessRunning(child.pid)) {
      throw new Error(`The tray supervisor exited during startup. See ${logPath}`)
    }
    const state = await readTrayState(config.configPath)
    if (state?.ready && state.pid === child.pid) return { state, alreadyRunning: false }
    await sleep(150)
  }

  process.kill(child.pid, 'SIGTERM')
  throw new Error(`Timed out waiting for the tray supervisor. See ${logPath}`)
}

/** Stop a running supervisor and wait for it to exit. */
export async function stopTray(config: KiroLinkConfig): Promise<boolean> {
  const state = await runningTray(config.configPath)
  if (!state) {
    await clearTrayRuntime(config.configPath)
    return false
  }

  process.kill(state.pid, 'SIGTERM')

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!isProcessRunning(state.pid)) break
    await sleep(150)
  }
  if (isProcessRunning(state.pid)) process.kill(state.pid, 'SIGKILL')

  await clearTrayRuntime(config.configPath)
  return true
}

export function trayStatus(config: KiroLinkConfig): Promise<TrayState | null> {
  return runningTray(config.configPath)
}

/**
 * The supervisor body. Runs in the foreground of the detached child until it
 * receives SIGTERM or the helper asks to quit.
 */
export async function runTraySupervisor(deps: SupervisorDeps): Promise<void> {
  const { config, logger, version } = deps
  const listen = deps.listen ?? ((server, port, host) => listenWithFallback(server, port, host))

  const app = createKiroLink(config, { version })
  const port = await listen(app.server, config.server.port, config.server.host)
  const baseUrl = `http://${config.server.host}:${port}`

  const resolve = deps.resolveHelper ?? (() => resolveHelperForPlatform(config))
  const { helper, mode, reason } = await resolve()

  const child = mode === 'native' ? spawnHelper(helper, logger) : undefined
  if (mode === 'headless' && reason) logger.log('warn', reason)

  const state: TrayState = {
    pid: process.pid,
    ready: true,
    mode,
    startedAt: new Date().toISOString(),
    port,
    baseUrl,
    ...(reason ? { reason } : {}),
  }
  await writeTrayPid(config.configPath, process.pid)
  await writeTrayState(config.configPath, state)

  logger.log('info', `tray supervisor running (${mode}) on ${baseUrl}`)

  const controller = createController({ app, config, baseUrl, child, logger })
  const timer = setInterval(() => { void controller.refresh() }, REFRESH_INTERVAL_MS)
  timer.unref()
  await controller.refresh()

  await new Promise<void>((done) => {
    const shutdown = (): void => {
      clearInterval(timer)
      void controller.shutdown().finally(done)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    child?.once('exit', shutdown)
    controller.onQuit(shutdown)
  })

  await clearTrayRuntime(config.configPath)
}

type ControllerDeps = {
  app: KiroLinkApp
  config: KiroLinkConfig
  baseUrl: string
  child: ChildProcess | undefined
  logger: Logger
}

function createController(deps: ControllerDeps) {
  const { app, config, baseUrl, child, logger } = deps
  let quitHandler: (() => void) | undefined
  let warnedLowCredits = false
  let stopped = false

  const send = (line: string): void => {
    if (child?.stdin?.writable) child.stdin.write(line)
  }

  const refresh = async (): Promise<void> => {
    const usage = await app.usage.fetch().catch(() => undefined)
    const metrics = app.metrics.snapshot()

    const status: TrayStatus = {
      running: !stopped,
      baseUrl,
      credits: usage ? formatUsageLine(usage) : 'credits unknown',
      requests: metrics.total,
      auth: describeUpstream(config.upstream),
    }
    send(encodeStatus(status))
    await writeTrayState(config.configPath, {
      pid: process.pid,
      ready: true,
      mode: child ? 'native' : 'headless',
      startedAt: new Date().toISOString(),
      port: status.running ? Number(new URL(baseUrl).port) : 0,
      baseUrl,
    })

    // Notify once per low-credit episode, not on every refresh.
    if (usage?.ok && usage.limit > 0) {
      const low = usage.remaining <= usage.limit * LOW_CREDIT_FRACTION
      if (low && !warnedLowCredits) {
        warnedLowCredits = true
        send(encodeNotify('KiroLink — credits low', formatUsageLine(usage)))
      } else if (!low) {
        warnedLowCredits = false
      }
    }
  }

  const handleCommand = async (command: TrayCommand): Promise<void> => {
    switch (command) {
      case 'dashboard':
      case 'open':
        await openUrl(baseUrl, logger)
        break
      case 'copy':
        await copyToClipboard(baseUrl, logger)
        send(encodeNotify('KiroLink', `Copied ${baseUrl}`))
        break
      case 'restart':
        // The proxy is stateless per request, so "restart" means resume serving
        // after a stop rather than rebuilding the graph.
        stopped = false
        await refresh()
        send(encodeNotify('KiroLink', 'Proxy resumed'))
        break
      case 'stop':
        stopped = true
        await refresh()
        send(encodeNotify('KiroLink', 'Proxy stopped'))
        break
      case 'quit':
        quitHandler?.()
        break
    }
  }

  if (child?.stdout) {
    child.stdout.setEncoding('utf8')
    const read = createLineReader((line) => {
      if (!isTrayCommand(line)) return
      void handleCommand(line).catch((error: unknown) => {
        logger.log('warn', `tray command failed: ${describe(error)}`)
      })
    })
    child.stdout.on('data', read)
  }

  return {
    refresh,
    onQuit(handler: () => void) { quitHandler = handler },
    async shutdown() {
      child?.stdin?.end()
      if (child?.pid !== undefined && isProcessRunning(child.pid)) child.kill('SIGTERM')
      await new Promise<void>((resolve) => { app.server.close(() => { resolve() }) })
    },
  }
}

function spawnHelper(helper: TrayHelperSpec, logger: Logger): ChildProcess {
  const child = spawn(helper.command, helper.args, { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    logger.log('debug', `tray helper: ${chunk.trim()}`)
  })
  child.on('error', (error) => {
    logger.log('warn', `tray helper failed: ${error.message}`)
  })
  return child
}

/** Pick a helper for this platform, or report why there is none. */
export async function resolveHelperForPlatform(
  config: KiroLinkConfig,
): Promise<{ helper: TrayHelperSpec; mode: TrayMode; reason?: string }> {
  const runtimeDir = await ensureTrayRuntimeDir(config.configPath)
  const headless = { helper: { command: '', args: [] }, mode: 'headless' as const }

  if (platform === 'darwin') {
    if (!(await isMacTrayAvailable())) {
      return { ...headless, reason: 'No Swift compiler found; running without a menu-bar icon. Install Xcode Command Line Tools: xcode-select --install' }
    }
    try {
      return { helper: { command: await buildMacTrayHelper(runtimeDir), args: [] }, mode: 'native' }
    } catch (error) {
      return { ...headless, reason: `Menu-bar helper unavailable: ${describe(error)}` }
    }
  }

  if (platform === 'win32') {
    if (!(await isWindowsTrayAvailable())) {
      return { ...headless, reason: 'PowerShell not found; running without a notification-area icon.' }
    }
    return { helper: await buildWindowsTrayHelper(runtimeDir), mode: 'native' }
  }

  const backend = await detectLinuxTrayBackend()
  if (!backend) {
    return { ...headless, reason: `No tray backend found; running without an icon. ${linuxTrayInstallHint()}` }
  }
  return { helper: await buildLinuxTrayHelper(runtimeDir, backend), mode: 'native' }
}

/** Open a URL in the desktop's default browser. */
async function openUrl(url: string, logger: Logger): Promise<void> {
  const [command, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  await run(command, args as string[], logger)
}

async function copyToClipboard(text: string, logger: Logger): Promise<void> {
  const [command, args] = platform === 'darwin'
    ? ['pbcopy', []]
    : platform === 'win32'
      ? ['clip', []]
      : ['xclip', ['-selection', 'clipboard']]

  await new Promise<void>((resolve) => {
    const child = spawn(command, args as string[], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', (error) => {
      logger.log('warn', `could not copy to clipboard: ${error.message}`)
      resolve()
    })
    child.on('exit', () => { resolve() })
    child.stdin?.end(text)
  })
}

function run(command: string, args: string[], logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', (error) => {
      logger.log('warn', `could not run ${command}: ${error.message}`)
      resolve()
    })
    child.on('exit', () => { resolve() })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
