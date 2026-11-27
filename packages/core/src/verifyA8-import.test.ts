// Independent verification A8 (D65): importing a real project's history, then normal use.
// Example data is invented.
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { phases } from './db/schema.js';
import { diaryLine } from './format.js';
import { syncedPhaseStatus } from './roadmap.js';
import { CLAUDE, CLAUDE_CONFIRMED, expectDomainError } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS, iso } from './util.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const ORIGIN = 'migration 2026-11-20: PROGRESS.md@0f1e2d3';

function phaseRow(d: TestDomain['d'], id: number) {
  return d.db
    .select()
    .from(phases)
    .all()
    .find((p) => p.id === id)!;
}

/** A realistic migrated roadmap: mixed phases, Unicode, an empty phase, many tasks. */
function bigImport(d: TestDomain['d']) {
  const many = Array.from({ length: 200 }, (_, i) =>
    i < 150
      ? { title: `Pezzo n° ${i + 1} — ✓`, done: true, doneAt: `2026-0${1 + (i % 9)}-15` }
      : `Pezzo n° ${i + 1}`,
  );
  return d.projects.create(
    {
      name: 'Stazione meteo ☀️',
      origin: ORIGIN,
      repos: ['example/stazione-meteo'],
      phases: [
        {
          title: 'Ricerca',
          tasks: [
            { title: 'Scegliere sensori', done: true, doneAt: '2025-12-31T23:30:00-05:00' },
            { title: 'Leggere datasheet BME280', done: true, doneAt: '2026-01-02T00:15:00+01:00' },
          ],
        },
        { title: 'Vuota (da definire)' },
        { title: 'Solo aperti', tasks: ['Antenna', { title: 'Batteria', notes: '18650 × 2' }] },
        { title: 'Molti', tasks: many },
        {
          title: 'Misto',
          tasks: [
            { title: 'Saldature', done: true },
            'Collaudo',
            { title: 'Taratura', done: true, doneAt: '2026-06-01' },
          ],
        },
      ],
    },
    CLAUDE,
  );
}

describe('A8: realistic import', () => {
  it('statuses follow D29, completion time is the latest doneAt, no completion events', () => {
    t = makeDomain();
    const { d } = t;
    const p = bigImport(d);
    const [ricerca, vuota, aperti, molti, misto] = p.phases;
    expect(p.phases.map((x) => x.status)).toEqual([
      'done',
      'todo',
      'todo',
      'in_progress',
      'in_progress',
    ]);
    // D29 invariant: every stored status equals what syncedPhaseStatus derives from its tasks.
    for (const ph of p.phases) {
      expect(syncedPhaseStatus(ph.status, ph.tasks)).toBe(ph.status);
    }
    // Latest of the two: 2026-01-01T23:15Z vs 2026-01-01T04:30Z.
    expect(iso(phaseRow(d, ricerca!.id).completedAt)).toBe('2026-01-01T23:15:00.000Z');
    for (const ph of [vuota, aperti, molti, misto]) {
      expect(phaseRow(d, ph!.id).completedAt).toBeNull();
    }
    expect(molti!.tasks).toHaveLength(200);
    expect(molti!.tasks.filter((x) => x.done)).toHaveLength(150);
    expect(aperti!.tasks[1]!.notes).toBe('18650 × 2');
    expect(p.nextTask?.title).toBe('Antenna');
    expect(p.progress).toMatchObject({ done: 154, total: 207 });
    expect(d.diary.list(p.id, { limit: 200 }).map((e) => e.eventKind)).toEqual(['project_created']);
  });

  it('normal use afterwards: reopen and complete in an imported done phase', () => {
    t = makeDomain();
    const { d, clock } = t;
    const p = bigImport(d);
    const ricerca = p.phases[0]!;
    const task = ricerca.tasks[1]!;
    clock.advance(60_000);
    d.roadmap.reopenTask(task.id, CLAUDE);
    expect(d.roadmap.getPhase(ricerca.id).status).toBe('in_progress');
    expect(phaseRow(d, ricerca.id).completedAt).toBeNull();
    expect(d.projects.get(p.id).nextTask?.title).toBe('Leggere datasheet BME280');
    clock.advance(60_000);
    d.roadmap.completeTask(task.id, CLAUDE);
    expect(d.roadmap.getPhase(ricerca.id).status).toBe('done');
    expect(phaseRow(d, ricerca.id).completedAt).toBe(clock.now);
    const kinds = d.diary.list(p.id, { limit: 10 }).map((e) => e.eventKind);
    expect(kinds).toEqual(['task_completed', 'task_reopened', 'project_created']);
    // The other imported task keeps its historic doneAt.
    expect(d.roadmap.getTask(ricerca.tasks[0]!.id).doneAt).toBe('2026-01-01T04:30:00.000Z');
  });

  it('completing the last open task of a mixed imported phase makes it done now', () => {
    t = makeDomain();
    const { d, clock } = t;
    const p = bigImport(d);
    const misto = p.phases[4]!;
    clock.advance(5000);
    d.roadmap.completeTask(misto.tasks[1]!.id, UI);
    expect(d.roadmap.getPhase(misto.id).status).toBe('done');
    expect(phaseRow(d, misto.id).completedAt).toBe(clock.now);
  });

  it('reordering inside an imported done phase keeps its historic completion time', () => {
    t = makeDomain();
    const { d } = t;
    const p = bigImport(d);
    const ricerca = p.phases[0]!;
    d.roadmap.moveTask(ricerca.tasks[1]!.id, { position: 0 }, UI);
    expect(d.roadmap.getPhase(ricerca.id).status).toBe('done');
    expect(iso(phaseRow(d, ricerca.id).completedAt)).toBe('2026-01-01T23:15:00.000Z');
  });

  it('restructure_roadmap on an imported project keeps doneAt and consistent statuses', () => {
    t = makeDomain();
    const { d } = t;
    const p = bigImport(d);
    const ricerca = p.phases[0]!;
    const aperti = p.phases[2]!;
    const r = d.restructure.restructure(
      p.id,
      {
        operations: [
          { op: 'move_task', taskId: ricerca.tasks[0]!.id, phase: aperti.id, position: 0 },
          { op: 'move_phase', phase: ricerca.id, position: 4 },
          { op: 'update_task', taskId: ricerca.tasks[1]!.id, title: 'Datasheet letti ✓' },
        ],
      },
      CLAUDE_CONFIRMED,
    );
    expect(r.applied).toBe(true);
    const after = d.roadmap.phasesOf(p.id);
    for (const ph of after) expect(syncedPhaseStatus(ph.status, ph.tasks)).toBe(ph.status);
    const moved = d.roadmap.getTask(ricerca.tasks[0]!.id);
    expect(moved.done).toBe(true);
    expect(moved.doneAt).toBe('2026-01-01T04:30:00.000Z');
    expect(d.roadmap.getPhase(aperti.id).status).toBe('in_progress');
  });

  it('search finds imported Unicode tasks and backdated notes', () => {
    t = makeDomain();
    const { d } = t;
    const p = bigImport(d);
    d.diary.addNote(
      p.id,
      { body: 'Calibrazione dell’igrometro completata', occurredAt: '2026-03-03', origin: ORIGIN },
      CLAUDE,
    );
    const hits = d.search.search({ q: 'igrometro' });
    expect(hits.some((h) => h.kind === 'diary')).toBe(true);
    expect(d.search.search({ q: 'datasheet' }).some((h) => h.kind === 'task')).toBe(true);
  });

  it('export JSON keeps origin on the project and on imported diary entries', () => {
    t = makeDomain();
    const { d } = t;
    const p = bigImport(d);
    d.diary.addNote(p.id, { body: 'Vecchia nota', occurredAt: '2025-11-01', origin: ORIGIN }, UI);
    const ex = d.export.build(p.id);
    expect(ex.json.project.origin).toBe(ORIGIN);
    const old = ex.json.diary.find((e) => e.body === 'Vecchia nota')!;
    expect(old.origin).toBe(ORIGIN);
    // Oldest first in the export.
    expect(ex.json.diary[0]!.body).toBe('Vecchia nota');
    expect(ex.markdown).toContain('Vecchia nota');
  });

  it('a failure in a late phase rolls back the whole project (slug stays free)', () => {
    t = makeDomain();
    const { d, clock } = t;
    const input = {
      name: 'Rollback',
      phases: [
        { title: 'A', tasks: [{ title: 'ok', done: true, doneAt: '2026-01-01' }] },
        { title: 'B', tasks: [{ title: 'bad', done: true, doneAt: iso(clock.now + 1) }] },
      ],
    };
    expectDomainError(() => d.projects.create(input, CLAUDE), 'validation');
    expect(d.projects.list()).toHaveLength(0);
    const ok = d.projects.create({ name: 'Rollback' }, UI);
    expect(ok.slug).toBe('rollback');
    expect(d.roadmap.phasesOf(ok.id)).toHaveLength(0);
  });
});

describe('A8: time formats in real imports', () => {
  const accept: [string, string][] = [
    ['2024-02-29', '2024-02-29T12:00:00.000Z'],
    ['2026-03-01T10:00:00Z', '2026-03-01T10:00:00.000Z'],
    ['2026-03-01T10:00:00.123456+01:00', '2026-03-01T09:00:00.123Z'],
    ['2026-03-29T02:30:00+02:00', '2026-03-29T00:30:00.000Z'],
    ['2026-10-25T02:30:00+01:00', '2026-10-25T01:30:00.000Z'],
  ];
  for (const [input, stored] of accept) {
    it(`accepts ${input}`, () => {
      t = makeDomain();
      const p = t.d.projects.create({ name: 'Tz' }, UI);
      expect(t.d.diary.addNote(p.id, { body: 'x', occurredAt: input }, UI).occurredAt).toBe(stored);
      const q = t.d.projects.create(
        {
          name: 'Tz2',
          phases: [{ title: 'A', tasks: [{ title: 'x', done: true, doneAt: input }] }],
        },
        UI,
      );
      expect(q.phases[0]!.tasks[0]!.doneAt).toBe(stored);
    });
  }

  // Mistakes that happen when copying dates from files: all must be clean validation errors.
  const refuse = [
    '2026-02-29', // not a leap year
    '2026-02-30T10:00:00Z', // impossible day
    '2026-04-31',
    '2026-03-01T10:00:00', // no offset: ambiguous
    '2026-03-01 10:00:00+01:00', // space instead of T (git log --date=iso)
    '01/03/2026',
    '',
  ];
  for (const input of refuse) {
    it(`refuses ${JSON.stringify(input)} with a validation error and writes nothing`, () => {
      t = makeDomain();
      const p = t.d.projects.create({ name: 'Tz' }, UI);
      const before = t.d.diary.list(p.id, { limit: 50 }).length;
      expectDomainError(
        () => t.d.diary.addNote(p.id, { body: 'x', occurredAt: input }, UI),
        'validation',
      );
      expect(t.d.diary.list(p.id, { limit: 50 })).toHaveLength(before);
      expectDomainError(
        () =>
          t.d.projects.create(
            {
              name: 'Bad',
              phases: [{ title: 'A', tasks: [{ title: 'x', done: true, doneAt: input }] }],
            },
            UI,
          ),
        'validation',
      );
      expect(t.d.projects.list().map((x) => x.name)).not.toContain('Bad');
    });
  }

  it('a date-only value for today, imported in the morning (UTC), is refused as future [documents current behaviour]', () => {
    // Clock: 2026-11-24T08:00Z (09:00 in Rome). "2026-11-24" is read as 12:00 UTC.
    t = makeDomain(Date.UTC(2026, 10, 24, 8));
    const p = t.d.projects.create({ name: 'Today' }, UI);
    const err = expectDomainError(
      () => t.d.diary.addNote(p.id, { body: 'x', occurredAt: '2026-11-24' }, UI),
      'validation',
    );
    expect(err.message).toContain('future');
    // Yesterday works.
    expect(
      t.d.diary.addNote(p.id, { body: 'y', occurredAt: iso(Date.UTC(2026, 10, 23, 12)) }, UI).body,
    ).toBe('y');
  });
});

describe('A8: backdated diary in normal use', () => {
  it('many out-of-order notes: ordering, keyset pagination over equal times, months', () => {
    t = makeDomain();
    const { d } = t;
    const p = d.projects.create({ name: 'Diario' }, UI);
    const dates = [
      '2026-03-10',
      '2026-01-05',
      '2026-03-10',
      '2026-02-20',
      '2026-03-10',
      '2026-01-05',
    ];
    dates.forEach((dt, i) => {
      d.diary.addNote(p.id, { body: `n${i}`, occurredAt: dt, origin: ORIGIN }, CLAUDE);
    });
    const all = d.diary.list(p.id, { limit: 50 });
    const times = all.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    // Page through 2 at a time: same set, no duplicates, nothing lost.
    const seen: number[] = [];
    let cursor: { before: string; beforeId: number } | undefined;
    for (;;) {
      const page = d.diary.list(p.id, { limit: 2, ...cursor });
      seen.push(...page.map((e) => e.id));
      const last = page.at(-1);
      if (page.length < 2 || !last) break;
      cursor = { before: last.occurredAt, beforeId: last.id };
    }
    expect(seen).toEqual(all.map((e) => e.id));
    const months = Object.fromEntries(d.diary.months(p.id).map((m) => [m.month, m.count]));
    expect(months).toMatchObject({ '2026-03': 3, '2026-02': 1, '2026-01': 2 });
  });

  it('last activity: backdated never moves it back, a later past time moves it forward', () => {
    t = makeDomain();
    const { d, clock } = t;
    const p = d.projects.create({ name: 'Act' }, UI);
    const created = Date.parse(p.lastActivityAt);
    clock.advance(10 * DAY_MS);
    d.diary.addNote(p.id, { body: 'old', occurredAt: '2020-01-01' }, UI);
    expect(Date.parse(d.projects.get(p.id).lastActivityAt)).toBe(created);
    const mid = created + 3 * DAY_MS;
    d.diary.addNote(p.id, { body: 'mid', occurredAt: iso(mid) }, UI);
    expect(Date.parse(d.projects.get(p.id).lastActivityAt)).toBe(mid);
    d.diary.addNote(p.id, { body: 'now' }, UI);
    expect(Date.parse(d.projects.get(p.id).lastActivityAt)).toBe(clock.now);
    d.diary.addNote(p.id, { body: 'old again', occurredAt: iso(mid) }, UI);
    expect(Date.parse(d.projects.get(p.id).lastActivityAt)).toBe(clock.now);
  });

  it('diaryLine marks imported entries and keeps plain ones unchanged', () => {
    t = makeDomain();
    const { d } = t;
    const p = d.projects.create({ name: 'Line' }, UI);
    const a = d.diary.addNote(
      p.id,
      { body: 'Imported', occurredAt: '2026-01-01', origin: `  ${ORIGIN}\nsecond line  ` },
      CLAUDE,
    );
    const b = d.diary.addNote(p.id, { body: 'Plain' }, CLAUDE);
    expect(diaryLine(a)).toContain('· imported (');
    expect(diaryLine(a)).not.toContain('\n');
    expect(diaryLine(b)).not.toContain('imported');
  });

  it('origin is trimmed, 200 chars accepted, 201 refused', () => {
    t = makeDomain();
    const { d } = t;
    const p = d.projects.create({ name: 'O', origin: `  ${ORIGIN}  ` }, UI);
    expect(p.origin).toBe(ORIGIN);
    expect(d.diary.addNote(p.id, { body: 'x', origin: 'a'.repeat(200) }, UI).origin).toHaveLength(
      200,
    );
    expectDomainError(
      () => d.diary.addNote(p.id, { body: 'x', origin: 'a'.repeat(201) }, UI),
      'validation',
    );
  });
});
