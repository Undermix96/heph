import type { AuthUser, Ctx, Domain } from '@heph/core';
import { DomainError } from '@heph/core';
import type { Context, ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

/** Variables set on the Hono context by the auth middleware. */
export interface AppEnv {
  Variables: {
    domain: Domain;
    user: AuthUser | null;
    /** Who performs this request's mutations. */
    ctx: Ctx;
    sessionToken: string | null;
  };
}

const STATUS: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  validation: 400,
  conflict: 409,
  forbidden: 403,
  unauthorized: 401,
  too_large: 413,
  unsupported: 501,
};

/** Maps domain errors to JSON responses: `{ error: { code, message, details? } }`. */
export function errorHandler(log: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof DomainError) {
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        STATUS[err.code],
      );
    }
    if (err instanceof ZodError) {
      const message = err.issues
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ');
      return c.json({ error: { code: 'validation', message, details: err.issues } }, 400);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: { code: 'validation', message: 'Malformed JSON body' } }, 400);
    }
    if (
      'status' in err &&
      typeof err.status === 'number' &&
      err.status >= 400 &&
      err.status < 500
    ) {
      return c.json(
        { error: { code: 'http', message: err.message } },
        err.status as ContentfulStatusCode,
      );
    }
    log.error({ err, path: c.req.path }, 'Unhandled error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  };
}

/**
 * Reads a JSON object body; an empty body is `{}`. Anything but an object is a 400.
 * `requireJson`: the Content-Type must be application/json (browsers cannot send that
 * cross-site without a CORS preflight, which this server never grants).
 */
export async function body(
  c: Context,
  opts: { requireJson?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (
    opts.requireJson &&
    !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')
  ) {
    throw new DomainError('validation', 'Content-Type must be application/json');
  }
  const text = await c.req.text();
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('validation', 'The request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Parses a positive integer path parameter. */
export function idParam(c: Context, name = 'id'): number {
  const raw = c.req.param(name) ?? '';
  if (!/^\d+$/.test(raw)) throw new DomainError('validation', `Invalid ${name}`);
  return Number(raw);
}

/** Collects query parameters; repeated keys become arrays. */
export function queryObject(c: Context): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(c.req.queries()))
    out[k] = v.length === 1 ? (v[0] as string) : v;
  return out;
}
