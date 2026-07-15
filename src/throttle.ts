import { debug } from './kiro-api'

const queue: (() => void)[] = []
let active = 0
let maxConcurrent = 2
let delayMs = 200

export function configureThrottle(max: number, delay: number): void {
  maxConcurrent = max
  delayMs = delay
}

export function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const enqueuedAt = Date.now()
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      const waitMs = Date.now() - enqueuedAt
      if (waitMs >= 50) debug(`[throttle] queue_wait=${waitMs}ms active=${active} queued=${queue.length}`)
      active++
      fn().then(resolve, reject).finally(() => {
        active--
        setTimeout(() => { const next = queue.shift(); if (next) next() }, delayMs)
      })
    }
    if (active < maxConcurrent) run()
    else queue.push(run)
  })
}
