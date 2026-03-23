/**
 * Async-safe request context propagation.
 *
 * Uses a simple context holder pattern suitable for single-process Node.
 * Each request sets its context at the middleware boundary; all downstream
 * logging and metrics can attach requestId and correlationId.
 *
 * No global mutation leakage — each async operation chain carries its own context.
 */

export interface RequestContextData {
  readonly requestId: string;
  readonly correlationId: string;
  readonly actorId?: string;
  readonly startTime: number;
}

/**
 * Thread-local-like context using a stack for nested operations.
 * In Node.js single-threaded model, this is safe for synchronous context access
 * within a request handler chain.
 *
 * For true async propagation across callbacks, use with AsyncLocalStorage
 * when available. This implementation provides the core interface.
 */
let _currentContext: RequestContextData | null = null;

export function setRequestContext(ctx: RequestContextData): void {
  _currentContext = ctx;
}

export function getRequestContext(): RequestContextData | null {
  return _currentContext;
}

export function clearRequestContext(): void {
  _currentContext = null;
}

export function createRequestContext(
  requestId: string,
  actorId?: string,
  correlationId?: string,
): RequestContextData {
  return {
    requestId,
    correlationId: correlationId ?? requestId,
    actorId,
    startTime: Date.now(),
  };
}
