import type { RestructureOp } from '@heph/schema';
import { count, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type Ctx, UI } from './context.js';
import { changeLog, diaryEntries, phases, projects, tasks } from './db/schema.js';
import type { Domain } from './domain.js';
import type { RestructurePayload } from './restructure.js';
import { outline } from './restructure.js';
import {
  CLAUDE,
  CLAUDE_CONFIRMED,
  expectDomainError,
  seedProject,
  taskIds,
  writeTemp,
} from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  const [[schematic, bom], [caseId, wiring]] = taskIds(t.d, p.id) as [number[], number[]];
  const [design, build] = p.phases.map((x) => x.id) as [number, number];
  return {
    ...t,
    p,
    design,
    build,
    schematic: schematic!,
    bom: bom!,
    caseId: caseId!,
    wiring: wiring!,
  };
}

function run(d: Domain, projectId: number, operations: unknown[], ctx: Ctx = UI) {
  const r = d.restructure.restructure(projectId, { operations }, ctx);
  if (!r.applied) throw new Error('expected the batch to be applied');
  return r.result;
}

/** Titles by phase: `[['Design', 'Schematic', 'BOM'], …]`. */
function shape(d: Domain, projectId: number): string[][] {
  return d.roadmap.phasesOf(projectId).map((p) => [p.title, ...p.tasks.map((x) => x.title)]);
}

function counts(d: Domain) {
  const n = (table: typeof phases | typeof tasks | typeof diaryEntries | typeof changeLog) =>
    d.db.select({ n: count() }).from(table).get()!.n;
  return {
    phases: n(phases),
    tasks: n(tasks),
    diary: n(diaryEntries),
    changeLog: n(changeLog),
  };
}

/** Full snapshot of roadmap rows (positions, statuses, titles) for "nothing changed" checks. */
function snapshot(d: Domain) {
  return {
    phases: d.db.select().from(phases).all(),
    tasks: d.db.select().from(tasks).all(),
    projects: d.db.select().from(projects).all(),
    counts: counts(d),
  };
}

describe('outline', () => {
  it('numbers phases and tasks and marks done ones', () => {
    const { d, p, schematic } = setup();
    d.roadmap.completeTask(schematic, UI);
    expect(outline(d.roadmap.phasesOf(p.id))).toEqual([
      '1. Design',
      '   1.1 [x] Schematic',
      '   1.2 [ ] BOM',
      '2. Build',
      '   2.1 [ ] Case',
      '   2.2 [ ] Wiring',
    ]);
    expect(outline([])).toEqual([]);
  });
});

describe('restructure: operations', () => {
  it('add_phase appends, or inserts at a position', () => {
    const { d, p } = setup();
    run(d, p.id, [
      { op: 'add_phase', title: 'Test' },
      { op: 'add_phase', title: 'Research', position: 0, description: 'Read papers' },
    ]);
    expect(shape(d, p.id).map((x) => x[0])).toEqual(['Research', 'Design', 'Build', 'Test']);
    const research = d.roadmap.phasesOf(p.id)[0]!;
    expect(research.description).toBe('Read papers');
    expect(d.roadmap.phasesOf(p.id).map((x) => x.position)).toEqual([0, 1, 2, 3]);
  });

  it('update_phase by id and by ref', () => {
    const { d, p, design } = setup();
    run(d, p.id, [
      { op: 'update_phase', phase: design, title: 'Design v2', description: 'New' },
      { op: 'add_phase', ref: 'n', title: 'Draft' },
      { op: 'update_phase', phase: 'n', title: 'Final' },
    ]);
    const ps = d.roadmap.phasesOf(p.id);
    expect(ps.map((x) => x.title)).toEqual(['Design v2', 'Build', 'Final']);
    expect(ps[0]!.description).toBe('New');
  });

  it('move_phase by id and by ref', () => {
    const { d, p, build } = setup();
    run(d, p.id, [
      { op: 'move_phase', phase: build, position: 0 },
      { op: 'add_phase', ref: 'x', title: 'X' },
      { op: 'move_phase', phase: 'x', position: 1 },
    ]);
    expect(shape(d, p.id).map((x) => x[0])).toEqual(['Build', 'X', 'Design']);
    expect(d.roadmap.phasesOf(p.id).map((x) => x.position)).toEqual([0, 1, 2]);
  });

  it('delete_phase removes the phase and its tasks and renumbers', () => {
    const { d, p, design } = setup();
    run(d, p.id, [{ op: 'delete_phase', phaseId: design }]);
    expect(shape(d, p.id)).toEqual([['Build', 'Case', 'Wiring']]);
    expect(d.roadmap.phasesOf(p.id)[0]!.position).toBe(0);
    expect(counts(d).tasks).toBe(2);
  });

  it('add_task by phase id, by ref and at a position', () => {
    const { d, p, design } = setup();
    run(d, p.id, [
      { op: 'add_task', phase: design, title: 'Simulate', notes: 'LTspice' },
      { op: 'add_task', phase: design, title: 'Research', position: 0 },
      { op: 'add_phase', ref: 'test', title: 'Test' },
      { op: 'add_task', phase: 'test', title: 'Weld strips' },
      { op: 'add_task', phase: 'test', title: 'Measure', position: 0 },
    ]);
    expect(shape(d, p.id)).toEqual([
      ['Design', 'Research', 'Schematic', 'BOM', 'Simulate'],
      ['Build', 'Case', 'Wiring'],
      ['Test', 'Measure', 'Weld strips'],
    ]);
    const simulate = d.roadmap.phasesOf(p.id)[0]!.tasks[3]!;
    expect(simulate.notes).toBe('LTspice');
  });

  it('update_task changes title and notes', () => {
    const { d, p, bom } = setup();
    run(d, p.id, [{ op: 'update_task', taskId: bom, title: 'Bill of materials', notes: 'xlsx' }]);
    expect(d.roadmap.getTask(bom)).toMatchObject({ title: 'Bill of materials', notes: 'xlsx' });
  });

  it('move_task within a phase, to another phase by id, and to a ref', () => {
    const { d, p, build, schematic, bom, wiring } = setup();
    run(d, p.id, [
      { op: 'move_task', taskId: bom, position: 0 },
      { op: 'move_task', taskId: schematic, phase: build, position: 0 },
      { op: 'add_phase', ref: 'later', title: 'Later' },
      { op: 'move_task', taskId: wiring, phase: 'later', position: 0 },
    ]);
    expect(shape(d, p.id)).toEqual([
      ['Design', 'BOM'],
      ['Build', 'Schematic', 'Case'],
      ['Later', 'Wiring'],
    ]);
    for (const ph of d.roadmap.phasesOf(p.id)) {
      expect(ph.tasks.map((x) => x.position)).toEqual(ph.tasks.map((_, i) => i));
    }
  });

  it('delete_task removes the task and renumbers its phase', () => {
    const { d, p, schematic } = setup();
    run(d, p.id, [{ op: 'delete_task', taskId: schematic }]);
    expect(shape(d, p.id)[0]).toEqual(['Design', 'BOM']);
    expect(d.roadmap.phasesOf(p.id)[0]!.tasks[0]!.position).toBe(0);
  });

  it('a phase becomes done when its only open task is deleted, and back when one is added', () => {
    const { d, p, schematic, bom, design } = setup();
    d.roadmap.completeTask(schematic, UI);
    run(d, p.id, [{ op: 'delete_task', taskId: bom }]);
    expect(d.roadmap.phasesOf(p.id)[0]!.status).toBe('done');
    run(d, p.id, [{ op: 'add_task', phase: design, title: 'More' }]);
    expect(d.roadmap.phasesOf(p.id)[0]!.status).toBe('in_progress');
  });

  it('returns the resulting roadmap', () => {
    const { d, p } = setup();
    const result = run(d, p.id, [{ op: 'add_phase', title: 'Test' }]);
    expect(result.map((x) => x.title)).toEqual(['Design', 'Build', 'Test']);
  });
});

describe('restructure: validation', () => {
  function expectOpError(fn: () => unknown, index: number, fragment: string) {
    const e = expectDomainError(fn, 'validation');
    expect(e.message).toContain(`operations[${index}]`);
    expect(e.message).toContain(fragment);
  }

  it('rejects an empty or malformed batch', () => {
    const { d, p } = setup();
    expectDomainError(() => d.restructure.restructure(p.id, { operations: [] }, UI), 'validation');
    expectDomainError(
      () => d.restructure.restructure(p.id, { operations: [{ op: 'explode' }] }, UI),
      'validation',
    );
    expectDomainError(
      () => d.restructure.restructure(p.id, { operations: [{ op: 'add_phase', title: ' ' }] }, UI),
      'validation',
    );
  });

  it('unknown ref', () => {
    const { d, p } = setup();
    expectOpError(
      () =>
        run(d, p.id, [
          { op: 'add_phase', ref: 'a', title: 'A' },
          { op: 'add_task', phase: 'b', title: 'x' },
        ]),
      1,
      'unknown phase ref "b"',
    );
  });

  it('a ref used before it is defined is unknown', () => {
    const { d, p } = setup();
    expectOpError(
      () =>
        run(d, p.id, [
          { op: 'update_phase', phase: 'a', title: 'Z' },
          { op: 'add_phase', ref: 'a', title: 'A' },
        ]),
      0,
      'unknown phase ref "a"',
    );
  });

  it('duplicate ref', () => {
    const { d, p } = setup();
    expectOpError(
      () =>
        run(d, p.id, [
          { op: 'add_phase', ref: 'a', title: 'A' },
          { op: 'add_phase', ref: 'a', title: 'B' },
        ]),
      1,
      'duplicate phase ref "a"',
    );
  });

  it('ids from another project', () => {
    const { d, p } = setup();
    const other = seedProject(d, { name: 'Other' });
    const [otherPhase] = other.phases.map((x) => x.id);
    const otherTask = other.phases[0]!.tasks[0]!.id;
    const cases: [RestructureOp, string][] = [
      { op: 'update_phase', phase: otherPhase!, title: 'x' },
      { op: 'move_phase', phase: otherPhase!, position: 0 },
      { op: 'delete_phase', phaseId: otherPhase! },
      { op: 'add_task', phase: otherPhase!, title: 'x' },
      { op: 'update_task', taskId: otherTask, title: 'x' },
      { op: 'move_task', taskId: otherTask, position: 0 },
      { op: 'delete_task', taskId: otherTask },
    ].map((op) => [
      op as RestructureOp,
      'taskId' in op ? `task #${otherTask}` : `phase #${otherPhase}`,
    ]);
    for (const [op, what] of cases) {
      expectOpError(
        () => run(d, p.id, [{ op: 'add_phase', title: 'Pad' }, op]),
        1,
        `${what} belongs to another project`,
      );
    }
    // Moving one of our tasks into another project's phase.
    const ours = p.phases[0]!.tasks[0]!.id;
    expectOpError(
      () => run(d, p.id, [{ op: 'move_task', taskId: ours, phase: otherPhase, position: 0 }]),
      0,
      `phase #${otherPhase} belongs to another project`,
    );
    expect(shape(d, other.id)).toEqual(shape(d, p.id).map((x) => x));
  });

  it('nonexistent ids', () => {
    const { d, p } = setup();
    const ops: [RestructureOp, string][] = [
      [{ op: 'update_phase', phase: 9999, title: 'x' }, 'phase #9999 does not exist'],
      [{ op: 'move_phase', phase: 9999, position: 0 }, 'phase #9999 does not exist'],
      [{ op: 'delete_phase', phaseId: 9999 }, 'phase #9999 does not exist'],
      [{ op: 'add_task', phase: 9999, title: 'x' }, 'phase #9999 does not exist'],
      [{ op: 'update_task', taskId: 9999, title: 'x' }, 'task #9999 does not exist'],
      [{ op: 'move_task', taskId: 9999, position: 0 }, 'task #9999 does not exist'],
      [{ op: 'delete_task', taskId: 9999 }, 'task #9999 does not exist'],
    ];
    for (const [op, msg] of ops) {
      expectOpError(() => run(d, p.id, [{ op: 'add_phase', title: 'Pad' }, op]), 1, msg);
    }
  });

  it('rejects digit-only refs, which would be ambiguous with phase ids', () => {
    const { d, p } = setup();
    expectDomainError(
      () => run(d, p.id, [{ op: 'add_phase', ref: '2', title: 'New' }]),
      'validation',
    );
    expectDomainError(
      () => run(d, p.id, [{ op: 'add_task', phase: '2', title: 'In new' }]),
      'validation',
    );
  });

  it('an id deleted earlier in the same batch no longer exists', () => {
    const { d, p, design, schematic } = setup();
    expectOpError(
      () =>
        run(d, p.id, [
          { op: 'delete_phase', phaseId: design },
          { op: 'update_task', taskId: schematic, title: 'x' },
        ]),
      1,
      `task #${schematic} does not exist`,
    );
  });

  it('is atomic: a failing last op leaves nothing applied', () => {
    const { d, p, design, schematic, bom } = setup();
    const before = snapshot(d);
    expectOpError(
      () =>
        run(d, p.id, [
          { op: 'add_phase', ref: 'n', title: 'New' },
          { op: 'add_task', phase: 'n', title: 'T' },
          { op: 'delete_task', taskId: schematic },
          { op: 'update_task', taskId: bom, title: 'Renamed' },
          { op: 'delete_phase', phaseId: design },
          { op: 'update_task', taskId: 9999, title: 'boom' },
        ]),
      5,
      'task #9999',
    );
    expect(snapshot(d)).toEqual(before);
  });

  it('is atomic for claude confirmed too', () => {
    const { d, p, schematic } = setup();
    const before = snapshot(d);
    expectDomainError(
      () =>
        run(
          d,
          p.id,
          [
            { op: 'delete_task', taskId: schematic },
            { op: 'add_task', phase: 'nope', title: 'x' },
          ],
          CLAUDE_CONFIRMED,
        ),
      'validation',
    );
    expect(snapshot(d)).toEqual(before);
  });

  it('an invalid batch from claude does not create a proposal', () => {
    const { d, p } = setup();
    expectOpError(
      () =>
        d.restructure.restructure(
          p.id,
          { operations: [{ op: 'delete_task', taskId: 9999 }] },
          CLAUDE,
        ),
      0,
      'task #9999',
    );
    expect(d.proposals.list(p.id)).toHaveLength(0);
  });

  it('claude cannot restructure a project with write access disabled', () => {
    const { d, p } = setup();
    d.projects.update(p.id, { claudeWriteEnabled: false }, UI);
    for (const ctx of [CLAUDE, CLAUDE_CONFIRMED]) {
      expectDomainError(
        () =>
          d.restructure.restructure(p.id, { operations: [{ op: 'add_phase', title: 'X' }] }, ctx),
        'forbidden',
      );
    }
    expect(d.proposals.list(p.id)).toHaveLength(0);
  });

  it('unknown project is not_found', () => {
    const { d } = setup();
    expectDomainError(
      () => d.restructure.restructure(9999, { operations: [{ op: 'add_phase', title: 'X' }] }, UI),
      'not_found',
    );
  });
});

describe('restructure: preview', () => {
  it('changes nothing and returns before/after outlines', () => {
    const { d, p, schematic, build } = setup();
    const before = snapshot(d);
    const preview = d.restructure.preview(
      p.id,
      [
        { op: 'add_phase', ref: 't', title: 'Test', position: 0 },
        { op: 'add_task', phase: 't', title: 'Weld' },
        { op: 'move_task', taskId: schematic, phase: build, position: 0 },
        { op: 'delete_phase', phaseId: p.phases[0]!.id },
      ],
      UI,
    );
    expect(preview.before).toEqual(outline(d.roadmap.phasesOf(p.id)));
    expect(preview.after).toEqual([
      '1. Test',
      '   1.1 [ ] Weld',
      '2. Build',
      '   2.1 [ ] Schematic',
      '   2.2 [ ] Case',
      '   2.3 [ ] Wiring',
    ]);
    expect(snapshot(d)).toEqual(before);
  });

  it('throws the same validation error as apply', () => {
    const { d, p } = setup();
    const before = snapshot(d);
    const e = expectDomainError(
      () => d.restructure.preview(p.id, [{ op: 'delete_task', taskId: 9999 }], UI),
      'validation',
    );
    expect(e.message).toContain('operations[0]');
    expect(snapshot(d)).toEqual(before);
  });
});

describe('restructure: gating', () => {
  const ops = (s: ReturnType<typeof setup>): RestructureOp[] => [
    { op: 'add_phase', ref: 'test', title: 'Testing' },
    { op: 'add_task', phase: 'test', title: 'Weld strips' },
    { op: 'delete_task', taskId: s.wiring },
  ];

  it('claude without confirmed creates a proposal with operations and before/after', () => {
    const s = setup();
    const { d, p } = s;
    const before = snapshot(d);
    const r = d.restructure.restructure(p.id, { operations: ops(s), reason: 'Split' }, CLAUDE);
    expect(r.applied).toBe(false);
    if (r.applied) return;
    expect(r.proposal).toMatchObject({
      kind: 'restructure_roadmap',
      state: 'pending',
      reason: 'Split',
      createdBy: 'claude_code',
      sessionId: 'sess-1',
    });
    const payload = r.proposal.payload as unknown as RestructurePayload;
    expect(payload.operations).toEqual(ops(s));
    expect(payload.before).toEqual(outline(d.roadmap.phasesOf(p.id)));
    expect(payload.after).toEqual([
      '1. Design',
      '   1.1 [ ] Schematic',
      '   1.2 [ ] BOM',
      '2. Build',
      '   2.1 [ ] Case',
      '3. Testing',
      '   3.1 [ ] Weld strips',
    ]);
    // Roadmap untouched; no restructure event.
    const now = snapshot(d);
    expect(now.phases).toEqual(before.phases);
    expect(now.tasks).toEqual(before.tasks);
    expect(d.diary.list(p.id).map((e) => e.eventKind)).not.toContain('roadmap_restructured');
    expect(d.proposals.get(r.proposal.id).payload).toEqual(r.proposal.payload);
  });

  it('a proposal stores an empty reason when none is given', () => {
    const s = setup();
    const r = s.d.restructure.restructure(s.p.id, { operations: ops(s) }, CLAUDE);
    if (r.applied) throw new Error('expected a proposal');
    expect(r.proposal.reason).toBe('');
  });

  it('claude confirmed applies directly with one roadmap_restructured event', () => {
    const s = setup();
    const { d, p } = s;
    const diaryBefore = counts(d).diary;
    const before = outline(d.roadmap.phasesOf(p.id));
    const r = d.restructure.restructure(p.id, { operations: ops(s) }, CLAUDE_CONFIRMED);
    expect(r.applied).toBe(true);
    expect(shape(d, p.id)).toEqual([
      ['Design', 'Schematic', 'BOM'],
      ['Build', 'Case'],
      ['Testing', 'Weld strips'],
    ]);
    expect(counts(d).diary).toBe(diaryBefore + 1);
    const events = d.diary.list(p.id).filter((e) => e.eventKind === 'roadmap_restructured');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'claude_code',
      sessionId: 'sess-1',
      body: 'Roadmap restructured (3 operations)',
    });
    expect(events[0]!.data).toMatchObject({
      operations: 3,
      before,
      after: outline(d.roadmap.phasesOf(p.id)),
      confirmedInChat: true,
    });
    expect(d.proposals.list(p.id)).toHaveLength(0);
  });

  it('UI applies directly, without the confirmedInChat flag', () => {
    const s = setup();
    const { d, p } = s;
    const r = d.restructure.restructure(p.id, { operations: [ops(s)[0]!] }, UI);
    expect(r.applied).toBe(true);
    const ev = d.diary.list(p.id).find((e) => e.eventKind === 'roadmap_restructured')!;
    expect(ev.body).toBe('Roadmap restructured (1 operation)');
    expect(ev.source).toBe('ui');
    expect(ev.data).not.toHaveProperty('confirmedInChat');
  });

  it('applied operations write no per-op diary events', () => {
    const s = setup();
    const { d, p } = s;
    run(d, p.id, [
      { op: 'delete_task', taskId: s.schematic },
      { op: 'delete_phase', phaseId: s.build },
    ]);
    const kinds = d.diary.list(p.id).map((e) => e.eventKind);
    expect(kinds).not.toContain('task_deleted');
    expect(kinds).not.toContain('phase_deleted');
    expect(kinds.filter((k) => k === 'roadmap_restructured')).toHaveLength(1);
  });

  it('approval applies the batch', () => {
    const s = setup();
    const { d, p } = s;
    const r = d.restructure.restructure(p.id, { operations: ops(s) }, CLAUDE);
    if (r.applied) throw new Error('expected a proposal');
    const decided = d.proposals.approve(r.proposal.id, { note: 'ok' }, UI);
    expect(decided.state).toBe('approved');
    expect(outline(d.roadmap.phasesOf(p.id))).toEqual(
      (r.proposal.payload as unknown as RestructurePayload).after,
    );
    const ev = d.diary.list(p.id).find((e) => e.eventKind === 'roadmap_restructured')!;
    expect(ev.source).toBe('ui');
    expect(ev.data).not.toHaveProperty('confirmedInChat');
  });

  it('only the user can approve', () => {
    const s = setup();
    const r = s.d.restructure.restructure(s.p.id, { operations: ops(s) }, CLAUDE);
    if (r.applied) throw new Error('expected a proposal');
    expectDomainError(
      () => s.d.proposals.approve(r.proposal.id, {}, CLAUDE_CONFIRMED),
      'forbidden',
    );
    expect(s.d.proposals.get(r.proposal.id).state).toBe('pending');
  });

  it('approval after the roadmap changed is a conflict and the proposal stays pending', () => {
    const s = setup();
    const { d, p } = s;
    const r = d.restructure.restructure(p.id, { operations: ops(s) }, CLAUDE);
    if (r.applied) throw new Error('expected a proposal');
    d.roadmap.deleteTask(s.wiring, UI);
    const before = snapshot(d);
    const e = expectDomainError(() => d.proposals.approve(r.proposal.id, {}, UI), 'conflict');
    expect(e.message).toContain('The roadmap changed since this proposal was made');
    expect(e.message).toContain('operations[2]');
    expect(e.message).toContain(`task #${s.wiring} does not exist`);
    expect(d.proposals.get(r.proposal.id)).toMatchObject({ state: 'pending', decidedAt: null });
    expect(snapshot(d)).toEqual(before);
    // It can still be rejected afterwards.
    expect(d.proposals.reject(r.proposal.id, {}, UI).state).toBe('rejected');
  });

  it('approval after a referenced phase was deleted is a conflict', () => {
    const s = setup();
    const { d, p } = s;
    const r = d.restructure.restructure(
      p.id,
      { operations: [{ op: 'add_task', phase: s.build, title: 'x' }] },
      CLAUDE,
    );
    if (r.applied) throw new Error('expected a proposal');
    d.roadmap.deletePhase(s.build, UI);
    expectDomainError(() => d.proposals.approve(r.proposal.id, {}, UI), 'conflict');
    expect(d.proposals.get(r.proposal.id).state).toBe('pending');
  });
});

describe('restructure: side effects', () => {
  it('deleting the next-task override inside a batch clears it', () => {
    const { d, p, bom, schematic } = setup();
    d.roadmap.setNextTask(p.id, bom, UI);
    expect(d.projects.get(p.id).nextTask).toMatchObject({ id: bom, overridden: true });
    run(d, p.id, [{ op: 'delete_task', taskId: bom }]);
    const row = d.db.select().from(projects).where(eq(projects.id, p.id)).get()!;
    expect(row.nextTaskOverrideId).toBeNull();
    expect(d.projects.get(p.id).nextTask).toMatchObject({ id: schematic, overridden: false });
  });

  it('deleting the phase holding the override clears it', () => {
    const { d, p, wiring, build, schematic } = setup();
    d.roadmap.setNextTask(p.id, wiring, UI);
    run(d, p.id, [{ op: 'delete_phase', phaseId: build }]);
    const row = d.db.select().from(projects).where(eq(projects.id, p.id)).get()!;
    expect(row.nextTaskOverrideId).toBeNull();
    expect(d.projects.get(p.id).nextTask?.id).toBe(schematic);
  });

  it('an override not touched by the batch is kept', () => {
    const { d, p, wiring, schematic } = setup();
    d.roadmap.setNextTask(p.id, wiring, UI);
    run(d, p.id, [{ op: 'delete_task', taskId: schematic }]);
    expect(d.projects.get(p.id).nextTask).toMatchObject({ id: wiring, overridden: true });
  });

  it('files of deleted tasks and phases move to project level', async () => {
    const { d, p, schematic, build } = setup();
    const onTask = await d.files.ingest(
      p.id,
      {
        tempPath: writeTemp(d, '# notes'),
        originalName: 'notes.md',
        declaredMime: 'text/markdown',
        target: { taskId: schematic },
      },
      UI,
    );
    const onPhase = await d.files.ingest(
      p.id,
      {
        tempPath: writeTemp(d, 'plan'),
        originalName: 'plan.txt',
        declaredMime: 'text/plain',
        target: { phaseId: build },
      },
      UI,
    );
    run(d, p.id, [
      { op: 'delete_task', taskId: schematic },
      { op: 'delete_phase', phaseId: build },
    ]);
    expect(d.files.get(onTask.id)).toMatchObject({ taskId: null });
    expect(d.files.get(onPhase.id)).toMatchObject({ phaseId: null, taskId: null });
    const projectLevel = d.files.list(p.id, { target: 'project' }).map((f) => f.id);
    expect(projectLevel).toContain(onPhase.id);
    expect(
      d.files
        .list(p.id)
        .map((f) => f.id)
        .sort(),
    ).toEqual([onTask.id, onPhase.id].sort());
  });

  it('files survive a preview and a pending proposal unchanged', async () => {
    const { d, p, schematic } = setup();
    const f = await d.files.ingest(
      p.id,
      {
        tempPath: writeTemp(d, 'x'),
        originalName: 'x.txt',
        declaredMime: 'text/plain',
        target: { taskId: schematic },
      },
      UI,
    );
    d.restructure.restructure(
      p.id,
      { operations: [{ op: 'delete_task', taskId: schematic }] },
      CLAUDE,
    );
    expect(d.files.get(f.id).taskId).toBe(schematic);
  });
});
