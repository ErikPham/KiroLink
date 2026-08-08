/**
 * Concurrency limiter for upstream calls.
 *
 * Previously module-level state (queue, active count, limits) shared across the
 * whole process, configured as a side effect of creating a server, and coupled
 * to the transport module for its debug logging. Now an instance with injected
 * config and logger.
 */

import type { ThrottleConfig } from '../config/config'
import type { Logger } from '../logging/logger'

/** Log a queue wait only when it is long enough to matter. */
const SLOW_WAIT_THRESHOLD_MS = 50

export type Throttle = {
  run<T>(fn: () => Promise<T>): Promise<T>
  /** Current in-flight and queued counts, for diagnostics. */
  stats(): { active: number; queued: number }
}

export function createThrottle(config: ThrottleConfig, logger: Logger): Throttle {
  const queue: (() => void)[] = []
  let active = 0

  const releaseNext = (): void => {
    // The delay applies after a slot frees, spacing successive upstream calls.
    setTimeout(() => {
      const next = queue.shift()
      if (next) next()
    }, config.delayMs)
  }

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const enqueuedAt = Date.now()
      return new Promise<T>((resolve, reject) => {
        const start = (): void => {
          const waitMs = Date.now() - enqueuedAt
          if (waitMs >= SLOW_WAIT_THRESHOLD_MS) {
            logger.log('debug', 'throttle queue wait', { wait_ms: waitMs, active, queued: queue.length })
          }
          active++
          fn().then(resolve, reject).finally(() => {
            active--
            releaseNext()
          })
        }
        if (active < config.maxConcurrent) start()
        else queue.push(start)
      })
    },
    stats() {
      return { active, queued: queue.length }
    },
  }
}
