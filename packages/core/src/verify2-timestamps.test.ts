/**
 * Second independent verification of D39 (timestamps as UTC ISO 8601 text):
 * randomized ordering/paging invariants, time-zone independence, refusal of
 * out-of-range values without side effects.
 */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { isoForStorage, MAX_STORABLE_MS, MIN_STORABLE_MS, projects } from './db/schema.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { iso } from './util.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UI = { source: 'ui' } as const;

let t: TestDomain | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});
function domain(start?: number) {
  t = makeDomain(start);
  return t;
}

type Raw = { all(...p: unknown[]): Record<string, unknown>[]; get(...p: unknown[]): unknown };
const raw = (d: TestDomain['d'], q: string) =>
  (d.db.$client as unknown as { prepare(q: string): Raw }).prepare(q);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('verify2: storage range', () => {
  it('isoForStorage refuses NaN, Infinity and values one ms outside the bounds', () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      MIN_STORABLE_MS - 1,
      MAX_STORABLE_MS + 1,
      8.64e15,
    ]) {
      expect(() => isoForStorage(bad), String(bad)).toThrow(RangeError);
    }
    expect(isoForStorage(MIN_STORABLE_MS)).toBe('0000-01-01T00:00:00.000Z');
    expect(isoForStorage(MAX_STORABLE_MS)).toBe('9999-12-31T23:59:59.999Z');
  });

  it('a refused touch() leaves last_activity_at unchanged', () => {
    const { d } = domain();
    const p = seedProject(d);
    const before = raw(d, `select last_activity_at as v from projects where id = ${p.id}`).get();
    expect(() => d.projects.touch(p.id, MAX_STORABLE_MS + 1)).toThrow(RangeError);
    expect(() => d.projects.touch(p.id, Number.NaN)).toThrow(RangeError);
    expect(raw(d, `select last_activity_at as v from projects where id = ${p.id}`).get()).toEqual(
      before,
    );
  });

  it('an out-of-range event write stores nothing (no partial diary row)', () => {
    const { d } = domain();
    const p = seedProject(d);
    const count = () =>
      (raw(d, 'select count(*) as n from diary_entries').get() as { n: number }).n;
    const n0 = count();
    expect(() => d.diary.event(p.id, 'status_changed', 'x', {}, UI, MAX_STORABLE_MS + 1)).toThrow();
    expect(count()).toBe(n0);
  });
});

describe('verify2: time-zone independence', () => {
  it('stored and returned times are UTC whatever process TZ is', () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'America/St_Johns', 'Europe/Rome']) {
        process.env.TZ = tz;
        const start = Date.UTC(2026, 2, 29, 1, 30); // Europe DST switch night
        const x = makeDomain(start);
        try {
          const p = seedProject(x.d);
          const r = raw(
            x.d,
            `select created_at, last_activity_at from projects where id = ${p.id}`,
          ).get() as Record<string, string>;
          expect(r.created_at).toBe('2026-03-29T01:30:00.000Z');
          expect(r.last_activity_at).toBe('2026-03-29T01:30:00.000Z');
          expect(x.d.projects.get(p.id).createdAt).toBe('2026-03-29T01:30:00.000Z');
          // SQL default ('now') is UTC as well
          const sqlNow = (
            raw(x.d, "select strftime('%Y-%m-%dT%H:%M:%fZ','now') as v").get() as { v: string }
          ).v;
          expect(sqlNow).toMatch(ISO_RE);
          expect(Math.abs(Date.parse(sqlNow) - Date.now())).toBeLessThan(5_000);
        } finally {
          x.cleanup();
        }
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});

describe('verify2: randomized invariants', () => {
  it('text order of stored values equals numeric time order (random times 0000-9999)', () => {
    const r = rng(42);
    const values: number[] = [];
    for (let i = 0; i < 2000; i++) {
      values.push(Math.floor(MIN_STORABLE_MS + r() * (MAX_STORABLE_MS - MIN_STORABLE_MS)));
    }
    values.push(MIN_STORABLE_MS, MAX_STORABLE_MS, 0, -1, 1);
    const byNum = [...values].sort((a, b) => a - b).map(isoForStorage);
    const byText = values.map(isoForStorage).sort();
    expect(byText).toEqual(byNum);
    for (const s of byText) expect(s).toMatch(ISO_RE);
    // also localeCompare (used by ProjectsService.list)
    const byLocale = values.map(isoForStorage).sort((a, b) => a.localeCompare(b));
    expect(byLocale).toEqual(byNum);
  });

  it('diary paging returns every entry exactly once, newest first (random times, many ties)', () => {
    const { d } = domain();
    const p = seedProject(d);
    const r = rng(7);
    const pool = [
      MIN_STORABLE_MS,
      MAX_STORABLE_MS,
      Date.UTC(1969, 11, 31, 23, 59, 59, 999),
      Date.UTC(2026, 1, 28, 23, 59, 59, 999),
      Date.UTC(2028, 1, 29),
    ];
    for (let i = 0; i < 300; i++) {
      const ms =
        r() < 0.4
          ? pool[Math.floor(r() * pool.length)]!
          : Date.UTC(2026, 0, 1) + Math.floor(r() * 3) * 1 + Math.floor(r() * 5) * 86_400_000;
      d.diary.event(p.id, 'status_changed', `e${i}`, {}, UI, ms);
    }
    const all = d.diary.list(p.id, { limit: 500, type: 'event' });
    expect(all.length).toBeGreaterThanOrEqual(300); // + the "project created" event
    for (const limit of [1, 4, 13, 299, 300, 500]) {
      const seen: { id: number; at: string }[] = [];
      let cursor: { before?: string; beforeId?: number } = {};
      for (let g = 0; g < 400; g++) {
        const page = d.diary.list(p.id, { limit, type: 'event', ...cursor });
        if (!page.length) break;
        seen.push(...page.map((e) => ({ id: e.id, at: e.occurredAt })));
        const last = page.at(-1)!;
        cursor = { before: last.occurredAt, beforeId: last.id };
      }
      expect(seen.map((s) => s.id)).toEqual(all.map((e) => e.id));
      for (let i = 1; i < seen.length; i++) {
        const a = seen[i - 1]!;
        const b = seen[i]!;
        expect(a.at > b.at || (a.at === b.at && a.id > b.id)).toBe(true);
      }
    }
  });

  it('project list orders by last activity for random times (same attention group)', () => {
    const now = Date.UTC(2027, 0, 1, 0, 0, 0, 500);
    const { d, clock } = domain(now);
    const r = rng(99);
    const expected: { id: number; at: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const p = seedProject(d, { name: `P${i}` });
      // all within the last 7 days so they stay in one attention group; ms resolution
      const at = now - Math.floor(r() * 6 * 86_400_000);
      d.db.update(projects).set({ lastActivityAt: at }).where(eq(projects.id, p.id)).run();
      expected.push({ id: p.id, at });
    }
    clock.now = now;
    const list = d.projects.list({});
    const groups = new Set(list.map((s) => s.attentionGroup));
    expect(groups.size).toBe(1);
    expected.sort((a, b) => b.at - a.at || a.id - b.id);
    expect(list.map((s) => s.id)).toEqual(expected.map((e) => e.id));
    expect(list.map((s) => s.lastActivityAt)).toEqual(expected.map((e) => iso(e.at)));
  });

  it('touch() keeps the max for a random sequence of times', () => {
    const { d } = domain();
    const p = seedProject(d);
    const r = rng(3);
    let max = Date.parse(d.projects.get(p.id).lastActivityAt);
    for (let i = 0; i < 200; i++) {
      const at = Date.UTC(1990, 0, 1) + Math.floor(r() * 80 * 365 * 86_400_000);
      d.projects.touch(p.id, at);
      max = Math.max(max, at);
      expect(d.projects.get(p.id).lastActivityAt).toBe(iso(max));
    }
  });
});
