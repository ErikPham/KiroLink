/**
 * Concurrency limiter.
 */

import { describe, expect, it } from 'vitest'
import { createThrottle } from '../../src/kiro/throttle'
import { silentLogger } from '../support/harness'

const throttleConfig = { maxConcurrent: 2, delayMs: 1 }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('createThrottle', () => {
  it('runs immediately when under the limit', async () => {
    const throttle = createThrottle(throttleConfig, silentLogger)
    await expect(throttle.run(() => Promise.resolve('done'))).resolves.toBe('done')
  })

  it('never exceeds maxConcurrent', async () => {
    const throttle = createThrottle({ maxConcurrent: 2, delayMs: 0 }, silentLogger)
    let active = 0
    let peak = 0

    const task = async (): Promise<void> => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      active--
    }

    await Promise.all(Array.from({ length: 6 }, () => throttle.run(task)))

    expect(peak).toBeLessThanOrEqual(2)
  })

  it('propagates a rejection without wedging the queue', async () => {
    const throttle = createThrottle(throttleConfig, silentLogger)

    await expect(throttle.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    // A failed task must still release its slot.
    await expect(throttle.run(() => Promise.resolve('ok'))).resolves.toBe('ok')
  })

  it('reports active and queued counts', async () => {
    const throttle = createThrottle({ maxConcurrent: 1, delayMs: 0 }, silentLogger)
    const first = deferred<void>()

    const running = throttle.run(() => first.promise)
    const queued = throttle.run(() => Promise.resolve())

    expect(throttle.stats()).toEqual({ active: 1, queued: 1 })

    first.resolve()
    await Promise.all([running, queued])
    expect(throttle.stats().active).toBe(0)
  })

  it('keeps instances independent', async () => {
    const a = createThrottle({ maxConcurrent: 1, delayMs: 0 }, silentLogger)
    const b = createThrottle({ maxConcurrent: 1, delayMs: 0 }, silentLogger)
    const blocker = deferred<void>()

    const running = a.run(() => blocker.promise)
    // b has its own queue, so it is unaffected by a's saturation.
    await expect(b.run(() => Promise.resolve('independent'))).resolves.toBe('independent')

    blocker.resolve()
    await running
  })
})
