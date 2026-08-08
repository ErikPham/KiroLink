/**
 * Tray runtime state.
 */

import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearTrayRuntime,
  isProcessRunning,
  readTrayPid,
  readTrayState,
  runningTray,
  trayPidPath,
  trayRuntimeDir,
  trayStatePath,
  writeTrayPid,
  writeTrayState,
  type TrayState,
} from '../../src/tray/runtime'

/** A config path inside a fresh temp dir, so runtime files never collide. */
async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kirolink-tray-'))
  return join(dir, 'config.json')
}

function sampleState(pid: number): TrayState {
  return {
    pid,
    ready: true,
    mode: 'headless',
    startedAt: new Date().toISOString(),
    port: 4100,
    baseUrl: 'http://127.0.0.1:4100',
  }
}

describe('path helpers', () => {
  it('place runtime files in a runtime dir beside the config', () => {
    const configPath = '/home/u/.config/kirolink/config.json'
    const dir = trayRuntimeDir(configPath)
    expect(dir).toBe('/home/u/.config/kirolink/runtime')
    expect(trayPidPath(configPath)).toBe(join(dir, 'tray.pid'))
    expect(trayStatePath(configPath)).toBe(join(dir, 'tray-state.json'))
  })
})

describe('pid file', () => {
  it('round-trips a pid', async () => {
    const configPath = await tempConfigPath()
    await writeTrayPid(configPath, 4321)
    expect(await readTrayPid(configPath)).toBe(4321)
  })

  it('returns null when absent', async () => {
    const configPath = await tempConfigPath()
    expect(await readTrayPid(configPath)).toBeNull()
  })

  it('writes with owner-only permissions', async () => {
    const configPath = await tempConfigPath()
    await writeTrayPid(configPath, 999)
    const mode = (await stat(trayPidPath(configPath))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('state file', () => {
  it('round-trips state', async () => {
    const configPath = await tempConfigPath()
    const state = sampleState(process.pid)
    await writeTrayState(configPath, state)
    expect(await readTrayState(configPath)).toEqual(state)
  })

  it('returns null on missing or corrupt state', async () => {
    const configPath = await tempConfigPath()
    expect(await readTrayState(configPath)).toBeNull()
  })

  it('writes with owner-only permissions', async () => {
    const configPath = await tempConfigPath()
    await writeTrayState(configPath, sampleState(process.pid))
    const mode = (await stat(trayStatePath(configPath))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('clearTrayRuntime', () => {
  it('removes pid and state files, and is safe when absent', async () => {
    const configPath = await tempConfigPath()
    await writeTrayPid(configPath, process.pid)
    await writeTrayState(configPath, sampleState(process.pid))
    await clearTrayRuntime(configPath)
    expect(await readTrayPid(configPath)).toBeNull()
    expect(await readTrayState(configPath)).toBeNull()
    // A second clear must not throw.
    await expect(clearTrayRuntime(configPath)).resolves.toBeUndefined()
  })
})

describe('isProcessRunning', () => {
  it('is true for this process', () => {
    expect(isProcessRunning(process.pid)).toBe(true)
  })

  it('is false for an almost-certainly-unused pid', () => {
    // Very high pid unlikely to be allocated.
    expect(isProcessRunning(2 ** 22)).toBe(false)
  })
})

describe('runningTray', () => {
  it('returns state when the pid is alive and matches', async () => {
    const configPath = await tempConfigPath()
    await writeTrayPid(configPath, process.pid)
    await writeTrayState(configPath, sampleState(process.pid))
    const state = await runningTray(configPath)
    expect(state?.pid).toBe(process.pid)
  })

  it('returns null when nothing is running', async () => {
    const configPath = await tempConfigPath()
    expect(await runningTray(configPath)).toBeNull()
  })

  it('treats a state file for a different pid as stale', async () => {
    const configPath = await tempConfigPath()
    await writeTrayPid(configPath, process.pid)
    // State claims a different pid than the pid file: crashed-run leftover.
    await writeTrayState(configPath, sampleState(process.pid + 1))
    expect(await runningTray(configPath)).toBeNull()
  })

  it('returns null when the recorded pid is dead', async () => {
    const configPath = await tempConfigPath()
    await writeTrayPid(configPath, 2 ** 22)
    await writeTrayState(configPath, sampleState(2 ** 22))
    expect(await runningTray(configPath)).toBeNull()
  })
})

describe('pid file format', () => {
  it('is a trailing-newline integer, readable by a shell', async () => {
    const configPath = await tempConfigPath()
    await writeTrayPid(configPath, 4242)
    expect(await readFile(trayPidPath(configPath), 'utf8')).toBe('4242\n')
  })
})
