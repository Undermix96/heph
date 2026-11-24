import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM, UI } from './context.js';
import { CLAUDE, expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { iso } from './util.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  return { ...t, p };
}

describe('diary', () => {
  it('exposes no way to edit or delete entries (append-only)', () => {
    const { d } = setup();
    const svc = d.diary as unknown as Record<string, unknown>;
    for (const m of ['update', 'edit', 'delete', 'remove']) expect(svc[m]).toBeUndefined();
  });

  it('stores notes from a Claude session as type session, others as note', () => {
    const { d, p } = setup();
    const s = d.diary.addNote(p.id, { body: '  Wired the trigger  ' }, CLAUDE);
    expect(s).toMatchObject({
      type: 'session',
      body: 'Wired the trigger',
      source: 'claude_code',
      sessionId: 'sess-1',
    });
    expect(d.diary.addNote(p.id, { body: 'x' }, { source: 'claude_code' }).type).toBe('note');
    expect(d.diary.addNote(p.id, { body: 'y' }, UI).type).toBe('note');
    expect(d.diary.bySession('sess-1').map((e) => e.body)).toEqual(['Wired the trigger']);
  });

  it('rejects blank notes', () => {
    const { d, p } = setup();
    expectDomainError(() => d.diary.addNote(p.id, { body: '   ' }, UI), 'validation');
  });

  it('generates events for project creation, task completion, status, next task', () => {
    const { d, p } = setup();
    const [schematic, bom] = p.phases[0]!.tasks;
    d.roadmap.completeTask(schematic!.id, UI);
    d.projects.setStatus(p.id, { status: 'on_hold', note: 'Parts' }, UI);
    d.roadmap.setNextTask(p.id, p.phases[1]!.tasks[1]!.id, UI);
    const kinds = d.diary.list(p.id).map((e) => e.eventKind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'project_created',
        'task_completed',
        'status_changed',
        'next_task_changed',
      ]),
    );
    const done = d.diary.list(p.id).find((e) => e.eventKind === 'task_completed')!;
    expect(done.body).toContain('Schematic');
    expect(done.data).toMatchObject({ taskId: schematic!.id, nextTaskId: bom!.id });
  });

  it('lists newest first and paginates with before', () => {
    const { d, p, clock } = setup();
    for (let i = 1; i <= 5; i++) {
      clock.advance(1000);
      d.diary.addNote(p.id, { body: `note ${i}` }, UI);
    }
    const page1 = d.diary.list(p.id, { type: 'note', limit: 2 });
    expect(page1.map((e) => e.body)).toEqual(['note 5', 'note 4']);
    const page2 = d.diary.list(p.id, {
      type: 'note',
      limit: 2,
      before: page1.at(-1)!.occurredAt,
      beforeId: page1.at(-1)!.id,
    });
    expect(page2.map((e) => e.body)).toEqual(['note 3', 'note 2']);
    const page3 = d.diary.list(p.id, { type: 'note', limit: 2, before: page2.at(-1)!.occurredAt });
    expect(page3.map((e) => e.body)).toEqual(['note 1']);
  });

  it('does not lose entries sharing a timestamp across a page boundary', () => {
    const { d, p } = setup();
    for (let i = 1; i <= 3; i++) d.diary.addNote(p.id, { body: `same ms ${i}` }, UI);
    const page1 = d.diary.list(p.id, { type: 'note', limit: 2 });
    const last = page1.at(-1)!;
    const page2 = d.diary.list(p.id, {
      type: 'note',
      limit: 2,
      before: last.occurredAt,
      beforeId: last.id,
    });
    expect([...page1, ...page2].map((e) => e.body).sort()).toEqual([
      'same ms 1',
      'same ms 2',
      'same ms 3',
    ]);
  });

  it('filters by source and type and across projects', () => {
    const { d, p } = setup();
    const q = seedProject(d, { name: 'Other' });
    d.diary.addNote(p.id, { body: 'from claude' }, CLAUDE);
    d.diary.addNote(q.id, { body: 'from ui' }, UI);
    expect(d.diary.list(p.id, { source: 'claude_code' }).map((e) => e.body)).toEqual([
      'from claude',
    ]);
    expect(d.diary.list(null, { type: 'note' }).map((e) => e.body)).toEqual(['from ui']);
    expect(d.diary.list(null, { type: 'event' }).length).toBe(2);
    expect(d.diary.list(q.slug).every((e) => e.projectId === q.id)).toBe(true);
  });

  it('bumps last activity to the entry time, except for system entries', () => {
    const { d, p, clock } = setup();
    clock.advance(10_000);
    d.diary.append(p.id, { type: 'event', eventKind: 'commits', body: 'sys' }, SYSTEM);
    expect(d.projects.get(p.id).lastActivityAt).toBe(p.lastActivityAt);
    d.diary.addNote(p.id, { body: 'user' }, UI);
    expect(d.projects.get(p.id).lastActivityAt).toBe(iso(clock.now));
  });

  it('attaching files of another project is rejected', () => {
    const { d, p } = setup();
    expectDomainError(
      () => d.diary.addNote(p.id, { body: 'x', fileIds: [12345] }, UI),
      'validation',
    );
  });
});
