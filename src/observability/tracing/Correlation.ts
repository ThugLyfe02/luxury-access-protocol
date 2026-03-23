/**
 * Correlation ID utilities.
 *
 * Every operation in the system can be traced via correlationId.
 * For HTTP requests, correlationId = requestId.
 * For workers, correlationId = workerName:pollCycle or eventId.
 * For reconciliation, correlationId = runId.
 */

import { getRequestContext } from './RequestContext';

export function getCurrentCorrelationId(): string | undefined {
  return getRequestContext()?.correlationId;
}

export function getCurrentRequestId(): string | undefined {
  return getRequestContext()?.requestId;
}

export function getCurrentActorId(): string | undefined {
  return getRequestContext()?.actorId;
}

/**
 * Build a correlation context object for structured logging.
 * Returns only defined fields — no nulls or undefineds.
 */
export function getCorrelationContext(): Record<string, string> {
  const ctx = getRequestContext();
  if (!ctx) return {};

  const result: Record<string, string> = {
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
  };
  if (ctx.actorId) result.actorId = ctx.actorId;
  return result;
}
