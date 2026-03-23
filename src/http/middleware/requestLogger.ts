import { Request, Response, NextFunction } from 'express';

/**
 * Lightweight request logging middleware.
 * Logs method, path, status, latency, request ID, and actor ID (if authenticated).
 * Never logs sensitive data (auth tokens, card numbers, webhook secrets).
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const latencyMs = Date.now() - start;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latencyMs,
    };

    // Include actor identity if authenticated (never log raw tokens)
    if (req.actor) {
      entry.actorId = req.actor.userId;
      entry.actorRole = req.actor.role;
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  });

  next();
}
