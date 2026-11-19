export interface SessionControllerLike {
  list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: Array<Record<string, unknown>> }>
  events(request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
  follow(request: Record<string, unknown>, signal: AbortSignal): AsyncIterable<Record<string, unknown>>
}
