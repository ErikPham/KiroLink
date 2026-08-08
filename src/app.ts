/**
 * Composition root.
 *
 * The one place where concrete implementations are chosen and wired. Everything
 * below this layer receives its dependencies as parameters, which is what makes
 * the stack testable and lets a second instance exist in one process.
 */

import type { Server } from 'node:http'
import type { KiroLinkConfig } from './config/config'
import { createKiroProxyServer, type ServerDeps } from './http/server'
import { createAuthProvider, type AuthProvider } from './kiro/auth'
import type { KiroClient } from './kiro/client'
import { createHttpKiroClient } from './kiro/http-client'
import { createThrottle, type Throttle } from './kiro/throttle'
import { createUsageService, type UsageService } from './kiro/usage'
import { createLogger, type Logger } from './logging/logger'
import { createMetrics, type Metrics } from './observability/metrics'

export type KiroLinkOverrides = {
  logger?: Logger
  auth?: AuthProvider
  client?: KiroClient
  throttle?: Throttle
  usage?: UsageService
  metrics?: Metrics
  /** Reported by /v1/status and the dashboard. */
  version?: string
}

export type KiroLinkApp = {
  server: Server
  config: KiroLinkConfig
  logger: Logger
  usage: UsageService
  metrics: Metrics
}

/** Build the full application graph, allowing any part to be replaced. */
export function createKiroLink(config: KiroLinkConfig, overrides: KiroLinkOverrides = {}): KiroLinkApp {
  const logger = overrides.logger ?? createLogger({
    verbose: config.diagnostics.verbose,
    quiet: config.diagnostics.quiet,
    json: config.diagnostics.json,
  })

  const auth = overrides.auth ?? createAuthProvider(config.upstream, logger)
  const client = overrides.client ?? createHttpKiroClient({
    upstream: config.upstream,
    identity: config.identity,
    diagnostics: config.diagnostics,
    auth,
    logger,
  })
  const throttle = overrides.throttle ?? createThrottle(config.throttle, logger)
  const usage = overrides.usage ?? createUsageService({
    upstream: config.upstream,
    identity: config.identity,
    auth,
    logger,
  })
  const metrics = overrides.metrics ?? createMetrics()

  const deps: ServerDeps = {
    config,
    client,
    throttle,
    usage,
    logger,
    metrics,
    version: overrides.version ?? '0.0.0',
  }
  return { server: createKiroProxyServer(deps), config, logger, usage, metrics }
}
