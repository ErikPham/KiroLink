/**
 * In-process request metrics.
 *
 * Feeds the dashboard, the status endpoint, and the tray from one source. Kept
 * bounded and instance-scoped: a proxy that runs for days must not accumulate
 * unbounded history, and two servers in one process must not share counters.
 */

/** Recent requests retained for the dashboard's activity list. */
const RECENT_LIMIT = 50

export type RequestOutcome = 'ok' | 'error' | 'aborted'

export type RequestRecord = {
  at: string
  method: string
  path: string
  model: string | undefined
  status: number | undefined
  outcome: RequestOutcome
  durationMs: number
  inputTokens: number | undefined
  outputTokens: number | undefined
  stream: boolean
}

export type MetricsSnapshot = {
  startedAt: string
  uptimeMs: number
  total: number
  ok: number
  errors: number
  aborted: number
  inFlight: number
  inputTokens: number
  outputTokens: number
  /** Newest first. */
  recent: RequestRecord[]
}

export type Metrics = {
  /** Mark a request as started; returns a function to complete it. */
  begin(request: { method: string; path: string }): RequestTracker
  snapshot(): MetricsSnapshot
}

export type RequestTracker = {
  setModel(model: string): void
  setStream(stream: boolean): void
  setTokens(input: number, output: number): void
  finish(outcome: RequestOutcome, status?: number): void
}

export function createMetrics(now: () => number = Date.now): Metrics {
  const startedAtMs = now()
  const startedAt = new Date(startedAtMs).toISOString()
  const recent: RequestRecord[] = []

  let total = 0
  let ok = 0
  let errors = 0
  let aborted = 0
  let inFlight = 0
  let inputTokens = 0
  let outputTokens = 0

  return {
    begin(request) {
      const at = now()
      inFlight++
      let model: string | undefined
      let stream = false
      let tokens: { input: number; output: number } | undefined
      let finished = false

      return {
        setModel(value) { model = value },
        setStream(value) { stream = value },
        setTokens(input, output) { tokens = { input, output } },
        finish(outcome, status) {
          // Guard against double-finish: the server's catch and finally paths can
          // both plausibly complete a request.
          if (finished) return
          finished = true
          inFlight--
          total++
          if (outcome === 'ok') ok++
          else if (outcome === 'aborted') aborted++
          else errors++

          if (tokens) {
            inputTokens += tokens.input
            outputTokens += tokens.output
          }

          recent.unshift({
            at: new Date(at).toISOString(),
            method: request.method,
            path: request.path,
            model,
            status,
            outcome,
            durationMs: now() - at,
            inputTokens: tokens?.input,
            outputTokens: tokens?.output,
            stream,
          })
          if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
        },
      }
    },

    snapshot() {
      return {
        startedAt,
        uptimeMs: now() - startedAtMs,
        total,
        ok,
        errors,
        aborted,
        inFlight,
        inputTokens,
        outputTokens,
        recent: [...recent],
      }
    },
  }
}
