/**
 * Independent verification of D39 (timestamps as UTC ISO 8601 text).
 * Checks the raw database representation, SQL defaults, keyset pagination,
 * thresholds and ordering, including month/year boundaries and extreme dates.
 */
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { authSessions, projects } from './db/schema.js';
import { CLAUDE, insertLiveSession, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

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

type Raw = {
  all(...p: unknown[]): Record<string, unknown>[];
  get(...p: unknown[]): unknown;
  run(...p: unknown[]): unknown;
};
const raw = (d: TestDomain['d'], q: string) =>
  (d.db.$client as unknown as { prepare(q: string): Raw }).prepare(q);

/** Every (table, column) that holds a timestamp, by naming convention. */
function timestampColumns(d: TestDomain['d']): { table: string; column: string; type: string }[] {
  const tables = raw(
    d,
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'search_fts%' and name not like '__drizzle%'",
  ).all() as { name: string }[];
  const out: { table: string; column: string; type: string }[] = [];
  for (const { name } of tables) {
    const cols = raw(d, `pragma table_info(\`${name}\`)`).all() as { name: string; type: string }[];
    for (const c of cols) {
      if (/_at$|_since$/.test(c.name))
        out.push({ table: name, column: c.name, type: c.type.toLowerCase() });
    }
  }
  return out;
}

/** Exercises most write paths so that every table has rows. */
async function populate(x: TestDomain) {
  const { d, clock } = x;
  await d.auth.setup({ username: 'admin', password: 'correct horse battery' });
  await d.auth.login({ username: 'admin', password: 'correct horse battery' });
  const p = seedProject(d, { tags: ['a'] });
  const task = p.phases[0]!.tasks[0]!;
  clock.advance(1234);
  d.roadmap.completeTask(task.id, UI);
  d.diary.addNote(p.id, { body: 'hello' }, UI);
  d.materials.add(p.id, { name: 'Screw', quantity: 2 }, UI);
  const prop = d.roadmap.deleteTask(p.phases[1]!.tasks[0]!.id, CLAUDE)!;
  d.proposals.approve(prop.id, {}, UI);
  d.projects.linkRepo(p.id, 'octo/demo', UI);
  d.files.createUploadToken(p.id, {}, UI);
  insertLiveSession(d, p.id, { isTesting: false });
  return p;
}

describe('verify: raw storage format', () => {
  it('every *_at column is declared TEXT', () => {
    const { d } = domain();
    const cols = timestampColumns(d).filter((c) => c.column.endsWith('_at'));
    expect(cols.length).toBeGreaterThan(20);
    for (const c of cols)
      expect(`${c.table}.${c.column}:${c.type}`).toBe(`${c.table}.${c.column}:text`);
  });

  it('claude_sessions.testing_since is declared TEXT', () => {
    const { d } = domain();
    const col = timestampColumns(d).find(
      (c) => c.table === 'claude_sessions' && c.column === 'testing_since',
    );
    expect(col?.type).toBe('text');
  });

  it('every stored *_at value is ISO text with ms and Z (or NULL)', async () => {
    const x = domain();
    await populate(x);
    let checked = 0;
    for (const { table, column } of timestampColumns(x.d).filter((c) => c.column.endsWith('_at'))) {
      const rows = raw(
        x.d,
        `select typeof(\`${column}\`) as t, \`${column}\` as v from \`${table}\``,
      ).all();
      for (const r of rows) {
        if (r.t === 'null') continue;
        checked++;
        expect(`${table}.${column} ${r.t}`).toBe(`${table}.${column} text`);
        expect(String(r.v), `${table}.${column}`).toMatch(ISO_RE);
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('a testing live session stores testing_since as ISO text', () => {
    const { d } = domain();
    const p = seedProject(d);
    insertLiveSession(d, p.id, { isTesting: true });
    const r = raw(
      d,
      'select typeof(testing_since) t, testing_since v from claude_sessions',
    ).get() as {
      t: string;
      v: unknown;
    };
    expect(r.t).toBe('text');
    expect(String(r.v)).toMatch(ISO_RE);
  });

  it('testing_since is still returned as ISO in the live session view', () => {
    const { d, clock } = domain();
    const p = seedProject(d);
    insertLiveSession(d, p.id, { isTesting: true });
    const live = d.sessions.liveFor([p.id]).get(p.id)!;
    expect(live[0]!.testingSince).toBe(new Date(clock.now).toISOString());
  });

  it('SQL defaults produce the same format as Date.toISOString()', () => {
    const { d } = domain();
    raw(d, "insert into users (username, password_hash) values ('raw', 'x')").run();
    const r = raw(d, "select created_at, updated_at from users where username='raw'").get() as {
      created_at: string;
      updated_at: string;
    };
    expect(r.created_at).toMatch(ISO_RE);
    expect(r.updated_at).toMatch(ISO_RE);
    expect(Math.abs(Date.parse(r.created_at) - Date.now())).toBeLessThan(60_000);
    expect(new Date(Date.parse(r.created_at)).toISOString()).toBe(r.created_at);
  });

  it('a default-only project row reads back as ISO in views', () => {
    const { d } = domain();
    raw(d, "insert into projects (name, slug) values ('Raw', 'raw')").run();
    const v = d.projects.get('raw');
    for (const k of ['createdAt', 'updatedAt', 'lastActivityAt', 'statusChangedAt'] as const) {
      expect(v[k]).toMatch(ISO_RE);
    }
  });

  it('round-trips ms precision and pre-1970 / year-9999 values', () => {
    const { d } = domain();
    const p = seedProject(d);
    for (const ms of [
      0,
      -1,
      Date.UTC(1900, 0, 1),
      Date.UTC(9999, 11, 31, 23, 59, 59, 999),
      1_795_000_000_123,
    ]) {
      d.diary.event(p.id, 'status_changed', 'x', {}, UI, ms);
    }
    const got = d.diary.list(p.id, { limit: 50 }).map((e) => e.occurredAt);
    for (const v of got) expect(v).toMatch(ISO_RE);
    expect(got).toContain('9999-12-31T23:59:59.999Z');
    expect(got).toContain('1969-12-31T23:59:59.999Z');
    expect(got).toContain('1900-01-01T00:00:00.000Z');
  });
});

describe('verify: diary keyset pagination', () => {
  function pageAll(d: TestDomain['d'], ref: number | null, limit: number) {
    const seen: { id: number; occurredAt: string }[] = [];
    let cursor: { before?: string; beforeId?: number } = {};
    for (let guard = 0; guard < 1000; guard++) {
      const page = d.diary.list(ref, { limit, ...cursor });
      if (page.length === 0) break;
      seen.push(...page.map((e) => ({ id: e.id, occurredAt: e.occurredAt })));
      const last = page.at(-1)!;
      cursor = { before: last.occurredAt, beforeId: last.id };
    }
    return seen;
  }

  it('returns every entry exactly once, newest first, with ties and boundaries', () => {
    const { d } = domain();
    const p = seedProject(d);
    const times = [
      Date.UTC(2025, 11, 31, 23, 59, 59, 999), // year boundary
      Date.UTC(2026, 0, 1, 0, 0, 0, 0),
      Date.UTC(2026, 0, 31, 23, 59, 59, 999), // month boundary
      Date.UTC(2026, 1, 1),
      Date.UTC(2026, 1, 1), // ties
      Date.UTC(2026, 1, 1),
      Date.UTC(2026, 1, 1, 0, 0, 0, 1),
      Date.UTC(1999, 11, 31, 23, 59, 59, 999),
      Date.UTC(2000, 0, 1),
      Date.UTC(1970, 0, 1),
      Date.UTC(1969, 11, 31, 23, 59, 59, 999),
      Date.UTC(9999, 11, 31, 23, 59, 59, 999),
      Date.UTC(2026, 8, 9), // single-digit month/day in local formats
      Date.UTC(2026, 9, 10),
    ];
    for (let i = 0; i < 3; i++)
      for (const ms of times) d.diary.event(p.id, 'status_changed', `e${i}`, {}, UI, ms);
    const all = d.diary.list(p.id, { limit: 500 });
    for (const limit of [1, 2, 3, 7, 500]) {
      const seen = pageAll(d, p.id, limit);
      expect(seen.length).toBe(all.length);
      expect(new Set(seen.map((s) => s.id)).size).toBe(all.length);
      for (let i = 1; i < seen.length; i++) {
        const a = seen[i - 1]!;
        const b = seen[i]!;
        const ok =
          Date.parse(a.occurredAt) > Date.parse(b.occurredAt) ||
          (a.occurredAt === b.occurredAt && a.id > b.id);
        expect(ok, `${JSON.stringify(a)} before ${JSON.stringify(b)}`).toBe(true);
      }
    }
    // global diary paging too
    expect(pageAll(d, null, 4).length).toBe(d.diary.list(null, { limit: 500 }).length);
  });

  it('before without beforeId is a strict time cursor', () => {
    const { d } = domain();
    const p = seedProject(d);
    const t0 = Date.UTC(2026, 0, 1);
    d.diary.event(p.id, 'status_changed', 'a', {}, UI, t0 - 1);
    d.diary.event(p.id, 'status_changed', 'b', {}, UI, t0);
    d.diary.event(p.id, 'status_changed', 'c', {}, UI, t0 + 1);
    const got = d.diary.list(p.id, { before: new Date(t0).toISOString(), type: 'event' });
    expect(got.map((e) => e.body)).toEqual(['a']);
  });

  it('accepts a cursor without milliseconds (still ISO)', () => {
    const { d } = domain();
    const p = seedProject(d);
    d.diary.event(p.id, 'status_changed', 'a', {}, UI, Date.UTC(2026, 0, 1, 0, 0, 0, 500));
    d.diary.event(p.id, 'status_changed', 'b', {}, UI, Date.UTC(2026, 0, 1, 0, 0, 1));
    const got = d.diary.list(p.id, { before: '2026-01-01T00:00:01Z', type: 'event' });
    expect(got.map((e) => e.body)).toEqual(['a']);
  });

  it('rejects a numeric (unix ms) cursor', () => {
    const { d } = domain();
    const p = seedProject(d);
    expect(() => d.diary.list(p.id, { before: String(Date.now()) })).toThrow();
    expect(() => d.diary.list(p.id, { before: Date.now() })).toThrow();
  });

  it('sorts correctly when a heph-written entry and a SQL-default entry share a second', () => {
    const { d } = domain(Date.UTC(2026, 0, 1));
    const p = seedProject(d);
    // default occurred_at = wall clock (strftime); explicit = toISOString; both must sort as times
    raw(
      d,
      `insert into diary_entries (project_id, type, body, source) values (${p.id}, 'note', 'sqldefault', 'ui')`,
    ).run();
    d.diary.event(p.id, 'status_changed', 'explicit-old', {}, UI, Date.UTC(2020, 0, 1));
    const list = d.diary.list(p.id, { limit: 500 });
    const i1 = list.findIndex((e) => e.body === 'sqldefault');
    const i2 = list.findIndex((e) => e.body === 'explicit-old');
    expect(i1).toBeLessThan(i2);
  });

  // Years outside 0000–9999 would break fixed-width text ordering (D39): they are refused.
  it('refuses timestamps outside years 0000-9999 and stores the bounds', () => {
    const { d } = domain();
    const p = seedProject(d);
    expect(() =>
      d.diary.event(p.id, 'status_changed', 'far', {}, UI, Date.UTC(10000, 0, 1)),
    ).toThrow(RangeError);
    expect(() =>
      d.diary.event(
        p.id,
        'status_changed',
        'neg',
        {},
        UI,
        Date.parse('0000-01-01T00:00:00.000Z') - 1,
      ),
    ).toThrow(RangeError);
    d.diary.event(p.id, 'status_changed', 'max', {}, UI, Date.parse('9999-12-31T23:59:59.999Z'));
    d.diary.event(p.id, 'status_changed', 'min', {}, UI, Date.parse('0000-01-01T00:00:00.000Z'));
    const list = d.diary.list(p.id, { type: 'event', limit: 500 });
    expect(list[0]!.body).toBe('max');
    expect(list.at(-1)!.body).toBe('min');
  });
});

describe('verify: thresholds and comparisons', () => {
  const thresholds = [
    [7 * DAY_MS - 1, 'recently_active'],
    [7 * DAY_MS, 'idle'],
    [30 * DAY_MS, 'idle'],
    [30 * DAY_MS + 1, 'inactive'],
  ] as const;

  for (const [age, state] of thresholds) {
    it(`activity state at age ${age} ms across a year boundary is ${state}`, () => {
      const start = Date.UTC(2025, 11, 31, 23, 59, 59, 999) - 30 * DAY_MS + 1;
      const { d, clock } = domain(start);
      const p = seedProject(d);
      clock.now = start + age;
      expect(d.projects.get(p.id).activityState).toBe(state);
    });
  }

  it('live session expiry at exactly 30 min across a month boundary', () => {
    const hb = Date.UTC(2026, 0, 31, 23, 45);
    const { d, clock } = domain(hb);
    const p = seedProject(d);
    insertLiveSession(d, p.id, { lastHeartbeatAt: hb });
    clock.now = hb + 30 * 60_000 - 1;
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
    expect(d.sessions.expireStale()).toBe(0);
    clock.now = hb + 30 * 60_000;
    expect(d.sessions.liveFor([p.id]).get(p.id)).toBeUndefined();
    expect(d.sessions.expireStale()).toBe(1);
    const r = raw(d, 'select ended_at from claude_sessions').get() as { ended_at: string };
    expect(r.ended_at).toBe('2026-02-01T00:15:00.000Z');
  });

  it('login session: valid until 30 days, slides on use, purge only removes expired', async () => {
    const start = Date.UTC(2026, 11, 20);
    const { d, clock } = domain(start);
    await d.auth.setup({ username: 'admin', password: 'correct horse battery' });
    const a = await d.auth.login({ username: 'admin', password: 'correct horse battery' });
    clock.advance(1);
    const b = await d.auth.login({ username: 'admin', password: 'correct horse battery' });
    expect(new Date(a.expiresAt).toISOString()).toBe('2027-01-19T00:00:00.000Z');
    // slide b well into next year
    clock.now = start + 10 * DAY_MS;
    expect(d.auth.validateSession(b.sessionToken)).not.toBeNull();
    const row = d.db.select().from(authSessions).all();
    const stored = raw(d, 'select expires_at from auth_sessions order by expires_at').all() as {
      expires_at: string;
    }[];
    for (const s of stored) expect(s.expires_at).toMatch(ISO_RE);
    expect(row.length).toBe(2);
    // a expires at start+30d; b now at start+40d
    clock.now = start + 30 * DAY_MS - 1;
    expect(d.auth.validateSession(a.sessionToken)).not.toBeNull(); // slides a too
    clock.now = start + 30 * DAY_MS + 10 * DAY_MS; // exactly b's expiry
    expect(d.auth.purgeExpiredSessions()).toBe(0); // a slid to start+60d-1, b expires exactly now (not < now)
    expect(d.auth.validateSession(b.sessionToken)).toBeNull();
    clock.now = start + 60 * DAY_MS;
    expect(d.auth.purgeExpiredSessions()).toBe(1);
    expect(d.auth.validateSession(a.sessionToken)).toBeNull();
  });

  it('upload token expires after exactly 1 h, across a year boundary', () => {
    const start = Date.UTC(2026, 11, 31, 23, 30);
    const { d, clock } = domain(start);
    const p = seedProject(d);
    const a = d.files.createUploadToken(p.id, {}, UI);
    const b = d.files.createUploadToken(p.id, {}, UI);
    clock.now = start + 60 * 60_000 - 1;
    expect(() => d.files.consumeUploadToken(a.token)).not.toThrow();
    expect(() => d.files.consumeUploadToken(a.token)).toThrow(); // one-time
    clock.now = start + 60 * 60_000;
    expect(() => d.files.consumeUploadToken(b.token)).toThrow();
    const r = raw(d, 'select expires_at, used_at from upload_tokens order by rowid').all() as {
      expires_at: string;
      used_at: string | null;
    }[];
    expect(r[0]!.expires_at).toBe('2027-01-01T00:30:00.000Z');
    expect(r[0]!.used_at).toBe('2027-01-01T00:29:59.999Z');
  });

  it('briefing shows decided proposals for < 7 days, across a year boundary', () => {
    const start = Date.UTC(2026, 11, 28);
    const { d, clock } = domain(start);
    const p = seedProject(d);
    const prop = d.roadmap.deleteTask(p.phases[0]!.tasks[0]!.id, CLAUDE)!;
    d.proposals.reject(prop.id, { note: 'no' }, UI);
    const line = `#${prop.id} delete_task · **rejected**`;
    clock.now = start + 7 * DAY_MS - 1;
    expect(d.briefing.build({ project: p.id })).toContain(line);
    clock.now = start + 7 * DAY_MS;
    expect(d.briefing.build({ project: p.id })).not.toContain(line);
  });

  it('last_activity_at never moves backwards, at ms and year granularity', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const { d } = domain(start);
    const p = seedProject(d);
    const read = () =>
      (raw(d, `select last_activity_at v from projects where id=${p.id}`).get() as { v: string }).v;
    expect(read()).toBe('2026-01-01T00:00:00.000Z');
    d.projects.touch(p.id, Date.UTC(2025, 11, 31, 23, 59, 59, 999));
    expect(read()).toBe('2026-01-01T00:00:00.000Z');
    d.projects.touch(p.id, start + 1);
    expect(read()).toBe('2026-01-01T00:00:00.001Z');
    d.projects.touch(p.id, Date.UTC(1999, 0, 1));
    expect(read()).toBe('2026-01-01T00:00:00.001Z');
    d.diary.event(p.id, 'status_changed', 'old import', {}, UI, Date.UTC(2010, 0, 1));
    expect(read()).toBe('2026-01-01T00:00:00.001Z');
    d.projects.touch(p.id, Date.UTC(2026, 9, 1));
    expect(read()).toBe('2026-10-01T00:00:00.000Z');
    expect(d.projects.get(p.id).lastActivityAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('last_activity_at max() also works against a SQL-default value', () => {
    const { d } = domain();
    raw(d, "insert into projects (name, slug) values ('Raw', 'raw')").run();
    const id = d.projects.row('raw').id;
    const before = d.projects.get(id).lastActivityAt;
    d.projects.touch(id, Date.UTC(2000, 0, 1));
    expect(d.projects.get(id).lastActivityAt).toBe(before);
  });

  it('list orders by last activity (newest first) within an attention group, across years', () => {
    const { d, clock } = domain(Date.UTC(2027, 0, 5));
    const ids: Record<string, number> = {};
    for (const n of ['A', 'B', 'C', 'D']) ids[n] = seedProject(d, { name: n }).id;
    // all recently active (group 4), activity across the year boundary
    d.db
      .update(projects)
      .set({ lastActivityAt: Date.UTC(2026, 11, 31, 23, 59, 59, 999) })
      .run();
    d.projects.touch(ids.A!, Date.UTC(2027, 0, 1));
    d.projects.touch(ids.C!, Date.UTC(2027, 0, 1, 0, 0, 0, 1));
    d.db
      .update(projects)
      .set({ lastActivityAt: Date.UTC(2026, 11, 30) })
      .where(eq(projects.id, ids.D!))
      .run();
    clock.now = Date.UTC(2027, 0, 5);
    const order = d.projects.list({}).map((s) => s.name);
    expect(order).toEqual(['C', 'A', 'B', 'D']);
  });
});
