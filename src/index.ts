import { parseArgs } from 'node:util'
import { createKiroProxyServer } from './server'
import { assertSafeBind, readPort, readPositiveInteger } from './config'

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: process.env['KIRO_PROXY_PORT'] ?? '4119' },
    host: { type: 'string', default: process.env['KIRO_PROXY_HOST'] ?? '127.0.0.1' },
    quiet: { type: 'boolean', short: 'q', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    'max-concurrent': { type: 'string', default: process.env['KIRO_PROXY_MAX_CONCURRENT'] ?? '2' },
    delay: { type: 'string', default: process.env['KIRO_PROXY_DELAY_MS'] ?? '200' },
    'api-key': { type: 'string', default: process.env['KIRO_PROXY_API_KEY'] },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (values.help) {
  process.stdout.write(`kirolink — Anthropic-compatible proxy backed by Kiro API

Usage: kirolink [options]

Options:
  -p, --port <port>           Listen port (default: 4119)
      --host <host>           Listen host (default: 127.0.0.1)
  -q, --quiet                 Hide request traces
  -v, --verbose               Show debug logs (token refresh, retries, payload info)
      --max-concurrent <n>    Max concurrent Kiro API calls (default: 2)
      --delay <ms>            Delay between queued requests (default: 200)
      --api-key <key>         Require API key for clients
  -h, --help                  Show this help

Environment:
  KIRO_PROXY_PORT, KIRO_PROXY_HOST, KIRO_PROXY_API_KEY,
  KIRO_PROXY_MAX_CONCURRENT, KIRO_PROXY_DELAY_MS,
  KIRO_PROXY_MAX_BODY_BYTES, KIRO_PROXY_API_URL

Claude Code usage:
  kirolink &
  ANTHROPIC_BASE_URL=http://127.0.0.1:4119 ANTHROPIC_AUTH_TOKEN=dummy claude
`)
  process.exit(0)
}

try {
  const port = readPort(values.port, 4119)
  const host = values.host!
  const quiet = values.quiet!
  const verbose = values.verbose!
  const maxConcurrent = readPositiveInteger(values['max-concurrent'], 2, 'max-concurrent')
  const delayMs = readPositiveInteger(values.delay, 200, 'delay')
  const apiKey = values['api-key']
  const maxBodyBytes = readPositiveInteger(process.env['KIRO_PROXY_MAX_BODY_BYTES'], 1_048_576, 'KIRO_PROXY_MAX_BODY_BYTES')

  assertSafeBind({ host, apiKey })

  const server = createKiroProxyServer({ port, host, quiet, verbose, maxConcurrent, delayMs, apiKey, maxBodyBytes })

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = port + 1
      process.stderr.write(`Port ${port} in use, trying ${nextPort}...\n`)
      server.listen(nextPort, host, () => {
        process.stdout.write(`kirolink listening on http://${host}:${nextPort}\n`)
      })
    } else {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
  })

  server.listen(port, host, () => {
    process.stdout.write(`kiro-proxy listening on http://${host}:${port}\n`)
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)))
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
