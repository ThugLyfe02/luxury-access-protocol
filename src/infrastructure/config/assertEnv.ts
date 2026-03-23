/**
 * Reads an environment variable and throws if it is not set or empty.
 * Never returns a fallback — callers must handle missing config explicitly.
 */
export function assertEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
      'The application cannot start without it.',
    );
  }
  return value;
}

/**
 * Reads an environment variable, returning `defaultValue` if not set.
 * Unlike assertEnv, this is for optional configuration with safe defaults.
 */
export function readEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  return value;
}
