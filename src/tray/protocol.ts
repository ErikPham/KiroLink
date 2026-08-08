/**
 * Tray helper protocol.
 *
 * The native helper is a separate process. Node writes status lines to its stdin
 * and reads command lines from its stdout — plain tab-separated text, one record
 * per line, because that is the lowest common denominator across Swift,
 * PowerShell, Python, and shell helpers.
 *
 * Node → helper:  status\t<json>
 *                 notify\t<title>\t<body>
 * helper → Node:  open | dashboard | copy | restart | stop | quit
 */

/** Commands a helper may send. Anything else is ignored. */
export const TRAY_COMMANDS = ['open', 'dashboard', 'copy', 'restart', 'stop', 'quit'] as const
export type TrayCommand = typeof TRAY_COMMANDS[number]

/** What the menu displays. Kept small: it is serialized on every refresh. */
export type TrayStatus = {
  running: boolean
  baseUrl: string
  /** Pre-formatted for display, since the helper does no formatting. */
  credits: string
  requests: number
  auth: string
}

export function isTrayCommand(value: string): value is TrayCommand {
  return (TRAY_COMMANDS as readonly string[]).includes(value)
}

export function encodeStatus(status: TrayStatus): string {
  return `status\t${JSON.stringify(status)}\n`
}

export function encodeNotify(title: string, body: string): string {
  // Tabs and newlines would corrupt the line framing.
  return `notify\t${sanitize(title)}\t${sanitize(body)}\n`
}

export function decodeStatus(payload: string): TrayStatus | null {
  try {
    const parsed = JSON.parse(payload) as TrayStatus
    return typeof parsed.baseUrl === 'string' ? parsed : null
  } catch {
    return null
  }
}

function sanitize(value: string): string {
  return value.replace(/[\t\r\n]+/gu, ' ').trim()
}

/**
 * Split a stream of bytes into complete lines, buffering any partial tail.
 * Returns a stateful reader because chunk boundaries do not align with lines.
 */
export function createLineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
      index = buffer.indexOf('\n')
    }
  }
}
