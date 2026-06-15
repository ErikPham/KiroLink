import { describe, it, expect, beforeEach } from 'vitest'
import { configureThrottle, throttled } from '../src/throttle'

beforeEach(() => configureThrottle(2, 50))

describe('throttle', () => {
  it('executes immediately when under limit', async () => {
    const result = await throttled(() => Promise.resolve(42))
    expect(result).toBe(42)
  })

  it('limits concurrency', async () => {
    configureThrottle(1, 10)
    let concurrent = 0
    let maxConcurrent = 0
    const task = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(30)
      concurrent--
    }
    // Call sequentially to ensure throttle has time to register
    const a = throttled(task)
    await sleep(5)
    const b = throttled(task)
    await Promise.all([a, b])
    expect(maxConcurrent).toBe(1)
  })

  it('propagates errors', async () => {
    await expect(throttled(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail')
  })
})

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
