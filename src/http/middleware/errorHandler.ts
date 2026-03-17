import { Request, Response, NextFunction } from 'express';
import { DomainError } from '../../domain/errors/DomainError';
import { mapDomainErrorToStatus } from '../errors/mapDomainErrorToHttp';

/**
 * Central Express error handler.
 * Catches any error that escapes route handlers.
 * DomainErrors → structured JSON with mapped status.
 * Unknown errors → 500 with no internal detail leakage.
 */
export function centralErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof DomainError) {
    const status = mapDomainErrorToStatus(err);
    res.status(status).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
      requestId: req.requestId,
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    requestId: req.requestId,
    error: 'unhandled_error',
    message: err instanceof Error ? err.message : 'unknown',
  }));

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
    requestId: req.requestId,
  });
}
