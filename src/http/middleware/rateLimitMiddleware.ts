import { Request, Response, NextFunction } from 'express';
import { RateLimiter, RateLimitResult } from '../../infrastructure/resilience/RateLimiter';

/**
 * Express middleware factory for route-aware rate limiting.
 *
 * Returns 429 with structured error body and Retry-After header.
 * Key extraction defaults to IP, but can use actor ID if authenticated.
 */
export function createRateLimitMiddleware(
  limiter: RateLimiter,
  keyExtractor: (req: Request) => string = defaultKeyExtractor,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyExtractor(req);
    const result: RateLimitResult = limiter.check(key);

    res.setHeader('X-RateLimit-Limit', limiter.config.maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
      res.setHeader('Retry-After', Math.max(1, retryAfter));
      res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Rate limit exceeded. Please try again later.',
        },
        requestId: req.requestId,
      });
      return;
    }

    next();
  };
}

function defaultKeyExtractor(req: Request): string {
  // Use actor ID if authenticated, fall back to IP
  const actor = req.actor as { userId?: string } | undefined;
  if (actor?.userId) return `actor:${actor.userId}`;
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
}
