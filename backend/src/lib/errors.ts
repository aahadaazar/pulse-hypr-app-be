/**
 * Every failure the API returns deliberately carries a stable machine-readable
 * `code`. The Flutter sync engine branches on these: some mean "drop this batch
 * and move on", others mean "retry with backoff". A bare HTTP status cannot
 * express that difference, and a client that retries an unretryable batch
 * forever is exactly the battery drain this backend exists to avoid.
 */
export type ErrorCode =
  | 'bad_request'
  | 'invalid_payload'
  | 'unauthenticated'
  | 'token_expired'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'upstream_error'
  | 'internal_error';

/** Codes where retrying the identical request can succeed. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'conflict',
  'rate_limited',
  'upstream_error',
  'internal_error',
]);

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  toJSON(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        requestId,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details);
  }

  static invalidPayload(message: string, details?: unknown) {
    return new ApiError(422, 'invalid_payload', message, details);
  }

  static unauthenticated(message = 'Missing or invalid credentials.') {
    return new ApiError(401, 'unauthenticated', message);
  }

  static tokenExpired(message = 'The Firebase ID token has expired.') {
    return new ApiError(401, 'token_expired', message);
  }

  static forbidden(message = 'Not permitted.') {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found.') {
    return new ApiError(404, 'not_found', message);
  }

  static conflict(message: string) {
    return new ApiError(409, 'conflict', message);
  }

  static tooLarge(message: string, details?: unknown) {
    return new ApiError(413, 'payload_too_large', message, details);
  }

  static upstream(message: string, details?: unknown) {
    return new ApiError(502, 'upstream_error', message, details);
  }

  static internal(message = 'Unexpected server error.') {
    return new ApiError(500, 'internal_error', message);
  }
}
