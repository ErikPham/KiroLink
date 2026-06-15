export type ProxyConfig = {
  port: number
  host: string
  quiet: boolean
  verbose: boolean
  maxConcurrent: number
  delayMs: number
  apiKey: string | undefined
  maxBodyBytes: number
}

const MIN_API_KEY_BYTES = 16

export function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function readPort(value: string | undefined, fallback: number): number {
  const port = readPositiveInteger(value, fallback, 'port')
  if (port > 65_535) {
    throw new Error('port must be between 1 and 65535')
  }
  return port
}

export function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function assertSafeBind(config: Pick<ProxyConfig, 'host' | 'apiKey'>): void {
  if (config.apiKey && Buffer.byteLength(config.apiKey) < MIN_API_KEY_BYTES) {
    throw new Error(`API key must be at least ${MIN_API_KEY_BYTES} bytes`)
  }
  if (!isLocalHost(config.host) && !config.apiKey) {
    throw new Error('Refusing to bind to a non-local host without --api-key or KIRO_PROXY_API_KEY')
  }
}
