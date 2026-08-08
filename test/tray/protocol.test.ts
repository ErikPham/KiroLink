/**
 * Tray helper protocol.
 */

import { describe, expect, it } from 'vitest'
import {
  createLineReader,
  decodeStatus,
  encodeNotify,
  encodeStatus,
  isTrayCommand,
  type TrayStatus,
} from '../../src/tray/protocol'

const status: TrayStatus = {
  running: true,
  baseUrl: 'http://127.0.0.1:4100',
  credits: '500 left',
  requests: 3,
  auth: 'api-key',
}

describe('encodeStatus / decodeStatus', () => {
  it('round-trips a status record', () => {
    const line = encodeStatus(status)
    expect(line.startsWith('status\t')).toBe(true)
    expect(line.endsWith('\n')).toBe(true)
    const decoded = decodeStatus(line.slice('status\t'.length).trimEnd())
    expect(decoded).toEqual(status)
  })

  it('returns null for malformed JSON', () => {
    expect(decodeStatus('not json')).toBeNull()
  })

  it('returns null when baseUrl is missing', () => {
    expect(decodeStatus(JSON.stringify({ running: true }))).toBeNull()
  })
})

describe('encodeNotify', () => {
  it('frames title and body as tab-separated fields', () => {
    expect(encodeNotify('Title', 'Body')).toBe('notify\tTitle\tBody\n')
  })

  it('strips tabs and newlines that would corrupt framing', () => {
    expect(encodeNotify('a\tb', 'c\nd\re')).toBe('notify\ta b\tc d e\n')
  })
})

describe('isTrayCommand', () => {
  it('accepts known commands', () => {
    for (const cmd of ['open', 'dashboard', 'copy', 'restart', 'stop', 'quit']) {
      expect(isTrayCommand(cmd)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isTrayCommand('launch')).toBe(false)
    expect(isTrayCommand('')).toBe(false)
  })
})

describe('createLineReader', () => {
  it('emits complete lines and buffers partial tails', () => {
    const lines: string[] = []
    const read = createLineReader((line) => lines.push(line))
    read('one\ntw')
    read('o\nthree\n')
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('skips blank lines', () => {
    const lines: string[] = []
    const read = createLineReader((line) => lines.push(line))
    read('\n\ncopy\n\n')
    expect(lines).toEqual(['copy'])
  })

  it('holds a line with no trailing newline until one arrives', () => {
    const lines: string[] = []
    const read = createLineReader((line) => lines.push(line))
    read('partial')
    expect(lines).toEqual([])
    read('\n')
    expect(lines).toEqual(['partial'])
  })
})
