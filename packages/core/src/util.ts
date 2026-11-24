import crypto from 'node:crypto';
import type { z } from 'zod';
import { DomainError } from './errors.js';

/** Parses input with a Zod schema, throwing a DomainError('validation') on failure. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new DomainError(
      'validation',
      r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      r.error.issues,
    );
  }
  return r.data;
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  // All-digit slugs would clash with numeric ids in project references.
  if (/^\d+$/.test(s)) return `p-${s}`;
  return s || 'project';
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Moves `item` to `position` (clamped) and returns the reordered array. */
export function reorder<T>(items: T[], item: T, position: number): T[] {
  const rest = items.filter((x) => x !== item);
  const at = Math.max(0, Math.min(position, rest.length));
  rest.splice(at, 0, item);
  return rest;
}

export const DAY_MS = 86_400_000;
