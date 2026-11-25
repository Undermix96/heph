import { describe, expect, it as test } from 'vitest';
import { ApiError, NETWORK_ERROR } from '../api/client.js';
import { errorKey } from '../lib/errors.js';
import { en } from './en.js';
import { format, makeI18n } from './index.js';
import { it } from './it.js';

describe('i18n', () => {
  test('Italian and English have the same keys and no empty text', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(it).sort());
    for (const [k, v] of [...Object.entries(it), ...Object.entries(en)]) {
      expect(v.trim(), k).not.toBe('');
    }
  });

  test('placeholders match between languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(it) as (keyof typeof it)[]) {
      expect(vars(en[k]), k).toEqual(vars(it[k]));
    }
  });

  test('format fills placeholders and leaves unknown ones visible', () => {
    expect(format('{a} e {b}', { a: 1, b: 'x' })).toBe('1 e x');
    expect(format('{a} e {c}', { a: 1 })).toBe('1 e {c}');
  });

  test('relative time uses the locale and keeps the absolute date as title', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');
    const i18n = makeI18n('it', () => now);
    expect(i18n.relative('2026-11-25T11:59:50.000Z').text).toBe('adesso');
    expect(i18n.relative('2026-11-22T12:00:00.000Z').text).toBe('3 giorni fa');
    expect(makeI18n('en', () => now).relative('2026-11-25T10:00:00.000Z').text).toBe('2 hours ago');
    expect(i18n.relative('not a date').text).toBe('not a date');
  });

  test('every error code maps to a fixed text, unknown codes to a generic one (D44)', () => {
    for (const code of [
      'not_found',
      'validation',
      'conflict',
      'forbidden',
      'unauthorized',
      'too_large',
      'rate_limited',
      'unsupported',
      NETWORK_ERROR,
    ]) {
      expect(errorKey(new ApiError(400, code, 'raw server text')), code).toBe(`error.${code}`);
    }
    expect(errorKey(new ApiError(500, 'internal', 'x'))).toBe('error.unknown');
    expect(errorKey(new Error('boom'))).toBe('error.unknown');
  });
});
