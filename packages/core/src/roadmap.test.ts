import type { PhaseView } from '@heph/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { computeNextTask, syncedPhaseStatus } from './roadmap.js';
import {
  CLAUDE,
  CLAUDE_CONFIRMED,
  expectDomainError,
  seedProject,
  taskIds,
} from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  const [[schematic, bom], [kase, wiring]] = taskIds(t.d, p.id) as [number[], number[]];
  const [design, build] = p.phases.map((x) => x.id) as [number, number];
  return { ...t, p, schematic: schematic!, bom: bom!, kase: kase!, wiring: wiring!, design, build };
}

const phaseStatus = (s: ReturnType<typeof setup>, id: number) =>
  s.d.roadmap.phasesOf(s.p.id).find((x) => x.id === id)?.status;

describe('computeNextTask (pure)', () => {
  const view = (id: number, status: PhaseView['status'], tasks: [number, boolean][]) =>
    ({
      id,
      projectId: 1,
      title: `P${id}`,
      description: '',
      position: id,
      status,
      completedAt: null,
      progress: { done: 0, total: 0, ratio: 0 },
      tasks: tasks.map(([tid, done], i) => ({
        id: tid,
        phaseId: id,
        projectId: 1,
        title: `T${tid}`,
        notes: '',
        position: i,
        done,
        doneAt: null,
        link: null,
        createdAt: 0,
        updatedAt: 0,
      })),
      createdAt: 0,
      updatedAt: 0,
    }) satisfies PhaseView;

  it('returns null with no phases or only empty phases', () => {
    expect(computeNextTask([], null)).toBeNull();
    expect(computeNextTask([view(1, 'todo', [])], null)).toBeNull();
  });

  it('skips done phases even with open tasks', () => {
    const r = computeNextTask(
      [view(1, 'done', [[10, false]]), view(2, 'todo', [[20, false]])],
      null,
    );
    expect(r).toMatchObject({ id: 20, phaseId: 2, overridden: false });
  });

  it('skips non-done phases with no open task', () => {
    const r = computeNextTask(
      [view(1, 'in_progress', [[10, true]]), view(2, 'todo', [[20, false]])],
      null,
    );
    expect(r?.id).toBe(20);
  });

  it('uses the override when it points to an open task, else falls back', () => {
    const phases = [
      view(1, 'todo', [
        [10, false],
        [11, false],
        [12, true],
      ]),
    ];
    expect(computeNextTask(phases, 11)).toMatchObject({ id: 11, overridden: true });
    expect(computeNextTask(phases, 12)).toMatchObject({ id: 10, overridden: false });
    expect(computeNextTask(phases, 999)).toMatchObject({ id: 10, overridden: false });
  });
});

describe('syncedPhaseStatus (pure)', () => {
  it('keeps the current status for an empty phase', () => {
    expect(syncedPhaseStatus('done', [])).toBe('done');
    expect(syncedPhaseStatus('todo', [])).toBe('todo');
  });
  it('all done → done', () => {
    expect(syncedPhaseStatus('todo', [{ done: true }, { done: true }])).toBe('done');
  });
  it('reopened in a done phase → in_progress or todo', () => {
    expect(syncedPhaseStatus('done', [{ done: true }, { done: false }])).toBe('in_progress');
    expect(syncedPhaseStatus('done', [{ done: false }])).toBe('todo');
  });
  it('some done → in_progress; none done keeps an explicit status', () => {
    expect(syncedPhaseStatus('todo', [{ done: true }, { done: false }])).toBe('in_progress');
    expect(syncedPhaseStatus('in_progress', [{ done: false }])).toBe('in_progress');
    expect(syncedPhaseStatus('todo', [{ done: false }])).toBe('todo');
  });
});

describe('next task', () => {
  it('defaults to the first open task of the first non-done phase', () => {
    const s = setup();
    expect(s.p.nextTask).toMatchObject({ id: s.schematic, phaseId: s.design, overridden: false });
    const r = s.d.roadmap.completeTask(s.schematic, CLAUDE);
    expect(r.nextTask?.id).toBe(s.bom);
    expect(s.d.roadmap.completeTask(s.bom, CLAUDE).nextTask).toMatchObject({
      id: s.kase,
      phaseTitle: 'Build',
    });
  });

  it('honours an override and clears it when the overridden task is completed', () => {
    const s = setup();
    const r = s.d.roadmap.setNextTask(s.p.id, s.wiring, CLAUDE);
    expect(r).toMatchObject({ id: s.wiring, overridden: true });
    expect(s.d.projects.get(s.p.id).nextTask?.id).toBe(s.wiring);
    const done = s.d.roadmap.completeTask(s.wiring, CLAUDE);
    expect(done.nextTask).toMatchObject({ id: s.schematic, overridden: false });
    // Reopening the task does not bring the override back.
    s.d.roadmap.reopenTask(s.wiring, UI);
    expect(s.d.projects.get(s.p.id).nextTask?.id).toBe(s.schematic);
  });

  it('clears the override with null and logs next_task_changed only on change', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.kase, UI);
    expect(s.d.roadmap.setNextTask(s.p.id, null, UI)?.id).toBe(s.schematic);
    // Overriding to the task that is already next changes nothing visible.
    s.d.roadmap.setNextTask(s.p.id, s.schematic, UI);
    const events = s.d.diary.list(s.p.id).filter((e) => e.eventKind === 'next_task_changed');
    expect(events.map((e) => e.data)).toEqual([
      { fromTaskId: s.kase, toTaskId: s.schematic },
      { fromTaskId: s.schematic, toTaskId: s.kase },
    ]);
  });

  it('rejects an override on a completed task or another project task', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, UI);
    expectDomainError(() => s.d.roadmap.setNextTask(s.p.id, s.bom, UI), 'validation');
    const other = seedProject(s.d, { name: 'Other' });
    const otherTask = other.phases[0]!.tasks[0]!.id;
    expectDomainError(() => s.d.roadmap.setNextTask(s.p.id, otherTask, UI), 'validation');
    expectDomainError(() => s.d.roadmap.setNextTask(s.p.id, 9999, UI), 'not_found');
  });

  it('is null when every task is done (no next step) and for a project without phases', () => {
    const s = setup();
    for (const id of [s.schematic, s.bom, s.kase]) s.d.roadmap.completeTask(id, UI);
    expect(s.d.roadmap.completeTask(s.wiring, UI).nextTask).toBeNull();
    const view = s.d.projects.get(s.p.id);
    expect(view.nextTask).toBeNull();
    expect(view.badge.kind).toBe('no_next_step');
    expect(view.currentPhase).toBeNull();
    const empty = s.d.projects.create({ name: 'Empty' }, UI);
    expect(empty.nextTask).toBeNull();
    const withEmptyPhase = s.d.projects.create({ name: 'E2', phases: [{ title: 'Only' }] }, UI);
    expect(withEmptyPhase.nextTask).toBeNull();
    expect(withEmptyPhase.currentPhase?.title).toBe('Only');
  });

  it('skips a phase explicitly marked done', () => {
    const s = setup();
    s.d.roadmap.updatePhase(s.design, { status: 'done' }, UI);
    expect(s.d.projects.get(s.p.id).nextTask?.id).toBe(s.kase);
    expect(s.d.projects.get(s.p.id).currentPhase?.id).toBe(s.build);
  });

  it('clears the override when the overridden task is deleted', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    s.d.roadmap.deleteTask(s.wiring, UI);
    expect(s.d.projects.get(s.p.id).nextTask).toMatchObject({ id: s.schematic, overridden: false });
    // A new task must not inherit a stale override id.
    s.d.roadmap.setNextTask(s.p.id, s.kase, UI);
    s.d.roadmap.deletePhase(s.build, UI);
    expect(s.d.projects.get(s.p.id).nextTask?.overridden).toBe(false);
  });

  it('completing a task twice is a no-op and logs once', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.completeTask(s.schematic, UI);
    const ev = s.d.diary.list(s.p.id).filter((e) => e.eventKind === 'task_completed');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ taskId: s.schematic, nextTaskId: s.bom });
  });
});

describe('phase status sync', () => {
  it('becomes done when all tasks are done, and in_progress on the first', () => {
    const s = setup();
    expect(phaseStatus(s, s.design)).toBe('todo');
    s.d.roadmap.completeTask(s.schematic, UI);
    expect(phaseStatus(s, s.design)).toBe('in_progress');
    s.d.roadmap.completeTask(s.bom, UI);
    const design = s.d.roadmap.getPhase(s.design);
    expect(design.status).toBe('done');
    expect(design.completedAt).toBe(s.clock.now);
  });

  it('reopening a task moves a done phase back to in_progress (or todo)', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.completeTask(s.bom, UI);
    s.d.roadmap.reopenTask(s.bom, UI);
    expect(phaseStatus(s, s.design)).toBe('in_progress');
    expect(s.d.roadmap.getPhase(s.design).completedAt).toBeNull();
    s.d.roadmap.reopenTask(s.schematic, UI);
    expect(phaseStatus(s, s.design)).toBe('in_progress');
    const kinds = s.d.diary.list(s.p.id).map((e) => e.eventKind);
    expect(kinds.filter((k) => k === 'task_reopened')).toHaveLength(2);
  });

  it('reopening the only task of a done phase gives todo', () => {
    const s = setup();
    const ph = s.d.roadmap.addPhase(s.p.id, { title: 'Test' }, UI);
    const only = s.d.roadmap.addTask(ph.id, { title: 'Smoke' }, UI);
    s.d.roadmap.completeTask(only.id, UI);
    expect(phaseStatus(s, ph.id)).toBe('done');
    s.d.roadmap.reopenTask(only.id, UI);
    expect(phaseStatus(s, ph.id)).toBe('todo');
  });

  it('adding a task to a done phase reopens it', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.completeTask(s.bom, UI);
    s.d.roadmap.addTask(s.design, { title: 'Review' }, CLAUDE);
    expect(phaseStatus(s, s.design)).toBe('in_progress');
  });

  it('deleting the last open task of a phase completes it', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.deleteTask(s.bom, UI);
    expect(phaseStatus(s, s.design)).toBe('done');
  });

  it('accepts an explicit status and keeps completedAt consistent', () => {
    const s = setup();
    const v = s.d.roadmap.updatePhase(s.build, { status: 'in_progress', title: 'Assembly' }, UI);
    expect(v).toMatchObject({ status: 'in_progress', title: 'Assembly', completedAt: null });
    const done = s.d.roadmap.updatePhase(s.build, { status: 'done' }, UI);
    expect(done.completedAt).toBe(s.clock.now);
    s.clock.advance(1000);
    // Re-saving done keeps the original completion time.
    expect(s.d.roadmap.updatePhase(s.build, { status: 'done' }, UI).completedAt).toBe(
      done.completedAt,
    );
    expect(s.d.roadmap.updatePhase(s.build, { status: 'todo' }, UI).completedAt).toBeNull();
  });

  it('rejects an unknown phase status', () => {
    const s = setup();
    expectDomainError(
      () => s.d.roadmap.updatePhase(s.build, { status: 'blocked' }, UI),
      'validation',
    );
  });
});

describe('moving and renumbering', () => {
  it('adds a phase at a position and renumbers', () => {
    const s = setup();
    const first = s.d.roadmap.addPhase(s.p.id, { title: 'Research', position: 0 }, UI);
    expect(first.position).toBe(0);
    expect(s.d.roadmap.phasesOf(s.p.id).map((x) => [x.title, x.position])).toEqual([
      ['Research', 0],
      ['Design', 1],
      ['Build', 2],
    ]);
    // A position past the end appends.
    s.d.roadmap.addPhase(s.p.id, { title: 'Ship', position: 99 }, UI);
    expect(s.d.roadmap.phasesOf(s.p.id).map((x) => x.position)).toEqual([0, 1, 2, 3]);
  });

  it('moves phases and clamps out-of-range positions', () => {
    const s = setup();
    s.d.roadmap.addPhase(s.p.id, { title: 'Ship' }, UI);
    let v = s.d.roadmap.movePhase(s.design, { position: 2 }, UI);
    expect(v.map((x) => [x.title, x.position])).toEqual([
      ['Build', 0],
      ['Ship', 1],
      ['Design', 2],
    ]);
    v = s.d.roadmap.movePhase(s.design, { position: 100 }, UI);
    expect(v.map((x) => x.title)).toEqual(['Build', 'Ship', 'Design']);
    v = s.d.roadmap.movePhase(s.design, { position: 0 }, UI);
    expect(v.map((x) => x.title)).toEqual(['Design', 'Build', 'Ship']);
    expectDomainError(() => s.d.roadmap.movePhase(s.design, { position: -1 }, UI), 'validation');
  });

  it('adds a task at a position and moves tasks within a phase', () => {
    const s = setup();
    const t0 = s.d.roadmap.addTask(s.design, { title: 'Sketch', position: 0 }, UI);
    expect(t0.position).toBe(0);
    let titles = s.d.roadmap.phasesOf(s.p.id)[0]!.tasks.map((x) => [x.title, x.position]);
    expect(titles).toEqual([
      ['Sketch', 0],
      ['Schematic', 1],
      ['BOM', 2],
    ]);
    const v = s.d.roadmap.moveTask(t0.id, { position: 2 }, UI);
    titles = v[0]!.tasks.map((x) => [x.title, x.position]);
    expect(titles).toEqual([
      ['Schematic', 0],
      ['BOM', 1],
      ['Sketch', 2],
    ]);
  });

  it('moves a task across phases, renumbering both and syncing statuses', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    // Design: Schematic(done), BOM(open) → move BOM to Build at position 0.
    const v = s.d.roadmap.moveTask(s.bom, { phaseId: s.build, position: 0 }, CLAUDE);
    const [design, build] = v as [PhaseView, PhaseView];
    expect(design.tasks.map((x) => [x.title, x.position])).toEqual([['Schematic', 0]]);
    expect(build.tasks.map((x) => [x.title, x.position])).toEqual([
      ['BOM', 0],
      ['Case', 1],
      ['Wiring', 2],
    ]);
    expect(build.tasks[0]!.phaseId).toBe(s.build);
    expect(design.status).toBe('done');
    expect(build.status).toBe('todo');
    // Moving it back into the done phase reopens it.
    const back = s.d.roadmap.moveTask(s.bom, { phaseId: s.design, position: 5 }, UI);
    expect(back[0]!.status).toBe('in_progress');
    expect(back[0]!.tasks.map((x) => x.position)).toEqual([0, 1]);
    expect(back[1]!.tasks.map((x) => [x.title, x.position])).toEqual([
      ['Case', 0],
      ['Wiring', 1],
    ]);
  });

  it('rejects moving a task to another project phase', () => {
    const s = setup();
    const other = seedProject(s.d, { name: 'Other' });
    expectDomainError(
      () => s.d.roadmap.moveTask(s.bom, { phaseId: other.phases[0]!.id, position: 0 }, UI),
      'validation',
    );
    expectDomainError(
      () => s.d.roadmap.moveTask(s.bom, { phaseId: 9999, position: 0 }, UI),
      'not_found',
    );
  });

  it('renumbers tasks after a delete and phases after a phase delete', () => {
    const s = setup();
    s.d.roadmap.deleteTask(s.schematic, UI);
    expect(s.d.roadmap.phasesOf(s.p.id)[0]!.tasks.map((x) => [x.title, x.position])).toEqual([
      ['BOM', 0],
    ]);
    s.d.roadmap.addPhase(s.p.id, { title: 'Ship' }, UI);
    s.d.roadmap.deletePhase(s.design, UI);
    expect(s.d.roadmap.phasesOf(s.p.id).map((x) => [x.title, x.position])).toEqual([
      ['Build', 0],
      ['Ship', 1],
    ]);
    expectDomainError(() => s.d.roadmap.getTask(s.bom), 'not_found');
  });

  it('updates task fields and validates links', () => {
    const s = setup();
    const v = s.d.roadmap.updateTask(
      s.bom,
      { title: 'Bill of materials', notes: 'xlsx', link: 'https://example.com/i/1' },
      CLAUDE,
    );
    expect(v).toMatchObject({
      title: 'Bill of materials',
      notes: 'xlsx',
      link: 'https://example.com/i/1',
    });
    expectDomainError(() => s.d.roadmap.updateTask(s.bom, { link: 'nope' }, UI), 'validation');
    expectDomainError(() => s.d.roadmap.updateTask(s.bom, { title: '   ' }, UI), 'validation');
    expect(s.d.roadmap.updateTask(s.bom, { link: null }, UI).link).toBeNull();
  });
});

describe('graduated trust on the roadmap', () => {
  it('agent delete task without confirmation becomes a proposal', () => {
    const s = setup();
    const r = s.d.roadmap.deleteTask(s.bom, CLAUDE, 'Duplicate');
    expect(r).toMatchObject({ kind: 'delete_task', state: 'pending', reason: 'Duplicate' });
    expect(r?.payload).toEqual({ taskId: s.bom, title: 'BOM' });
    expect(s.d.roadmap.getTask(s.bom).id).toBe(s.bom);
  });

  it('agent delete phase without confirmation becomes a proposal', () => {
    const s = setup();
    const r = s.d.roadmap.deletePhase(s.build, CLAUDE);
    expect(r).toMatchObject({ kind: 'delete_phase', payload: { phaseId: s.build, taskCount: 2 } });
    expect(s.d.roadmap.phasesOf(s.p.id)).toHaveLength(2);
  });

  it('confirmed agent and UI deletes are applied directly', () => {
    const s = setup();
    expect(s.d.roadmap.deleteTask(s.bom, CLAUDE_CONFIRMED)).toBeNull();
    expect(s.d.roadmap.deletePhase(s.build, UI)).toBeNull();
    expect(s.d.roadmap.phasesOf(s.p.id).map((x) => x.title)).toEqual(['Design']);
    expect(s.d.proposals.list(s.p.id)).toHaveLength(0);
    // Tasks of the deleted phase are gone too.
    expectDomainError(() => s.d.roadmap.getTask(s.kase), 'not_found');
  });

  it('additive agent operations are applied directly', () => {
    const s = setup();
    const ph = s.d.roadmap.addPhase(s.p.id, { title: 'Docs' }, CLAUDE);
    const tk = s.d.roadmap.addTask(ph.id, { title: 'Write README' }, CLAUDE);
    s.d.roadmap.completeTask(s.schematic, CLAUDE);
    s.d.roadmap.moveTask(tk.id, { phaseId: s.design, position: 0 }, CLAUDE);
    expect(s.d.proposals.list(s.p.id)).toHaveLength(0);
  });
});
