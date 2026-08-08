/**
 * Status payload shared by the dashboard, the `/v1/status` endpoint, and the
 * tray helper. One shape so the three never disagree about what "running" means.
 */

import type { KiroLinkConfig } from '../config/config'
import { describeUpstream } from '../config/config'
import type { KiroUsageSummary } from '../kiro/usage'
import type { MetricsSnapshot } from './metrics'

export type StatusPayload = {
  ok: true
  version: string
  baseUrl: string
  host: string
  port: number
  auth: string
  authMode: 'cli' | 'api-key'
  region: string | undefined
  requireCredits: boolean
  credits: KiroUsageSummary | undefined
  metrics: MetricsSnapshot
}

export function buildStatusPayload(input: {
  config: KiroLinkConfig
  port: number
  version: string
  metrics: MetricsSnapshot
  credits: KiroUsageSummary | undefined
}): StatusPayload {
  const { config, port, version, metrics, credits } = input
  return {
    ok: true,
    version,
    baseUrl: `http://${config.server.host}:${port}`,
    host: config.server.host,
    port,
    auth: describeUpstream(config.upstream),
    authMode: config.upstream.mode,
    region: config.upstream.apiRegion,
    requireCredits: config.credits.required,
    credits,
    metrics,
  }
}
