/**
 * HTTP server.
 *
 * Dependencies are injected rather than imported as module bindings, so the whole
 * chat path — SSE framing, error mapping, abort propagation, context-overflow
 * translation — is reachable from a test with a fake KiroClient. Creating a
 * server no longer mutates process-global state.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { KiroLinkConfig } from '../config/config'
import { assertSafeBind } from '../config/config'
import { listModels } from '../domain/models'
import type { KiroStreamEvent } from '../domain/types'
import {
  AuthenticationError,
  InvalidRequestError,
  KiroLinkError,
  NotFoundError,
  RequestAbortedError,
  RuntimeApiError,
  isContextWindowOverflow,
} from '../errors'
import type { KiroClient } from '../kiro/client'
import type { Throttle } from '../kiro/throttle'
import type { UsageService } from '../kiro/usage'
import { formatUsageLine } from '../kiro/usage'
import type { Logger } from '../logging/logger'
import { renderDashboard } from '../observability/dashboard'
import type { Metrics } from '../observability/metrics'
import { createMetrics } from '../observability/metrics'
import { buildStatusPayload } from '../observability/status'
import type { ProtocolAdapter } from '../protocol/adapter'
import { createAdapters } from '../protocol/registry'
import { isAuthorized, setCorsHeaders } from './auth'
import { drainBody, readJsonBody } from './body'
import { writeJson } from './response'
import { createRouter, isRouteMatch, type Route, type RouteContext } from './router'

/** Rough characters-per-token ratio used by the count_tokens estimate. */
const CHARS_PER_TOKEN = 4

/** Inline favicon: a link glyph, tinted to match the dashboard accent. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2.2" stroke-linecap="round"><path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 12.8 4.7a4.2 4.2 0 0 1 6 6L17 12.5"/><path d="M13 17.5l-1.8 1.8a4.2 4.2 0 0 1-6-6L7 11.5"/></svg>`

export type ServerDeps = {
  config: KiroLinkConfig
  client: KiroClient
  throttle: Throttle
  usage: UsageService
  logger: Logger
  /** Shared with the dashboard, /v1/status, and the tray. Created if omitted. */
  metrics?: Metrics
  /** Reported by /v1/status; the CLI supplies the package version. */
  version?: string
}

export function createKiroProxyServer(deps: ServerDeps): Server {
  assertSafeBind(deps.config.server)
  const resolved: ResolvedDeps = {
    ...deps,
    metrics: deps.metrics ?? createMetrics(),
    version: deps.version ?? '0.0.0',
  }

  // The bound port is read from the server itself rather than passed in: port
  // fallback can change it after listen(), and a caller-supplied value would go
  // stale without anyone noticing.
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, router, resolved)
  })
  const router = createRouter(buildRoutes(resolved, () => boundPort(server, deps.config.server.port)))
  return server
}

/** The port actually listening, falling back to the configured one before listen(). */
function boundPort(server: Server, configuredPort: number): number {
  const address = server.address()
  return address !== null && typeof address === 'object' ? address.port : configuredPort
}

type ResolvedDeps = ServerDeps & {
  metrics: Metrics
  version: string
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  router: ReturnType<typeof createRouter>,
  deps: ServerDeps,
): Promise<void> {
  const { config, logger } = deps
  const url = req.url ?? ''
  const method = req.method ?? 'GET'
  logger.log('info', `${method} ${url.split('?')[0] ?? ''}`)

  setCorsHeaders(req, res, config.server.host)
  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    const match = router.match(method, url)
    if (!isRouteMatch(match)) {
      // A known path with the wrong method is a 405, which tells a client
      // something different than "this endpoint does not exist".
      throw match.pathExists ? new MethodNotAllowedError() : new NotFoundError()
    }

    const { route, query } = match
    if (!route.public && config.server.apiKey && !isAuthorized(req, config.server.apiKey)) {
      throw new AuthenticationError()
    }

    await route.handler({ req, res, query })
  } catch (error) {
    respondWithError(res, error, logger)
  }
}

/** 405 lives here rather than errors.ts because it is purely a routing concern. */
class MethodNotAllowedError extends KiroLinkError {
  override readonly name = 'MethodNotAllowedError'
  override readonly status = 405
  override readonly apiErrorType = 'invalid_request_error' as const

  constructor() {
    super('Method not allowed')
  }
}

function buildRoutes(deps: ResolvedDeps, resolvePort: () => number): Route[] {
  const { config, usage, metrics, version } = deps
  const adapters = createAdapters(config)

  /**
   * The dashboard polls this every couple of seconds, so credits come from the
   * usage cache rather than a forced lookup — otherwise an open dashboard would
   * hammer the quota endpoint.
   */
  const statusPayload = async (): Promise<unknown> => {
    const credits = await usage.fetch().catch(() => undefined)
    return buildStatusPayload({
      config,
      port: resolvePort(),
      version,
      metrics: metrics.snapshot(),
      credits,
    })
  }

  return [
    { method: 'HEAD', path: '/', public: true, handler: ({ res }) => { res.writeHead(200); res.end() } },
    { method: 'GET', path: '/health', public: true, handler: ({ res }) => { writeJson(res, 200, { ok: true }) } },

    // The dashboard is a local operator UI, so it stays reachable without the
    // client API key — the key protects the inference endpoints.
    {
      method: 'GET',
      path: '/',
      public: true,
      handler: ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderDashboard())
      },
    },
    {
      method: 'GET',
      path: '/v1/status',
      public: true,
      handler: async ({ res }) => { writeJson(res, 200, await statusPayload()) },
    },
    // Browsers request this unprompted when the dashboard loads; serving it
    // keeps a 404 out of the console and the request log.
    {
      method: 'GET',
      path: '/favicon.svg',
      public: true,
      handler: ({ res }) => {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' })
        res.end(FAVICON_SVG)
      },
    },
    { method: 'GET', path: '/favicon.ico', public: true, handler: ({ res }) => { res.writeHead(204); res.end() } },

    { method: 'GET', path: '/v1/models', handler: ({ res }) => { writeJson(res, 200, listModels()) } },

    // Telemetry endpoints clients call unprompted; accept and discard so a
    // failed POST does not surface as an error in the client UI.
    ...['/api/event_logging/batch', '/api/event_logging/v2/batch'].map((path): Route => ({
      method: 'POST',
      path,
      handler: async ({ req, res }) => {
        await drainBody(req, config.server.maxBodyBytes)
        writeJson(res, 200, { status: 'ok' })
      },
    })),

    ...['/v1/usage', '/credits'].map((path): Route => ({
      method: 'GET',
      path,
      handler: async ({ res, query }) => {
        const force = query.get('refresh') === '1' || query.get('force') === '1'
        const summary = await usage.fetch({ force })
        writeJson(res, summary.ok ? 200 : 502, summary)
      },
    })),

    {
      method: 'POST',
      path: '/v1/messages/count_tokens',
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req, config.server.maxBodyBytes)
        // Kiro exposes no tokenizer, so this is a length heuristic. Clients use
        // it for context budgeting, so it is deliberately a slight over-estimate
        // rather than an under-estimate.
        const estimate = Math.max(1, Math.ceil(JSON.stringify(body).length / CHARS_PER_TOKEN))
        writeJson(res, 200, { input_tokens: estimate })
      },
    },

    {
      method: 'POST',
      path: '/v1/messages',
      handler: (context) => handleChat(context, adapters.anthropic, deps),
    },
    {
      method: 'POST',
      path: '/v1/chat/completions',
      handler: (context) => handleChat(context, adapters.openai, deps),
    },
  ]
}

/**
 * The single chat pipeline, shared by every protocol.
 *
 * Previously each protocol had its own handler containing a streaming branch and
 * a buffered branch, giving four copies of the same event loop. The adapter now
 * supplies the writer and the pump is protocol-agnostic.
 */
async function handleChat<TRequest>(
  context: RouteContext,
  adapter: ProtocolAdapter<TRequest>,
  deps: ResolvedDeps,
): Promise<void> {
  const { config, client, throttle, usage, logger, metrics } = deps
  const { req, res } = context

  const tracker = metrics.begin({ method: req.method ?? 'POST', path: req.url?.split('?')[0] ?? '' })

  try {
    if (config.credits.required) await assertCreditsAvailable(usage, logger)

    const body = await readJsonBody(req, config.server.maxBodyBytes)
    const request = adapter.parseRequest(body)
    logger.log('info', `  → ${adapter.describeRequest(request)}`)

    const described = adapter.metricsFor(request)
    tracker.setModel(described.model)
    tracker.setStream(described.stream)

    const kiroRequest = adapter.toKiroRequest(request)
    const writer = adapter.createWriter(res, request)

    const controller = new AbortController()
    const onClose = (): void => { controller.abort() }
    req.on('close', onClose)

    let writerStarted = false
    const beginWriter = (): void => {
      if (writerStarted) return
      writer.begin()
      writerStarted = true
    }

    try {
      const onEvent = (event: KiroStreamEvent): void => {
        // Do not commit an SSE 200 until the runtime has accepted the request.
        // A rejection before its first event can then retain its HTTP status and
        // the canonical context-overflow body that clients use to compact.
        beginWriter()
        if (event.type === 'done') tracker.setTokens(event.inputTokens, event.outputTokens)
        writer.handle(event)
      }
      await throttle.run(() => client.send(kiroRequest, onEvent, controller.signal))
      beginWriter()
      writer.complete()
      await writer.finish()
      if (!res.writableEnded) res.end()
      tracker.finish('ok', 200)
      logger.log('info', '  ✓ done')
    } catch (error) {
      if (error instanceof RequestAbortedError || controller.signal.aborted) {
        logger.log('info', '  · client disconnected')
        if (!res.writableEnded) res.end()
        tracker.finish('aborted')
        return
      }
      // Headers are already sent for a streaming writer, so the error must travel
      // inside the open stream; a buffered writer has sent nothing, so the error
      // propagates and the server renders a normal error response.
      if (res.headersSent) {
        logger.log('warn', `  ✗ ${describeError(error)}`)
        writer.fail(error)
        await writer.finish()
        if (!res.writableEnded) res.end()
        tracker.finish('error', 200)
        return
      }
      // A context-window overflow must reach the client in the exact shape its own
      // reactive compaction recognizes, which is protocol-specific.
      if (error instanceof RuntimeApiError && isContextWindowOverflow(error)) {
        logger.log('warn', '  ✗ context window exceeded')
        writeJson(res, 400, adapter.contextWindowErrorBody())
        tracker.finish('error', 400)
        return
      }
      throw error
    } finally {
      req.off('close', onClose)
    }
  } catch (error) {
    // Validation and credit failures land here; the status comes from the error.
    tracker.finish('error', error instanceof KiroLinkError ? error.status : 500)
    throw error
  }
}

async function assertCreditsAvailable(usage: UsageService, logger: Logger): Promise<void> {
  const summary = await usage.fetch()
  if (!summary.ok) {
    // A failed credit check must not block serving: the proxy would become
    // unusable whenever the quota endpoint is down.
    logger.log('warn', `credit check failed: ${summary.error} (allowing request)`)
    return
  }
  if (!summary.exhausted) return
  throw new InvalidRequestError(
    `Kiro credits exhausted (${formatUsageLine(summary)}). Wait for reset${summary.nextResetDate ? ` on ${summary.nextResetDate}` : ''} or disable KIROLINK_REQUIRE_CREDITS.`,
  )
}

function respondWithError(res: ServerResponse, error: unknown, logger: Logger): void {
  if (error instanceof RequestAbortedError) {
    if (!res.writableEnded) res.end()
    return
  }

  logger.log('warn', `  ✗ ${describeError(error)}`)

  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }

  const { status, type, message, headers } = classifyError(error)
  writeJson(res, status, { error: { type, message } }, headers)
}

function classifyError(error: unknown): {
  status: number
  type: string
  message: string
  headers: Record<string, string> | undefined
} {
  if (error instanceof KiroLinkError) {
    return {
      status: error.status,
      type: error.apiErrorType,
      message: error.message,
      headers: error.retryAfterSeconds === undefined ? undefined : { 'Retry-After': String(error.retryAfterSeconds) },
    }
  }
  // An unexpected error is a bug in KiroLink, not a client mistake, so it is a
  // 500 with a generic message rather than leaking internal detail.
  return { status: 500, type: 'api_error', message: describeError(error), headers: undefined }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
