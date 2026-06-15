export class InvalidRequestError extends Error {
  override name = 'InvalidRequestError'
}

export class RuntimeApiError extends Error {
  override name = 'RuntimeApiError'

  constructor(
    public readonly statusCode: number,
    public readonly upstreamBody: string,
    public readonly retryAfterSeconds: number | undefined = undefined,
  ) {
    super(`Kiro runtime request failed with status ${statusCode}`)
  }
}
