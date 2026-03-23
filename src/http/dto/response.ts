/**
 * Standard API response envelope.
 * All routes return this shape for consistency.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export function successResponse<T>(data: T, requestId?: string): ApiResponse<T> {
  return { success: true, data, requestId };
}

export function errorResponse(
  code: string,
  message: string,
  requestId?: string,
  details?: unknown,
): ApiResponse {
  return {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    requestId,
  };
}
