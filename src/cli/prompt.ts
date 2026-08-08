/**
 * Terminal prompt primitives.
 *
 * Built on node:readline so the package keeps zero runtime dependencies. Only
 * what the setup wizard needs: text input, hidden input for secrets, a picker,
 * and a yes/no confirm.
 *
 * Every prompt requires a TTY. In a pipe or CI there is nobody to answer, so
 * callers must check `isInteractive()` and fall back to flags rather than
 * hanging forever waiting on stdin.
 */

import { createInterface, type Interface } from 'node:readline'
import { stdin, stdout } from 'node:process'

/** Raised when the user cancels with Ctrl+C or Ctrl+D. */
export class PromptCancelledError extends Error {
  override readonly name = 'PromptCancelledError'

  constructor() {
    super('Cancelled')
  }
}

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}

/** Colors are suppressed when output is redirected or NO_COLOR is set. */
function supportsColor(): boolean {
  return Boolean(stdout.isTTY) && !process.env['NO_COLOR']
}

function paint(text: string, color: keyof typeof colors): string {
  return supportsColor() ? `${colors[color]}${text}${colors.reset}` : text
}

export const style = {
  dim: (text: string): string => paint(text, 'dim'),
  bold: (text: string): string => paint(text, 'bold'),
  cyan: (text: string): string => paint(text, 'cyan'),
  green: (text: string): string => paint(text, 'green'),
  yellow: (text: string): string => paint(text, 'yellow'),
  red: (text: string): string => paint(text, 'red'),
}

export const symbols = {
  pass: paint('✓', 'green'),
  fail: paint('✗', 'red'),
  warn: paint('!', 'yellow'),
  info: paint('·', 'dim'),
  arrow: paint('→', 'cyan'),
}

function withInterface<T>(run: (rl: Interface) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: stdin, output: stdout })
  return run(rl).finally(() => { rl.close() })
}

/** Free-text input. Returns `defaultValue` when the user just presses Enter. */
export async function promptText(
  message: string,
  options: { defaultValue?: string; validate?: (value: string) => string | undefined } = {},
): Promise<string> {
  requireInteractive()
  const suffix = options.defaultValue ? style.dim(` (${options.defaultValue})`) : ''

  for (;;) {
    const answer = await withInterface((rl) => new Promise<string>((resolve, reject) => {
      rl.question(`${symbols.arrow} ${message}${suffix}: `, resolve)
      rl.once('close', () => { reject(new PromptCancelledError()) })
    }))

    const value = answer.trim() || options.defaultValue || ''
    const problem = options.validate?.(value)
    if (!problem) return value
    stdout.write(`  ${symbols.fail} ${problem}\n`)
  }
}

/**
 * Secret input with echo suppressed.
 *
 * readline has no built-in masking, so stdin is put in raw mode and keystrokes
 * are handled directly. Raw mode also disables the default Ctrl+C handling, so
 * that is translated into a cancellation explicitly.
 */
export async function promptSecret(
  message: string,
  options: { validate?: (value: string) => string | undefined } = {},
): Promise<string> {
  requireInteractive()

  for (;;) {
    const value = await readHidden(`${symbols.arrow} ${message}: `)
    const problem = options.validate?.(value)
    if (!problem) return value
    stdout.write(`  ${symbols.fail} ${problem}\n`)
  }
}

function readHidden(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    stdout.write(prompt)
    const wasRaw = stdin.isRaw === true
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''
    const cleanup = (): void => {
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdin.off('data', onData)
    }

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        switch (char) {
          case '\x03': // Ctrl+C
          case '\x04': // Ctrl+D
            cleanup()
            stdout.write('\n')
            reject(new PromptCancelledError())
            return
          case '\r':
          case '\n':
            cleanup()
            stdout.write('\n')
            resolve(value)
            return
          case '\x7f': // Backspace
          case '\b':
            if (value.length > 0) {
              value = value.slice(0, -1)
              stdout.write('\b \b')
            }
            break
          default:
            // Ignore other control characters (arrows, escape sequences).
            if (char >= ' ') {
              value += char
              stdout.write('*')
            }
        }
      }
    }

    stdin.on('data', onData)
  })
}

export type Choice<T> = { value: T; label: string; description?: string }

/**
 * Numbered single-select. A numbered list rather than arrow-key navigation
 * keeps this readable over ssh and in terminals with odd key handling.
 */
export async function promptSelect<T>(
  message: string,
  choices: Choice<T>[],
  options: { defaultIndex?: number } = {},
): Promise<T> {
  requireInteractive()
  if (choices.length === 0) throw new Error('promptSelect needs at least one choice')

  const defaultIndex = options.defaultIndex ?? 0
  stdout.write(`${symbols.arrow} ${style.bold(message)}\n`)
  choices.forEach((choice, index) => {
    const marker = index === defaultIndex ? style.cyan(`${index + 1})`) : `${index + 1})`
    const detail = choice.description ? style.dim(` — ${choice.description}`) : ''
    stdout.write(`  ${marker} ${choice.label}${detail}\n`)
  })

  const answer = await promptText('Choose', {
    defaultValue: String(defaultIndex + 1),
    validate: (value) => {
      const index = Number(value)
      return Number.isInteger(index) && index >= 1 && index <= choices.length
        ? undefined
        : `Enter a number from 1 to ${choices.length}`
    },
  })

  return choices[Number(answer) - 1]!.value
}

export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  requireInteractive()
  const answer = await promptText(`${message} ${style.dim(defaultValue ? '[Y/n]' : '[y/N]')}`, {
    defaultValue: defaultValue ? 'y' : 'n',
    validate: (value) => (/^[yn]/iu.test(value) ? undefined : 'Answer y or n'),
  })
  return /^y/iu.test(answer)
}

function requireInteractive(): void {
  if (!isInteractive()) {
    throw new Error('This command needs an interactive terminal')
  }
}
