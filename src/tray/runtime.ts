/**
 * Tray runtime state.
 *
 * The tray runs detached, so `kirolink tray status/stop` in a different terminal
 * needs a way to find it. Ownership is proven by a pid file plus a state file:
 * the pid alone is not enough, because pids are recycled and could point at an
 * unrelated process.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type TrayMode = 'native' | 'headless'

export type TrayState = {
  pid: number
  /** Set once the tray is serving; a half-started tray is not adopted. */
  ready: boolean
  mode: TrayMode
  startedAt: string
  port: number
  baseUrl: string
  /** Why the native helper was unavailable, when running headless. */
  reason?: string
}

/** Runtime files live beside the config so one directory holds all local state. */
export function trayRuntimeDir(configPath: string): string {
  return join(dirname(configPath), 'runtime')
}

export function trayPidPath(configPath: string): string {
  return join(trayRuntimeDir(configPath), 'tray.pid')
}

export function trayStatePath(configPath: string): string {
  return join(trayRuntimeDir(configPath), 'tray-state.json')
}

export function trayLogPath(configPath: string): string {
  return join(trayRuntimeDir(configPath), 'tray.log')
}

export async function ensureTrayRuntimeDir(configPath: string): Promise<string> {
  const dir = trayRuntimeDir(configPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export async function writeTrayState(configPath: string, state: TrayState): Promise<void> {
  await ensureTrayRuntimeDir(configPath)
  await writeFile(trayStatePath(configPath), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

export async function readTrayState(configPath: string): Promise<TrayState | null> {
  try {
    const parsed = JSON.parse(await readFile(trayStatePath(configPath), 'utf8')) as TrayState
    return typeof parsed.pid === 'number' ? parsed : null
  } catch {
    return null
  }
}

export async function writeTrayPid(configPath: string, pid: number): Promise<void> {
  await ensureTrayRuntimeDir(configPath)
  await writeFile(trayPidPath(configPath), `${pid}\n`, { mode: 0o600 })
}

export async function readTrayPid(configPath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(trayPidPath(configPath), 'utf8')).trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export async function clearTrayRuntime(configPath: string): Promise<void> {
  await Promise.all([
    rm(trayPidPath(configPath), { force: true }),
    rm(trayStatePath(configPath), { force: true }),
  ])
}

/** Signal 0 tests for existence without delivering a signal. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The running tray's state, or null when nothing is running. */
export async function runningTray(configPath: string): Promise<TrayState | null> {
  const pid = await readTrayPid(configPath)
  if (pid === null || !isProcessRunning(pid)) return null
  const state = await readTrayState(configPath)
  // A state file for a different pid is stale, left by a crashed run.
  return state !== null && state.pid === pid ? state : null
}
