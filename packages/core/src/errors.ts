export type DomainErrorCode =
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'forbidden'
  | 'unauthorized'
  | 'too_large'
  | 'rate_limited'
  | 'unsupported';

/** Errors the adapters map to protocol-specific responses (HTTP status, MCP error). */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string, ref?: unknown) =>
  new DomainError(
    'not_found',
    ref === undefined ? `${what} not found` : `${what} ${String(ref)} not found`,
  );
