// Independent verification B9 of D74/D75/D77 (revert conflicts and side effects).
// Tests named "BUG:" document findings; the rest are invariants that should hold.
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { materials, phases, projects, tasks } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError } from './errors.js';
import { syncedPhaseStatus } from './roadmap.js';
import { CLAUDE, seedProject, taskIds } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  const [[schematic, bom], [kase, wiring]] = taskIds(t.d, p.id) as [number[], number[]];
  const [design, build] = p.phases.map((x) => x.id) as [number, number];
  return {
    d: t.d,
    p,
    schematic: schematic!,
    bom: bom!,
    kase: kase!,
    wiring: wiring!,
    design,
    build,
  };
}

const last = (d: Domain, projectId: number) =>
  d.revert.list(projectId).find((c) => c.revertedAt === null)!;

function tryRevert(d: Domain, id: number): DomainError | null {
  try {
    d.revert.revert(id, UI);
    return null;
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
}

/** Invariants: positions 0..n-1, phase status agrees with tasks, override open and present. */
function invariants(d: Domain, projectId: number) {
  const ps = d.db
    .select()
    .from(phases)
    .where(eq(phases.projectId, projectId))
    .orderBy(asc(phases.position))
    .all();
  expect(ps.map((p) => p.position)).toEqual(ps.map((_, i) => i));
  for (const p of ps) {
    const ts = d.db
      .select()
      .from(tasks)
      .where(eq(tasks.phaseId, p.id))
      .orderBy(asc(tasks.position))
      .all();
    expect(
      ts.map((x) => x.position),
      `task positions of phase ${p.title}`,
    ).toEqual(ts.map((_, i) => i));
    expect(syncedPhaseStatus(p.status, ts), `status of phase ${p.title}`).toBe(p.status);
    if (p.status === 'done') expect(p.completedAt).not.toBeNull();
  }
  const pr = d.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
  if (pr.nextTaskOverrideId !== null) {
    const o = d.db.select().from(tasks).where(eq(tasks.id, pr.nextTaskOverrideId)).get();
    expect(o, 'override task exists').toBeDefined();
    expect(o!.done, 'override task open').toBe(false);
  }
}

describe('B9: phase status edits reverted around task changes', () => {
  it('BUG: reverting a manual "in progress" on a done phase after adding a task leaves a done phase with an open task', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.completeTask(s.bom, UI);
    expect(s.d.roadmap.getPhase(s.design).status).toBe('done');
    // The user reopens the phase by hand and adds the work that was missing.
    s.d.roadmap.updatePhase(s.design, { status: 'in_progress' }, UI);
    const upd = last(s.d, s.p.id);
    s.d.roadmap.addTask(s.design, { title: 'Review' }, UI);
    const e = tryRevert(s.d, upd.id);
    if (e) {
      expect(e.code).toBe('conflict');
      return;
    }
    // Allowed: then the phase must not be done with an open task.
    invariants(s.d, s.p.id);
  });

  it('BUG: reverting a manual "done" after deleting the open task leaves "in progress" with every task done', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.updatePhase(s.design, { status: 'done' }, UI);
    const upd = last(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.bom, UI);
    const e = tryRevert(s.d, upd.id);
    if (e) return;
    invariants(s.d, s.p.id);
  });

  it('reverting a title edit of a phase is not blocked by task changes in it', () => {
    const s = setup();
    s.d.roadmap.updatePhase(s.design, { title: 'Design v2' }, UI);
    const upd = last(s.d, s.p.id);
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.addTask(s.design, { title: 'Extra' }, UI);
    s.d.roadmap.moveTask(s.bom, { position: 0 }, UI);
    expect(tryRevert(s.d, upd.id)).toBeNull();
    expect(s.d.roadmap.getPhase(s.design).title).toBe('Design');
    invariants(s.d, s.p.id);
  });
});

describe('B9: unrelated changes do not block', () => {
  it('changes in another phase never block a task move or delete', () => {
    const s = setup();
    s.d.roadmap.moveTask(s.bom, { position: 0 }, UI);
    const mv = last(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.schematic, UI);
    const del = last(s.d, s.p.id);
    // Only the Build phase from here on.
    s.d.roadmap.completeTask(s.kase, UI);
    s.d.roadmap.addTask(s.build, { title: 'Enclosure' }, UI);
    s.d.roadmap.moveTask(s.wiring, { position: 0 }, UI);
    s.d.roadmap.updateTask(s.wiring, { notes: 'AWG 10' }, UI);
    expect(tryRevert(s.d, del.id)).toBeNull();
    expect(tryRevert(s.d, mv.id)).toBeNull();
    expect(s.d.roadmap.phasesOf(s.p.id)[0]!.tasks.map((x) => x.title)).toEqual([
      'Schematic',
      'BOM',
    ]);
    invariants(s.d, s.p.id);
  });

  it('a material edit, a status change and the next step do not block a task completion', () => {
    const s = setup();
    const m = s.d.materials.add(s.p.id, { name: 'Copper' }, UI);
    s.d.roadmap.completeTask(s.kase, UI);
    const done = last(s.d, s.p.id);
    s.d.materials.update(m.id, { quantity: 3 }, UI);
    s.d.projects.setStatus(s.p.id, { status: 'on_hold' }, UI);
    s.d.roadmap.setNextTask(s.p.id, s.schematic, UI);
    expect(tryRevert(s.d, done.id)).toBeNull();
    expect(s.d.roadmap.getTask(s.kase).done).toBe(false);
    invariants(s.d, s.p.id);
  });

  it('documented (D77) over-blocking: a later next step pointing at a renamed task blocks reverting the rename', () => {
    const s = setup();
    s.d.roadmap.updateTask(s.wiring, { title: 'Harness' }, UI);
    const upd = last(s.d, s.p.id);
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    const e = tryRevert(s.d, upd.id);
    // Reverting a title cannot overwrite the next step, but D77 makes set_next_task touch its tasks.
    expect(e?.code).toBe('conflict');
  });

  it('a later change in another project never blocks', () => {
    const s = setup();
    const other = seedProject(s.d, { name: 'Other' });
    s.d.roadmap.moveTask(s.bom, { position: 0 }, UI);
    const mv = last(s.d, s.p.id);
    const [[o1]] = taskIds(s.d, other.id) as [number[]];
    s.d.roadmap.moveTask(o1!, { position: 1 }, UI);
    s.d.restructure.restructure(
      other.id,
      { operations: [{ op: 'add_phase', ref: 'x', title: 'X', position: 0 }] },
      UI,
    );
    expect(tryRevert(s.d, mv.id)).toBeNull();
  });
});

describe('B9: later changes are never overwritten', () => {
  it('a revert of a move is blocked by a later move of another task in the same phase', () => {
    const s = setup();
    s.d.roadmap.addTask(s.design, { title: 'Layout' }, UI);
    s.d.roadmap.moveTask(s.bom, { position: 0 }, UI);
    const mv = last(s.d, s.p.id);
    s.d.roadmap.moveTask(s.schematic, { position: 2 }, UI);
    const later = last(s.d, s.p.id);
    const e = tryRevert(s.d, mv.id);
    expect(e?.details).toMatchObject({ reason: 'blocked', blockedBy: later.id });
  });

  it('a revert of a task delete is blocked by a later task create in that phase', () => {
    const s = setup();
    s.d.roadmap.deleteTask(s.schematic, UI);
    const del = last(s.d, s.p.id);
    s.d.roadmap.addTask(s.design, { title: 'New', position: 0 }, UI);
    const e = tryRevert(s.d, del.id);
    expect(e?.code).toBe('conflict');
  });

  it('a revert of a material delete is blocked by nothing that edits other materials', () => {
    const s = setup();
    const a = s.d.materials.add(s.p.id, { name: 'A' }, UI);
    const b = s.d.materials.add(s.p.id, { name: 'B', phaseId: s.design }, UI);
    s.d.materials.delete(b.id, UI);
    const del = last(s.d, s.p.id);
    s.d.materials.update(a.id, { name: 'A2' }, UI);
    expect(tryRevert(s.d, del.id)).toBeNull();
    const row = s.d.db.select().from(materials).where(eq(materials.id, b.id)).get();
    expect(row).toMatchObject({ name: 'B', phaseId: s.design });
    expect(s.d.materials.get(a.id).name).toBe('A2');
  });

  it('reverting a restructure that deleted a task with the next step, after the user set another next step, is blocked', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'delete_task', taskId: s.wiring }] },
      UI,
    );
    const head = last(s.d, s.p.id);
    s.d.roadmap.setNextTask(s.p.id, s.kase, UI);
    const e = tryRevert(s.d, head.id);
    expect(e?.code).toBe('conflict');
    expect(
      s.d.db.select().from(projects).where(eq(projects.id, s.p.id)).get()!.nextTaskOverrideId,
    ).toBe(s.kase);
  });

  it('reverting a phase delete after the user re-attached its material elsewhere is blocked', () => {
    const s = setup();
    const m = s.d.materials.add(s.p.id, { name: 'Wire', phaseId: s.build }, UI);
    s.d.roadmap.deletePhase(s.build, UI);
    const del = last(s.d, s.p.id);
    s.d.materials.update(m.id, { phaseId: s.design }, UI);
    const e = tryRevert(s.d, del.id);
    expect(e?.code).toBe('conflict');
    expect(s.d.materials.get(m.id).phaseId).toBe(s.design);
  });

  it('a long realistic interleaving reverted newest first restores the start exactly', () => {
    const s = setup();
    const start = JSON.stringify(s.d.roadmap.phasesOf(s.p.id));
    const startProject = s.d.projects.row(s.p.id);
    // UI and Claude alternate.
    s.d.roadmap.completeTask(s.schematic, CLAUDE);
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    s.d.roadmap.moveTask(s.wiring, { phaseId: s.design, position: 0 }, CLAUDE);
    s.d.roadmap.updateTask(s.bom, { notes: 'from supplier' }, UI);
    s.d.roadmap.completeTask(s.wiring, UI);
    s.d.roadmap.updatePhase(s.build, { description: 'Hands on' }, CLAUDE);
    s.d.roadmap.movePhase(s.build, { position: 0 }, UI);
    s.d.roadmap.deleteTask(s.kase, UI);
    s.d.projects.setStatus(s.p.id, { status: 'on_hold' }, CLAUDE);
    for (;;) {
      const c = s.d.revert.list(s.p.id).find((x) => x.revertible);
      if (!c) break;
      expect(tryRevert(s.d, c.id)).toBeNull();
      invariants(s.d, s.p.id);
    }
    expect(JSON.stringify(s.d.roadmap.phasesOf(s.p.id))).toBe(start);
    const pr = s.d.projects.row(s.p.id);
    expect(pr.nextTaskOverrideId).toBe(startProject.nextTaskOverrideId);
    expect(pr.lifecycleStatus).toBe(startProject.lifecycleStatus);
  });
});

describe('B9: what the change list says', () => {
  it('BUG: a next step set to a task deleted later is described as "Next step cleared"', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    const set = last(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.wiring, UI);
    const view = s.d.revert.get(set.id);
    expect(view.summary).not.toBe('Next step cleared');
  });

  it('a permanent blocker: a task added later (not revertible) blocks reverting an older move for good', () => {
    const s = setup();
    s.d.roadmap.moveTask(s.bom, { position: 0 }, UI);
    const mv = last(s.d, s.p.id);
    s.d.roadmap.addTask(s.design, { title: 'Later' }, UI);
    const add = last(s.d, s.p.id);
    const e = tryRevert(s.d, mv.id);
    expect(e?.details).toMatchObject({ reason: 'blocked', blockedBy: add.id });
    // The blocker itself cannot be reverted: the user has no way forward except deleting.
    expect(s.d.revert.get(add.id).revertible).toBe(false);
  });
});
