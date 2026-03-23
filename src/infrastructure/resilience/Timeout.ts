/**
 * Bounded execution wrapper.
 *
 * Ensures no operation hangs indefinitely.
 * Returns a clear TimeoutError with the operation name for diagnostics.
 */

export class TimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Execute a promise with a hard timeout.
 *
 * If the operation does not complete within timeoutMs, a TimeoutError is thrown.
 * The underlying operation may continue running (JavaScript does not support
 * cooperative cancellation natively), but its result will be ignored.
 */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${timeoutMs}ms for operation '${operation}'`);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new TimeoutError(operation, timeoutMs));
      }
    }, timeoutMs);

    fn().then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}
