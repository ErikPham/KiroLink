import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeKiroStreamEvent, normalizeToolInputForClient, repairKiroToolResultPairing, requestTimeoutMs, resolveKiroApiUrl, resolveTokenPath, truncatePayload, validateToken } from '../src/kiro-api'
import { RuntimeApiError } from '../src/errors'

const MAX_PAYLOAD_BYTES = 900 * 1024

describe('event stream parsing', () => {
  it('builds correct AWS event stream header', () => {
    // Verify our understanding of the binary format
    // Header: nameLen(1) + name + valueType(1) + valueLen(2) + value
    const name = ':event-type'
    const value = 'assistantResponseEvent'
    const buf = Buffer.alloc(1 + name.length + 1 + 2 + value.length)
    let offset = 0
    buf[offset++] = name.length
    buf.write(name, offset); offset += name.length
    buf[offset++] = 7 // string type
    buf.writeUInt16BE(value.length, offset); offset += 2
    buf.write(value, offset)

    // Parse it back
    const nameLen = buf[0]!
    const parsedName = buf.subarray(1, 1 + nameLen).toString()
    expect(parsedName).toBe(':event-type')
    const vt = buf[1 + nameLen]!
    expect(vt).toBe(7)
    const vl = buf.readUInt16BE(1 + nameLen + 1)
    const parsedValue = buf.subarray(1 + nameLen + 1 + 2, 1 + nameLen + 1 + 2 + vl).toString()
    expect(parsedValue).toBe('assistantResponseEvent')
  })
})

describe('payload truncation', () => {
  it('should keep payload under 900KB', () => {
    // Create a large history that exceeds limit
    const bigContent = 'x'.repeat(100_000)
    const history = Array.from({ length: 20 }, (_, i) => ({
      [i % 2 === 0 ? 'userInputMessage' : 'assistantResponseMessage']:
        i % 2 === 0
          ? { content: bigContent, origin: 'AI_EDITOR', images: [] }
          : { content: bigContent, toolUses: [] }
    }))

    const payload = {
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test',
        currentMessage: { userInputMessage: { content: 'hi', modelId: 'claude-sonnet-4.6', origin: 'AI_EDITOR' } },
        history,
      },
      profileArn: 'arn:test',
    }

    truncatePayload(payload)
    const size = Buffer.byteLength(JSON.stringify(payload))

    expect(payload.conversationState.history.length).toBeLessThanOrEqual(20)
    expect(payload.conversationState.history.length).toBeGreaterThanOrEqual(4)
    if (payload.conversationState.history.length > 4) {
      expect(size).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    }
  })

  it('truncates oversized current tool results after history pruning', () => {
    const payload = {
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test',
        currentMessage: {
          userInputMessage: {
            content: 'continue',
            modelId: 'claude-sonnet-4.6',
            origin: 'AI_EDITOR',
            userInputMessageContext: {
              toolResults: [{
                toolUseId: 'tooluse_big',
                content: [{ text: 'x'.repeat(1_000_000) }],
                status: 'success',
              }],
            },
          },
        },
        history: [],
      },
      profileArn: 'arn:test',
    }

    truncatePayload(payload)

    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    const text = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0]!.content[0]!.text
    expect(text).toContain('[truncated]')
  })

  it('keeps the required first tool result when truncating history', () => {
    const bigContent = 'x'.repeat(100_000)
    const payload = {
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test',
        currentMessage: { userInputMessage: { content: 'continue', modelId: 'claude-sonnet-4.6', origin: 'AI_EDITOR', userInputMessageContext: {} } },
        history: [
          { userInputMessage: { content: 'start', origin: 'AI_EDITOR', userInputMessageContext: {} } },
          { assistantResponseMessage: { content: '', toolUses: [{ toolUseId: 'first_tool', name: 'ask_user', input: {} }] } },
          { userInputMessage: { content: 'done', origin: 'AI_EDITOR', userInputMessageContext: { toolResults: [{ toolUseId: 'first_tool', content: [{ text: 'ok' }], status: 'success' }] } } },
          ...Array.from({ length: 30 }, (_, i) => ({
            [i % 2 === 0 ? 'assistantResponseMessage' : 'userInputMessage']: i % 2 === 0
              ? { content: bigContent, toolUses: [] }
              : { content: bigContent, origin: 'AI_EDITOR', userInputMessageContext: {} },
          })),
        ],
      },
      profileArn: 'arn:test',
    }

    truncatePayload(payload)
    const repairs = repairKiroToolResultPairing(payload)

    expect(repairs).toEqual({ addedMissingResults: 0, removedOrphanResults: 0 })
    expect(payload.conversationState.history[2]!.userInputMessage.userInputMessageContext.toolResults).toEqual([
      { toolUseId: 'first_tool', content: [{ text: 'ok' }], status: 'success' },
    ])
  })
})

describe('runtime request timeout', () => {
  const savedTimeout = process.env['KIRO_PROXY_REQUEST_TIMEOUT_MS']
  beforeEach(() => { delete process.env['KIRO_PROXY_REQUEST_TIMEOUT_MS'] })
  afterEach(() => {
    if (savedTimeout === undefined) delete process.env['KIRO_PROXY_REQUEST_TIMEOUT_MS']
    else process.env['KIRO_PROXY_REQUEST_TIMEOUT_MS'] = savedTimeout
  })

  it('defaults to a 10-minute runtime timeout', () => {
    expect(requestTimeoutMs()).toBe(10 * 60_000)
  })

  it('honors KIRO_PROXY_REQUEST_TIMEOUT_MS when valid', () => {
    process.env['KIRO_PROXY_REQUEST_TIMEOUT_MS'] = '90000'
    expect(requestTimeoutMs()).toBe(90_000)
  })

  it('ignores invalid timeout overrides below 30s', () => {
    process.env['KIRO_PROXY_REQUEST_TIMEOUT_MS'] = '15000'
    expect(requestTimeoutMs()).toBe(10 * 60_000)
  })
})

describe('client tool input compatibility', () => {
  it('normalizes Kiro-style question choices into Claude Code AskUserQuestion input', () => {
    const input = normalizeToolInputForClient('AskUserQuestion', {
      question: 'Pick an approach',
      choices: ['Fast path', { label: 'Safe path', description: 'More validation' }],
    })

    expect(input).toEqual({
      questions: [{
        question: 'Pick an approach?',
        header: 'Pick an appr',
        id: 'pick_an_approach',
        options: [
          { label: 'Fast path', description: 'Fast path' },
          { label: 'Safe path', description: 'More validation' },
        ],
        multiSelect: false,
      }],
    })
  })

  it('normalizes questions arrays that use choices instead of options', () => {
    const input = normalizeToolInputForClient('ask_user_question', {
      questions: [{
        question: 'Which one?',
        header: 'Choice',
        choices: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
      }],
    })

    expect(input).toEqual({
      questions: [{
        question: 'Which one?',
        header: 'Choice',
        id: 'which_one',
        options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
        multiSelect: false,
      }],
    })
  })

  it('preserves explicit question ids for Claude Code question tools', () => {
    const input = normalizeToolInputForClient('ask_user_question', {
      questions: [{
        question: 'Please choose an option?',
        id: 'lcp_slide_choice',
        choices: ['Đào LCP slide #5', 'Bỏ qua'],
      }],
    })

    expect(input).toEqual({
      questions: [{
        id: 'lcp_slide_choice',
        question: 'Please choose an option?',
        header: 'Please choos',
        options: [
          { label: 'Đào LCP slide #5', description: 'Đào LCP slide #5' },
          { label: 'Bỏ qua', description: 'Bỏ qua' },
        ],
        multiSelect: false,
      }],
    })
  })
})

describe('runtime tool result pairing repair', () => {
  it('adds missing results to the immediate following user turn', () => {
    const payload = {
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test',
        history: [
          { assistantResponseMessage: { content: '', toolUses: [{ toolUseId: 'old_tool', name: 'ask_user', input: {} }] } },
          { userInputMessage: { content: 'continue', userInputMessageContext: {}, origin: 'AI_EDITOR', modelId: 'claude-sonnet-4.6' } },
          { assistantResponseMessage: { content: '', toolUses: [{ toolUseId: 'current_tool', name: 'ask_user', input: {} }] } },
        ],
        currentMessage: {
          userInputMessage: {
            content: 'done',
            origin: 'AI_EDITOR',
            modelId: 'claude-sonnet-4.6',
            userInputMessageContext: {
              toolResults: [{ toolUseId: 'current_tool', content: [{ text: 'ok' }], status: 'success' }],
            },
          },
        },
      },
      profileArn: 'arn:test',
    }

    const repairs = repairKiroToolResultPairing(payload)

    expect(repairs).toEqual({ addedMissingResults: 1, removedOrphanResults: 0 })
    const repairedUser = payload.conversationState.history[1]!.userInputMessage.userInputMessageContext.toolResults
    expect(repairedUser).toEqual([{ toolUseId: 'old_tool', content: [{ text: 'Tool use was interrupted before a result was returned.' }], status: 'error' }])
    const currentResults = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults
    expect(currentResults).toEqual([{ toolUseId: 'current_tool', content: [{ text: 'ok' }], status: 'success' }])
  })

  it('removes current tool results that do not belong to the previous assistant turn', () => {
    const payload = {
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test',
        history: [
          { assistantResponseMessage: { content: '', toolUses: [{ toolUseId: 'expected_tool', name: 'ask_user', input: {} }] } },
        ],
        currentMessage: {
          userInputMessage: {
            content: 'done',
            origin: 'AI_EDITOR',
            modelId: 'claude-sonnet-4.6',
            userInputMessageContext: {
              toolResults: [
                { toolUseId: 'stale_tool', content: [{ text: 'stale' }], status: 'success' },
                { toolUseId: 'expected_tool', content: [{ text: 'ok' }], status: 'success' },
              ],
            },
          },
        },
      },
      profileArn: 'arn:test',
    }

    const repairs = repairKiroToolResultPairing(payload)

    expect(repairs).toEqual({ addedMissingResults: 0, removedOrphanResults: 1 })
    expect(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
      { toolUseId: 'expected_tool', content: [{ text: 'ok' }], status: 'success' },
    ])
  })
})

describe('runtime API URL safety', () => {
  it('allows known Kiro runtime hosts', () => {
    const prev = process.env['KIRO_PROXY_API_URL']
    try {
      process.env['KIRO_PROXY_API_URL'] = 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse'
      expect(resolveKiroApiUrl().hostname).toBe('runtime.us-east-1.kiro.dev')
    } finally {
      if (prev === undefined) delete process.env['KIRO_PROXY_API_URL']
      else process.env['KIRO_PROXY_API_URL'] = prev
    }
  })

  it('rejects non-https and untrusted runtime hosts', () => {
    const prev = process.env['KIRO_PROXY_API_URL']
    const prevAllow = process.env['KIRO_PROXY_ALLOW_UNTRUSTED_API_URL']
    try {
      delete process.env['KIRO_PROXY_ALLOW_UNTRUSTED_API_URL']
      process.env['KIRO_PROXY_API_URL'] = 'http://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse'
      expect(() => resolveKiroApiUrl()).toThrow('must use https')

      process.env['KIRO_PROXY_API_URL'] = 'https://example.com/generateAssistantResponse'
      expect(() => resolveKiroApiUrl()).toThrow('untrusted API host')

      process.env['KIRO_PROXY_API_URL'] = 'https://token@example.com/generateAssistantResponse'
      expect(() => resolveKiroApiUrl()).toThrow('must not contain credentials')

      process.env['KIRO_PROXY_API_URL'] = 'https://codewhisperer.us-east-1.amazonaws.com/not-the-runtime'
      expect(() => resolveKiroApiUrl()).toThrow('path must be / or /generateAssistantResponse')

      process.env['KIRO_PROXY_API_URL'] = 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse?x=1'
      expect(() => resolveKiroApiUrl()).toThrow('must not include query or fragment')
    } finally {
      if (prev === undefined) delete process.env['KIRO_PROXY_API_URL']
      else process.env['KIRO_PROXY_API_URL'] = prev
      if (prevAllow === undefined) delete process.env['KIRO_PROXY_ALLOW_UNTRUSTED_API_URL']
      else process.env['KIRO_PROXY_ALLOW_UNTRUSTED_API_URL'] = prevAllow
    }
  })
})

describe('token validation', () => {
  it('accepts the expected Kiro token shape', () => {
    expect(() => validateToken({ accessToken: 'x'.repeat(32), refreshToken: 'refresh', expiresAt: new Date(Date.now() + 60_000).toISOString(), profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example' })).not.toThrow()
  })

  it('rejects malformed Kiro token files before making runtime calls', () => {
    expect(() => validateToken({ accessToken: '', refreshToken: '', expiresAt: 'bad', profileArn: '' })).toThrow('accessToken')
    expect(() => validateToken({ accessToken: 'x'.repeat(32), refreshToken: '', expiresAt: 'bad', profileArn: 'arn:x' })).toThrow('expiresAt')
    expect(() => validateToken({ accessToken: 'x'.repeat(32), refreshToken: '', expiresAt: new Date().toISOString(), profileArn: 'not-an-arn' })).toThrow('profileArn')
  })

  it('falls back to kiro-auth-token.json when the legacy cli filename is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kirolink-token-'))
    try {
      writeFileSync(join(dir, 'kiro-auth-token.json'), JSON.stringify({
        accessToken: 'x'.repeat(32),
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example',
      }))
      await expect(resolveTokenPath(dir, undefined)).resolves.toBe(join(dir, 'kiro-auth-token.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discovers a valid token file by schema when filenames drift again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kirolink-token-'))
    try {
      writeFileSync(join(dir, 'random-sso-cache.json'), JSON.stringify({ startUrl: 'https://example.com/start' }))
      writeFileSync(join(dir, 'future-kiro-token.json'), JSON.stringify({
        accessToken: 'y'.repeat(32),
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example',
      }))
      await expect(resolveTokenPath(dir, undefined)).resolves.toBe(join(dir, 'future-kiro-token.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers the freshest valid token file over legacy filenames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kirolink-token-'))
    try {
      writeFileSync(join(dir, 'kiro-auth-token-cli.json'), JSON.stringify({
        accessToken: 'x'.repeat(32),
        refreshToken: 'refresh',
        expiresAt: '2026-01-01T00:00:00.000Z',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example',
      }))
      writeFileSync(join(dir, 'kiro-auth-token.json'), JSON.stringify({
        accessToken: 'y'.repeat(32),
        refreshToken: 'refresh',
        expiresAt: '2026-06-01T00:00:00.000Z',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example',
      }))
      await expect(resolveTokenPath(dir, undefined)).resolves.toBe(join(dir, 'kiro-auth-token.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runtime API errors', () => {
  it('keeps upstream error bodies out of the client-facing message', () => {
    const error = new RuntimeApiError(403, '{"message":"secret upstream detail"}')
    expect(error.message).toBe('Kiro runtime request failed with status 403')
    expect(error.upstreamBody).toContain('secret upstream detail')
  })

  it('can expose summarized upstream errors for local debugging', () => {
    const prev = process.env['KIRO_PROXY_EXPOSE_UPSTREAM_ERRORS']
    try {
      process.env['KIRO_PROXY_EXPOSE_UPSTREAM_ERRORS'] = '1'
      const error = new RuntimeApiError(400, '{"__type":"ValidationException","message":"invalid tool schema"}')
      expect(error.message).toBe('Kiro runtime request failed with status 400: ValidationException invalid tool schema')
    } finally {
      if (prev === undefined) delete process.env['KIRO_PROXY_EXPOSE_UPSTREAM_ERRORS']
      else process.env['KIRO_PROXY_EXPOSE_UPSTREAM_ERRORS'] = prev
    }
  })
})

describe('Kiro CLI stream shape compatibility', () => {
  it('normalizes recorded Kiro CLI stream event wrappers', () => {
    const normalized = normalizeKiroStreamEvent('', { kind: 'AssistantResponseEvent', data: { content: 'OK' } })
    expect(normalized).toEqual({ eventType: 'assistantResponseEvent', event: { content: 'OK' } })
  })

  it('normalizes Kiro CLI event names to the event-stream names used by the parser', () => {
    expect(normalizeKiroStreamEvent('ReasoningEvent', { text: 'thinking' }).eventType).toBe('reasoningContentEvent')
    expect(normalizeKiroStreamEvent('ToolUseEvent', { tool_use_id: 'tu_1' }).eventType).toBe('toolUseEvent')
  })

  it('normalizes response events captured from Kiro CLI runtime recording', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/kiro-cli-runtime-recording.json', import.meta.url), 'utf8')) as {
      responses: Record<string, unknown>[]
    }
    const eventTypes = fixture.responses.map((event) => normalizeKiroStreamEvent('', event).eventType)
    expect(eventTypes).toEqual(['assistantResponseEvent', 'contextUsageEvent', 'meteringEvent'])
  })
})

describe('model mapping edge cases', () => {
  // Import from translator
  it('handles models correctly via anthropicToKiro', async () => {
    const { anthropicToKiro } = await import('../src/translator')

    // Verify various model mappings
    const cases = [
      { input: 'claude-opus-4-8[1m]', expected: 'claude-opus-4.8' },
      { input: 'claude-sonnet-4-6', expected: 'claude-sonnet-4.6' },
      { input: 'claude-sonnet-4-20250514', expected: 'claude-sonnet-4' },
      { input: 'claude-haiku-4.5', expected: 'claude-haiku-4.5' },
      { input: 'claude-opus-4', expected: 'claude-opus-4' },
    ]

    for (const { input, expected } of cases) {
      const p = anthropicToKiro({ model: input, messages: [{ role: 'user', content: 'x' }] })
      const msg = p.conversationState.currentMessage.userInputMessage as Record<string, unknown>
      expect(msg['modelId']).toBe(expected)
    }
  })
})
