/**
 * User config file: normalization, persistence, and permissions.
 */

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildUserConfigToSave,
  loadUserConfig,
  normalizeUserConfig,
  saveUserConfig,
} from '../../src/config/user-config'

async function tempPath(name = 'config.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'kirolink-config-')), name)
}

describe('normalizeUserConfig', () => {
  it('accepts camelCase, snake, and kebab aliases', () => {
    expect(normalizeUserConfig({ auth: 'api-key', kiro_api_key: 'k'.repeat(20), 'api-region': 'eu-central-1' }))
      .toEqual({ auth: 'api-key', kiroApiKey: 'k'.repeat(20), apiRegion: 'eu-central-1' })
  })

  it('drops an invalid stored auth mode rather than failing startup', () => {
    expect(normalizeUserConfig({ auth: 'nonsense', apiRegion: 'us-east-1' })).toEqual({ apiRegion: 'us-east-1' })
  })

  it('drops a malformed region', () => {
    expect(normalizeUserConfig({ apiRegion: 'not a region' })).toEqual({})
  })

  it.each([null, undefined, 'text', 42, []])('returns an empty config for %s', (input) => {
    expect(normalizeUserConfig(input)).toEqual({})
  })
})

describe('buildUserConfigToSave', () => {
  it('retains a previously saved key when switching to cli', () => {
    const next = buildUserConfigToSave(
      { mode: 'cli', kiroApiKey: undefined, apiRegion: undefined },
      { kiroApiKey: 'k'.repeat(20), apiRegion: 'eu-central-1' },
    )

    // Keeping the key means a later `--auth api-key` works without re-entry.
    expect(next).toEqual({ auth: 'cli', kiroApiKey: 'k'.repeat(20), apiRegion: 'eu-central-1' })
  })

  it('overwrites the key and region when new ones are supplied', () => {
    const next = buildUserConfigToSave(
      { mode: 'api-key', kiroApiKey: 'new-key-value-here-ok', apiRegion: 'us-west-2' },
      { kiroApiKey: 'old', apiRegion: 'eu-central-1' },
    )

    expect(next).toEqual({ auth: 'api-key', kiroApiKey: 'new-key-value-here-ok', apiRegion: 'us-west-2' })
  })

  it('writes only the mode when nothing else is known', () => {
    expect(buildUserConfigToSave({ mode: 'cli', kiroApiKey: undefined, apiRegion: undefined })).toEqual({ auth: 'cli' })
  })

  it('leaves the saved mode alone when the run took it from the environment', () => {
    const next = buildUserConfigToSave(
      { mode: 'cli', kiroApiKey: 'k'.repeat(20), apiRegion: 'us-east-1' },
      { auth: 'api-key', kiroApiKey: 'k'.repeat(20), apiRegion: 'us-east-1' },
      { auth: 'env', kiroApiKey: 'config', apiRegion: 'config' },
    )

    expect(next.auth).toBe('api-key')
  })

  it('never writes an api key that came from the environment', () => {
    const next = buildUserConfigToSave(
      { mode: 'api-key', kiroApiKey: 'secret-from-env-only', apiRegion: undefined },
      {},
      { auth: 'cli', kiroApiKey: 'env', apiRegion: 'default' },
    )

    expect(next).toEqual({ auth: 'api-key' })
  })
})

describe('load and save', () => {
  it('round-trips with owner-only permissions', async () => {
    const path = await tempPath()
    await saveUserConfig({ auth: 'api-key', kiroApiKey: 'k'.repeat(24), apiRegion: 'eu-central-1' }, path)

    expect(await loadUserConfig(path)).toEqual({
      auth: 'api-key',
      kiroApiKey: 'k'.repeat(24),
      apiRegion: 'eu-central-1',
    })

    // The file holds a credential, so it must not be group- or world-readable
    // regardless of the caller's umask.
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('returns an empty config when the file is missing', async () => {
    expect(await loadUserConfig(await tempPath('absent.json'))).toEqual({})
  })

  it('reads a hand-written file', async () => {
    const path = await tempPath()
    await writeFile(path, JSON.stringify({ auth: 'api-key', 'kiro-api-key': 'hand-written-key-xx' }))

    expect(await loadUserConfig(path)).toEqual({ auth: 'api-key', kiroApiKey: 'hand-written-key-xx' })
  })

  it('reports a corrupt file rather than silently ignoring it', async () => {
    const path = await tempPath()
    await writeFile(path, '{not json')

    await expect(loadUserConfig(path)).rejects.toThrow(/Failed to read config/u)
  })

  it('creates the parent directory when needed', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'kirolink-nested-')), 'deep', 'nested', 'config.json')
    await saveUserConfig({ auth: 'cli' }, path)

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ auth: 'cli' })
  })

  it('overwrites atomically, leaving no temp file behind', async () => {
    const path = await tempPath()
    await saveUserConfig({ auth: 'cli' }, path)
    await saveUserConfig({ auth: 'api-key', kiroApiKey: 'k'.repeat(24) }, path)

    expect((await loadUserConfig(path)).auth).toBe('api-key')
    await expect(stat(`${path}.tmp`)).rejects.toThrow()
  })
})
