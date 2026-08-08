/**
 * First-run setup wizard.
 *
 * Runs on `kirolink setup`, and automatically when starting with no saved config
 * in an interactive terminal. Previously a first run in api-key mode failed with
 * "Auth mode api-key requires --kiro-api-key", which states the problem without
 * offering a way forward.
 *
 * Non-interactive callers (CI, pipes) never reach this: the caller checks
 * `isInteractive()` first, so scripted use keeps failing fast on flags.
 */

import { stdout } from 'node:process'
import type { UpstreamAuthMode } from '../config/config'
import { normalizeRegion } from '../config/env'
import type { UserConfig } from '../config/user-config'
import { saveUserConfig } from '../config/user-config'
import { promptConfirm, promptSecret, promptSelect, promptText, style, symbols } from './prompt'

const MIN_KEY_BYTES = 16
const DEFAULT_REGION = 'us-east-1'

const REGIONS = [
  'us-east-1',
  'eu-central-1',
  'ap-southeast-1',
  'ap-northeast-1',
] as const

export type SetupResult = {
  config: UserConfig
  /** False when the user declined to change anything. */
  saved: boolean
}

export async function runSetup(options: {
  configPath: string
  existing: UserConfig
  /** Skip the intro when the wizard was triggered by a failed start. */
  reason?: string
}): Promise<SetupResult> {
  const { configPath, existing } = options

  stdout.write('\n')
  if (options.reason) {
    stdout.write(`${symbols.warn} ${options.reason}\n\n`)
  }
  stdout.write(`${style.bold('KiroLink setup')}\n`)
  stdout.write(style.dim(`Settings are saved to ${configPath} (mode 0600).\n\n`))

  const mode = await promptSelect<UpstreamAuthMode>('How should KiroLink authenticate with Kiro?', [
    {
      value: 'cli',
      label: 'kiro-cli (recommended)',
      description: 'reuses your kiro-cli login, refreshes automatically',
    },
    {
      value: 'api-key',
      label: 'Kiro API key',
      description: 'a static key; no kiro-cli needed',
    },
  ], { defaultIndex: existing.auth === 'api-key' ? 1 : 0 })

  const next: UserConfig = { ...existing, auth: mode }

  if (mode === 'api-key') {
    const key = await collectApiKey(existing.kiroApiKey)
    if (key) next.kiroApiKey = key

    const region = await collectRegion(existing.apiRegion)
    if (region) next.apiRegion = region
    else delete next.apiRegion
  } else {
    stdout.write(`\n${symbols.info} ${style.dim('Using the kiro-cli token cache. Run "kiro-cli login" if it is not set up yet.')}\n`)
    // A previously saved key is kept so switching back needs no re-entry.
  }

  stdout.write('\n')
  const confirmed = await promptConfirm(`Save to ${configPath}?`)
  if (!confirmed) {
    stdout.write(`${symbols.info} Nothing saved.\n`)
    return { config: existing, saved: false }
  }

  await saveUserConfig(next, configPath)
  stdout.write(`${symbols.pass} Saved.\n`)
  stdout.write(style.dim(`  Verify with: kirolink doctor\n`))
  stdout.write(style.dim(`  Then start:  kirolink\n\n`))

  return { config: next, saved: true }
}

async function collectApiKey(existingKey: string | undefined): Promise<string | undefined> {
  if (existingKey) {
    stdout.write(`\n${symbols.info} A key is already saved (${mask(existingKey)}).\n`)
    const replace = await promptConfirm('Replace it?', false)
    if (!replace) return existingKey
  }

  return promptSecret('Kiro API key', {
    validate: (value) => {
      if (!value) return 'A key is required for api-key mode'
      if (Buffer.byteLength(value) < MIN_KEY_BYTES) return `Too short — keys are at least ${MIN_KEY_BYTES} characters`
      return undefined
    },
  })
}

async function collectRegion(existingRegion: string | undefined): Promise<string | undefined> {
  const choices = [
    ...REGIONS.map((region) => ({ value: region as string, label: region })),
    { value: '', label: 'Other…', description: 'enter a region id' },
  ]
  const defaultIndex = existingRegion
    ? Math.max(0, REGIONS.indexOf(existingRegion as typeof REGIONS[number]))
    : 0

  stdout.write('\n')
  const picked = await promptSelect('Which Kiro runtime region?', choices, { defaultIndex })
  if (picked) return picked

  const custom = await promptText('Region id', {
    defaultValue: existingRegion ?? DEFAULT_REGION,
    validate: (value) => (normalizeRegion(value) ? undefined : 'Use a simple region id, e.g. eu-central-1'),
  })
  return normalizeRegion(custom)
}

function mask(value: string): string {
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-2)}`
}
