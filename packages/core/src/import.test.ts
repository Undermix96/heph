// Imported history (spec §13, D65): origin, backdated notes, tasks created already done.
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { CLAUDE, expectDomainError } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS, iso } from './util.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  return t;
}

const MIGRATION = 'migration 2026-11-24: docs/ROADMAP.md@abc1234';

describe('create_project with imported tasks', () => {
  it('creates done tasks with their time, no completion events, phase done at the last one', () => {
    const { d, clock } = setup();
    const p = d.projects.create(
      {
        name: 'Weather station',
        origin: MIGRATION,
        phases: [
          {
            title: 'Prototype',
            tasks: [
              { title: 'Breadboard', done: true, doneAt: '2026-03-01' },
              { title: 'Enclosure', done: true, doneAt: '2026-04-10T08:30:00+02:00' },
            ],
          },
          {
            title: 'Firmware',
            tasks: [
              { title: 'Sensors', done: true, notes: 'BME280 over I2C' },
              'OTA updates',
              { title: 'Deep sleep', done: false },
            ],
          },
        ],
      },
      CLAUDE,
    );
    expect(p.origin).toBe(MIGRATION);
    const [proto, fw] = p.phases;
    expect(proto!.status).toBe('done');
    expect(proto!.tasks.map((x) => x.doneAt)).toEqual([
      '2026-03-01T12:00:00.000Z',
      '2026-04-10T06:30:00.000Z',
    ]);
    expect(fw!.status).toBe('in_progress');
    expect(fw!.tasks.map((x) => [x.title, x.done])).toEqual([
      ['Sensors', true],
      ['OTA updates', false],
      ['Deep sleep', false],
    ]);
    // done without doneAt: completed "now" (the import time).
    expect(fw!.tasks[0]!.doneAt).toBe(iso(clock.now));
    expect(fw!.tasks[0]!.notes).toBe('BME280 over I2C');
    expect(p.nextTask?.title).toBe('OTA updates');
    expect(p.progress).toMatchObject({ done: 3, total: 5 });

    const kinds = d.diary.list(p.id, { limit: 50 }).map((e) => e.eventKind);
    expect(kinds).toEqual(['project_created']);

    const row = d.db.query.phases.findFirst({ where: (ph, { eq }) => eq(ph.id, proto!.id) }).sync();
    expect(iso(row!.completedAt)).toBe('2026-04-10T06:30:00.000Z');
  });

  it('a phase that is not done at import keeps completedAt empty', () => {
    const { d } = setup();
    const p = d.projects.create(
      {
        name: 'Half',
        phases: [{ title: 'A', tasks: [{ title: 'x', done: true, doneAt: '2026-01-01' }, 'y'] }],
      },
      UI,
    );
    const row = d.db.query.phases
      .findFirst({ where: (ph, { eq }) => eq(ph.id, p.phases[0]!.id) })
      .sync();
    expect(row!.completedAt).toBeNull();
  });

  it('refuses a doneAt in the future and creates nothing', () => {
    const { d, clock } = setup();
    expectDomainError(
      () =>
        d.projects.create(
          {
            name: 'Future',
            phases: [
              { title: 'A', tasks: [{ title: 'x', done: true, doneAt: iso(clock.now + DAY_MS) }] },
            ],
          },
          CLAUDE,
        ),
      'validation',
    );
    expect(d.projects.list().map((x) => x.name)).not.toContain('Future');
  });

  it('refuses doneAt without done: true, and invalid times', () => {
    const { d } = setup();
    for (const task of [
      { title: 'x', doneAt: '2026-01-01' },
      { title: 'x', done: false, doneAt: '2026-01-01' },
      { title: 'x', done: true, doneAt: 'yesterday' },
      { title: 'x', done: true, doneAt: '2026-13-01' },
    ]) {
      expectDomainError(
        () => d.projects.create({ name: 'Bad', phases: [{ title: 'A', tasks: [task] }] }, UI),
        'validation',
      );
    }
  });

  it('an empty or blank origin is refused; a missing one stays null', () => {
    const { d } = setup();
    expectDomainError(() => d.projects.create({ name: 'O', origin: '  ' }, UI), 'validation');
    expect(d.projects.create({ name: 'Plain' }, UI).origin).toBeNull();
  });
});

describe('log_progress with imported history', () => {
  it('stores a backdated note with its origin, ordered by when it happened', () => {
    const { d, clock } = setup();
    const p = d.projects.create({ name: 'Diary' }, UI);
    const before = d.projects.get(p.id).lastActivityAt;
    const old = d.diary.addNote(
      p.id,
      { body: 'Soldered the board', occurredAt: '2026-02-03', origin: MIGRATION },
      CLAUDE,
    );
    clock.advance(1000);
    d.diary.addNote(p.id, { body: 'Today' }, CLAUDE);
    expect(old.occurredAt).toBe('2026-02-03T12:00:00.000Z');
    expect(old.origin).toBe(MIGRATION);
    const list = d.diary.list(p.id, { limit: 50 });
    expect(list.map((e) => e.body)).toEqual([
      'Today',
      'Project created: Diary',
      'Soldered the board',
    ]);
    expect(list[0]!.origin).toBeNull();
    // A backdated entry never moves last activity backwards.
    expect(Date.parse(d.projects.get(p.id).lastActivityAt)).toBeGreaterThanOrEqual(
      Date.parse(before),
    );
  });

  it('a backdated note from a session is imported history, not part of the session', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'Sess' }, UI);
    const old = d.diary.addNote(p.id, { body: 'old', occurredAt: '2025-01-02' }, CLAUDE);
    const now = d.diary.addNote(p.id, { body: 'now' }, CLAUDE);
    expect([old.type, old.sessionId, old.source]).toEqual(['note', null, 'claude_code']);
    expect([now.type, now.sessionId]).toEqual(['session', 'sess-1']);
  });

  it('refuses a note in the future', () => {
    const { d, clock } = setup();
    const p = d.projects.create({ name: 'F' }, UI);
    expectDomainError(
      () => d.diary.addNote(p.id, { body: 'x', occurredAt: iso(clock.now + 60_000) }, UI),
      'validation',
    );
    // Exactly now is fine.
    expect(d.diary.addNote(p.id, { body: 'y', occurredAt: iso(clock.now) }, UI).body).toBe('y');
  });

  it('accepts offsets and keeps the instant', () => {
    const { d } = setup();
    const p = d.projects.create({ name: 'Tz' }, UI);
    const e = d.diary.addNote(p.id, { body: 'x', occurredAt: '2026-05-01T23:30:00-02:00' }, UI);
    expect(e.occurredAt).toBe('2026-05-02T01:30:00.000Z');
  });
});
