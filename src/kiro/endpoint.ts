/**
 * Runtime URL resolution and host allowlisting.
 *
 * The proxy sends a bearer token upstream, so the destination host must be
 * validated before the request is issued: an attacker who can set the API URL
 * would otherwise be able to exfiltrate the credential.
 */

import type { UpstreamConfig } from '../config/config'

const DEFAULT_API_URL = 'https://runtime.us-east-1.kiro.dev/'

/**
 * Hosts matching real Kiro / Amazon Q / CodeWhisperer data-plane endpoints.
 * Region is variable (us-east-1, eu-central-1, …) so match by pattern.
 */
const ALLOWED_API_HOST_PATTERNS = [
  /^runtime\.[a-z0-9-]+\.kiro\.dev$/u,
  /^q\.[a-z0-9-]+\.amazonaws\.com$/u,
  /^codewhisperer\.[a-z0-9-]+\.amazonaws\.com$/u,
]

export function isAllowedKiroApiHost(hostname: string): boolean {
  return ALLOWED_API_HOST_PATTERNS.some((pattern) => pattern.test(hostname))
}

/**
 * Default runtime host. `apiRegion` retargets the host
 * (eu-central-1 → runtime.eu-central-1.kiro.dev); a full `apiUrl` still wins.
 */
export function defaultKiroApiUrl(upstream: Pick<UpstreamConfig, 'apiRegion'>): string {
  return upstream.apiRegion ? `https://runtime.${upstream.apiRegion}.kiro.dev/` : DEFAULT_API_URL
}

export function resolveKiroApiUrl(upstream: UpstreamConfig): URL {
  const url = new URL(upstream.apiUrl ?? defaultKiroApiUrl(upstream))
  const allowUntrusted = upstream.allowUntrustedApiUrl

  if (url.protocol !== 'https:') {
    throw new Error('API URL must use https')
  }
  if (url.username || url.password) {
    throw new Error('API URL must not contain credentials')
  }
  if (url.pathname !== '/' && url.pathname !== '/generateAssistantResponse') {
    throw new Error('API URL path must be / or /generateAssistantResponse')
  }
  if (url.search || url.hash) {
    throw new Error('API URL must not include query or fragment')
  }
  if (url.port && url.port !== '443' && !allowUntrusted) {
    throw new Error('API URL must not use a custom port')
  }
  if (!isAllowedKiroApiHost(url.hostname) && !allowUntrusted) {
    throw new Error(`Refusing to send Kiro token to untrusted API host: ${url.hostname}`)
  }
  return url
}

/** REST base for getUsageLimits, which is served by a different host family. */
export function resolveUsageRestBase(region: string): string {
  if (region === 'us-east-1') return 'https://codewhisperer.us-east-1.amazonaws.com'
  // Non-us-east-1 CodeWhisperer REST is served by the regional Amazon Q host.
  return `https://q.${region}.amazonaws.com`
}
