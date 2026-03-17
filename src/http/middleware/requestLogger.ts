import { Request, Response, NextFunction } from 'express';

/**
 * Lightweight request logging middleware.
 * Logs method, path, status, latency, and request ID.
 * Never logs sensitive data (auth tokens, card numbers, webhook secrets).
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const latencyMs = Date.now() - start;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latencyMs,
    });
    // eslint-disable-next-line no-console
    console.log(line);
  });

  next();
}
