import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeKiroStreamEvent, resolveKiroApiUrl, truncatePayload, validateToken } from '../src/kiro-api'
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
})

describe('runtime API errors', () => {
  it('keeps upstream error bodies out of the client-facing message', () => {
    const error = new RuntimeApiError(403, '{"message":"secret upstream detail"}')
    expect(error.message).toBe('Kiro runtime request failed with status 403')
    expect(error.upstreamBody).toContain('secret upstream detail')
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
