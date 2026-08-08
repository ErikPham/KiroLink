/**
 * Table-driven router.
 *
 * Replaces a 55-line if-chain of `method === X && path === Y` checks, so routes
 * are declared data rather than control flow, and a 404 vs 405 distinction comes
 * for free.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteContext = {
  req: IncomingMessage
  res: ServerResponse
  /** Parsed query string of the request URL. */
  query: URLSearchParams
}

export type RouteHandler = (context: RouteContext) => Promise<void> | void

export type Route = {
  method: 'GET' | 'POST' | 'HEAD'
  path: string
  handler: RouteHandler
  /** Skip the client API-key check (health probes must stay reachable). */
  public?: boolean
}

export type RouteMatch = { route: Route; query: URLSearchParams }

export type Router = {
  match(method: string, url: string): RouteMatch | { pathExists: boolean }
}

export function createRouter(routes: Route[]): Router {
  const byPath = new Map<string, Route[]>()
  for (const route of routes) {
    const existing = byPath.get(route.path)
    if (existing) existing.push(route)
    else byPath.set(route.path, [route])
  }

  return {
    match(method, url) {
      const [rawPath = '', rawQuery = ''] = url.split('?', 2)
      const candidates = byPath.get(rawPath)
      if (!candidates) return { pathExists: false }
      const route = candidates.find((candidate) => candidate.method === method)
      if (!route) return { pathExists: true }
      return { route, query: new URLSearchParams(rawQuery) }
    },
  }
}

export function isRouteMatch(result: RouteMatch | { pathExists: boolean }): result is RouteMatch {
  return 'route' in result
}
