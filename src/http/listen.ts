/**
 * Bind a server to a port, advancing past ones already in use.
 *
 * Both `serve` and the tray supervisor need this: without it, a second instance
 * (or a leftover process) on the default port kills startup instead of quietly
 * moving to the next port.
 */

import type { Server } from 'node:http'

/** How many sequential ports to try when the requested one is busy. */
export const MAX_PORT_ATTEMPTS = 10

export type ListenOptions = {
  /** Called before each retry, e.g. to warn that a port was busy. */
  onRetry?: (busyPort: number, nextPort: number) => void
}

/**
 * Listen on `startPort`, advancing to the next port when one is in use.
 *
 * A prior implementation re-listened on a port captured in a const from a
 * persistent error handler, so two consecutive busy ports produced an infinite
 * retry loop. Attempts are bounded and the port actually advances.
 */
export function listenWithFallback(
  server: Server,
  startPort: number,
  host: string,
  options: ListenOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0

    const tryListen = (port: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        if (error.code !== 'EADDRINUSE') {
          reject(error)
          return
        }
        attempt++
        if (attempt >= MAX_PORT_ATTEMPTS) {
          reject(new Error(`No free port found in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`))
          return
        }
        options.onRetry?.(port, port + 1)
        tryListen(port + 1)
      }

      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        resolve(address !== null && typeof address === 'object' ? address.port : port)
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }

    tryListen(startPort)
  })
}
