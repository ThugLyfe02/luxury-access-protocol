import { hostname } from 'node:os';

let counter = 0;

/**
 * Generates a globally unique worker ID.
 *
 * Format: `{hostname}-{pid}-{timestamp}-{counter}`
 *
 * - hostname: distinguishes pods/machines
 * - pid: distinguishes processes on the same host
 * - timestamp: prevents collision on PID reuse after restart
 * - counter: prevents collision within the same millisecond
 *
 * Generated once at startup. Never changes during process lifetime.
 */
export function generateWorkerId(): string {
  const host = hostname();
  const pid = process.pid;
  const ts = Date.now();
  const seq = counter++;
  return `${host}-${pid}-${ts}-${seq}`;
}
