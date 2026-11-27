// Independent verification of D74/D75 (revert). Tests marked "BUG" document
// findings; the rest are invariants that should hold.
import { asc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { changeLog, files, materials, phases, projects, tasks } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError } from './errors.js';
import {
  CLAUDE,
  CLAUDE_CONFIRMED,
  expectDomainError,
  seedProject,
  taskIds,
  writeTemp,
} from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

sharp.cache(false);

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  const [[schematic, bom], [kase, wiring]] = taskIds(t.d, p.id) as [number[], number[]];
  const [design, build] = p.phases.map((x) => x.id) as [number, number];
  return { ...t, p, schematic: schematic!, bom: bom!, kase: kase!, wiring: wiring!, design, build };
}

function snapshot(d: Domain, projectId: number) {
  const pr = d.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
  return {
    project: { status: pr.lifecycleStatus, note: pr.statusNote, override: pr.nextTaskOverrideId },
    phases: d.db
      .select({
        id: phases.id,
        title: phases.title,
        description: phases.description,
        position: phases.position,
        status: phases.status,
        completedAt: phases.completedAt,
      })
      .from(phases)
      .where(eq(phases.projectId, projectId))
      .orderBy(asc(phases.id))
      .all(),
    tasks: d.db
      .select({
        id: tasks.id,
        phaseId: tasks.phaseId,
        title: tasks.title,
        notes: tasks.notes,
        link: tasks.link,
        position: tasks.position,
        done: tasks.done,
        doneAt: tasks.doneAt,
      })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.id))
      .all(),
    files: d.db
      .select({ id: files.id, phaseId: files.phaseId, taskId: files.taskId })
      .from(files)
      .where(eq(files.projectId, projectId))
      .orderBy(asc(files.id))
      .all(),
    materials: d.db
      .select({
        id: materials.id,
        phaseId: materials.phaseId,
        name: materials.name,
        quantity: materials.quantity,
        priceCents: materials.priceCents,
        status: materials.status,
        position: materials.position,
      })
      .from(materials)
      .where(eq(materials.projectId, projectId))
      .orderBy(asc(materials.id))
      .all(),
  };
}

const last = (d: Domain, projectId: number) =>
  d.revert.list(projectId).find((c) => c.revertedAt === null)!;

const titles = (d: Domain, projectId: number) =>
  d.roadmap.phasesOf(projectId).map((p) => [p.title, p.tasks.map((x) => x.title)]);

async function png(d: Domain): Promise<string> {
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#654321' } })
    .png()
    .toBuffer();
  return writeTemp(d, bytes);
}

/** Either the revert is refused with a conflict, or it leaves a consistent state. */
function tryRevert(d: Domain, id: number): DomainError | null {
  try {
    d.revert.revert(id, UI);
    return null;
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
}

describe('A9 verify: out-of-order reverts', () => {
  it('BUG: two task deletions in one phase reverted oldest first restore the order', () => {
    const s = setup();
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.schematic, UI);
    const a = last(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.bom, UI);
    const b = last(s.d, s.p.id);
    // Not blocked (different tasks): allowed out of order.
    const e1 = tryRevert(s.d, a.id);
    if (e1) return; // blocking would also be acceptable
    s.d.revert.revert(b.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('BUG: two phase moves reverted oldest first restore the order', () => {
    t = makeDomain();
    const p = t.d.projects.create(
      { name: 'P', phases: [{ title: 'X' }, { title: 'A' }, { title: 'C' }] },
      UI,
    );
    const [x, a, c] = p.phases.map((q) => q.id) as [number, number, number];
    void x;
    const before = snapshot(t.d, p.id);
    t.d.roadmap.movePhase(a, { position: 0 }, UI);
    const m1 = last(t.d, p.id);
    t.d.roadmap.movePhase(c, { position: 0 }, UI);
    const m2 = last(t.d, p.id);
    if (tryRevert(t.d, m1.id)) return;
    t.d.revert.revert(m2.id, UI);
    expect(snapshot(t.d, p.id)).toEqual(before);
  });

  it('an older edit can be reverted while a newer edit of another task stays', () => {
    const s = setup();
    s.d.roadmap.updateTask(s.bom, { title: 'Parts' }, UI);
    const e = last(s.d, s.p.id);
    s.d.roadmap.updateTask(s.kase, { title: 'Box' }, UI);
    s.d.revert.revert(e.id, UI);
    expect(s.d.roadmap.getTask(s.bom).title).toBe('BOM');
    expect(s.d.roadmap.getTask(s.kase).title).toBe('Box');
  });
});

describe('A9 verify: later changes the revert would overwrite or destroy', () => {
  it('BUG: reverting a restructure that added a phase deletes a task the user moved into it later', () => {
    const s = setup();
    s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'add_phase', ref: 't', title: 'Test', position: 2 }] },
      UI,
    );
    const head = last(s.d, s.p.id);
    const testPhase = s.d.roadmap.phasesOf(s.p.id)[2]!.id;
    s.d.roadmap.moveTask(s.wiring, { phaseId: testPhase, position: 0 }, UI);
    const e = tryRevert(s.d, head.id);
    // Expected: refused (the later move needs the new phase), never a lost task.
    expect(e?.code).toBe('conflict');
    expect(s.d.db.select().from(tasks).where(eq(tasks.id, s.wiring)).get()).toBeDefined();
  });

  it('BUG: reverting a restructure that added a phase deletes a task added to it later', () => {
    const s = setup();
    s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'add_phase', ref: 't', title: 'Test', position: 2 }] },
      UI,
    );
    const head = last(s.d, s.p.id);
    const testPhase = s.d.roadmap.phasesOf(s.p.id)[2]!.id;
    const added = s.d.roadmap.addTask(testPhase, { title: 'Bench test', notes: 'important' }, UI);
    const e = tryRevert(s.d, head.id);
    expect(e?.code).toBe('conflict');
    expect(s.d.db.select().from(tasks).where(eq(tasks.id, added.id)).get()).toBeDefined();
  });

  it('BUG: reverting a phase status edit overwrites the status later task completions set', () => {
    const s = setup();
    s.d.roadmap.updatePhase(s.design, { status: 'in_progress' }, UI);
    const upd = last(s.d, s.p.id);
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.completeTask(s.bom, UI);
    expect(s.d.roadmap.getPhase(s.design).status).toBe('done');
    const e = tryRevert(s.d, upd.id);
    if (e) {
      expect(e.code).toBe('conflict');
      return;
    }
    // If allowed, the phase must not be 'todo' with every task done.
    expect(s.d.roadmap.getPhase(s.design).status).toBe('done');
  });

  it('BUG: reverting a reopen clears a next-step override set later', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, UI);
    s.d.roadmap.reopenTask(s.bom, UI);
    const reopen = last(s.d, s.p.id);
    s.d.roadmap.setNextTask(s.p.id, s.bom, UI);
    const e = tryRevert(s.d, reopen.id);
    if (e) {
      expect(e.code).toBe('conflict');
      return;
    }
    // Allowed: then the later override was silently lost (overwrite).
    expect(
      s.d.db.select().from(projects).where(eq(projects.id, s.p.id)).get()!.nextTaskOverrideId,
    ).toBe(s.bom);
  });

  it('BUG: set_next_task then complete, reverted oldest first, restores the original (no override)', () => {
    const s = setup();
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.setNextTask(s.p.id, s.bom, UI);
    const setNext = last(s.d, s.p.id);
    s.d.roadmap.completeTask(s.bom, UI);
    const done = last(s.d, s.p.id);
    if (tryRevert(s.d, setNext.id)) return;
    s.d.revert.revert(done.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('BUG: phase delete then material re-assign, reverted oldest first, restores the material', () => {
    const s = setup();
    const m = s.d.materials.add(s.p.id, { name: 'Copper', phaseId: s.build }, UI);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.deletePhase(s.build, UI);
    const del = last(s.d, s.p.id);
    s.d.materials.update(m.id, { phaseId: s.design }, UI);
    const mu = last(s.d, s.p.id);
    if (tryRevert(s.d, del.id)) return;
    s.d.revert.revert(mu.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('a later deletion of a material blocks reverting its edit', () => {
    const s = setup();
    const m = s.d.materials.add(s.p.id, { name: 'Wire' }, UI);
    s.d.materials.update(m.id, { name: 'Cable' }, UI);
    const upd = last(s.d, s.p.id);
    s.d.materials.delete(m.id, UI);
    const del = last(s.d, s.p.id);
    const e = expectDomainError(() => s.d.revert.revert(upd.id, UI), 'conflict');
    expect(e.details).toMatchObject({ blockedBy: del.id });
  });

  it('a later status change blocks reverting an earlier one; unrelated next step does not', () => {
    const s = setup();
    s.d.projects.setStatus(s.p.id, { status: 'on_hold', note: 'a' }, UI);
    const st1 = last(s.d, s.p.id);
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    s.d.projects.setStatus(s.p.id, { status: 'in_development', note: '' }, UI);
    const st2 = last(s.d, s.p.id);
    expect(
      expectDomainError(() => s.d.revert.revert(st1.id, UI), 'conflict').details,
    ).toMatchObject({ blockedBy: st2.id });
    s.d.revert.revert(st2.id, UI);
    s.d.revert.revert(st1.id, UI);
    expect(s.d.projects.get(s.p.id).lifecycleStatus).toBe(s.p.lifecycleStatus);
  });

  it('unrelated changes in another project never block', () => {
    const s = setup();
    const other = seedProject(s.d, { name: 'Other' });
    s.d.roadmap.completeTask(s.bom, UI);
    const c = last(s.d, s.p.id);
    const [[o1]] = taskIds(s.d, other.id) as [number[]];
    s.d.roadmap.completeTask(o1!, UI);
    s.d.projects.setStatus(other.id, { status: 'on_hold' }, UI);
    s.d.revert.revert(c.id, UI);
    expect(s.d.roadmap.getTask(s.bom).done).toBe(false);
  });
});

describe('A9 verify: restructure groups', () => {
  it('deleting a task created in the same batch, and a phase, reverts exactly', async () => {
    const s = setup();
    const f = await s.d.files.ingest(
      s.p.id,
      { tempPath: await png(s.d), originalName: 'f.png', target: { phaseId: s.build } },
      UI,
    );
    const m = s.d.materials.add(s.p.id, { name: 'Solder', phaseId: s.build }, UI);
    s.d.roadmap.setNextTask(s.p.id, s.kase, UI);
    const before = snapshot(s.d, s.p.id);
    const maxTask = Math.max(
      ...s.d.db
        .select()
        .from(tasks)
        .all()
        .map((x) => x.id),
    );
    s.d.restructure.restructure(
      s.p.id,
      {
        operations: [
          { op: 'add_task', phase: s.design, title: 'Temp', position: 0 },
          { op: 'delete_task', taskId: maxTask + 1 },
          { op: 'delete_phase', phaseId: s.build },
          { op: 'add_phase', ref: 'n', title: 'New', position: 0 },
          { op: 'move_task', taskId: s.bom, phase: 'n', position: 0 },
        ],
      },
      UI,
    );
    const head = last(s.d, s.p.id);
    expect(head).toMatchObject({ entity: 'roadmap', revertible: true });
    s.d.revert.revert(head.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
    expect(s.d.files.get(f.id).phaseId).toBe(s.build);
    expect(s.d.materials.get(m.id).phaseId).toBe(s.build);
  });

  it('all members are marked reverted and only one change/revert row is written', () => {
    const s = setup();
    s.d.restructure.restructure(
      s.p.id,
      {
        operations: [
          { op: 'update_phase', phase: s.design, title: 'D' },
          { op: 'move_phase', phase: s.build, position: 0 },
        ],
      },
      UI,
    );
    const head = last(s.d, s.p.id);
    const n = s.d.db.select().from(changeLog).all().length;
    s.d.revert.revert(head.id, UI);
    const rows = s.d.db.select().from(changeLog).all();
    expect(rows.length).toBe(n + 1);
    const members = rows.filter((r) => r.groupId === head.id);
    expect(members.length).toBe(3);
    expect(members.every((r) => r.revertedAt !== null)).toBe(true);
  });

  it('a restructure applied by Claude with confirmed: true is one revertible change', () => {
    const s = setup();
    const before = snapshot(s.d, s.p.id);
    const r = s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'delete_task', taskId: s.kase }] },
      CLAUDE_CONFIRMED,
    );
    expect(r.applied).toBe(true);
    const head = last(s.d, s.p.id);
    expect(head.entity).toBe('roadmap');
    s.d.revert.revert(head.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('a later single change between two restructures: blockers are named by head', () => {
    const s = setup();
    s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'update_task', taskId: s.bom, title: 'B1' }] },
      UI,
    );
    const g1 = last(s.d, s.p.id);
    s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'update_task', taskId: s.bom, title: 'B2' }] },
      UI,
    );
    const g2 = last(s.d, s.p.id);
    const e = expectDomainError(() => s.d.revert.revert(g1.id, UI), 'conflict');
    expect(e.details).toMatchObject({ blockedBy: g2.id });
    s.d.revert.revert(g2.id, UI);
    s.d.revert.revert(g1.id, UI);
    expect(s.d.roadmap.getTask(s.bom).title).toBe('BOM');
  });

  it('a failing restructure leaves no group open (the next single change is not grouped)', () => {
    const s = setup();
    expect(() =>
      s.d.restructure.restructure(
        s.p.id,
        {
          operations: [
            { op: 'update_phase', phase: s.design, title: 'D' },
            { op: 'delete_task', taskId: 999_999 },
          ],
        },
        UI,
      ),
    ).toThrow();
    s.d.roadmap.completeTask(s.bom, UI);
    const row = s.d.db.select().from(changeLog).orderBy(asc(changeLog.id)).all().at(-1)!;
    expect(row.groupId).toBeNull();
    expect(row.revertible).toBe(true);
    expect(s.d.roadmap.getPhase(s.design).title).toBe('Design');
  });

  it('restructure proposal approved after an unrelated revert still reverts as one', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    const c = last(s.d, s.p.id);
    const g = s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'delete_phase', phaseId: s.build }] },
      CLAUDE,
    );
    if (g.applied) throw new Error('expected proposal');
    s.d.revert.revert(c.id, UI);
    const before = snapshot(s.d, s.p.id);
    s.d.proposals.approve(g.proposal.id, {}, UI);
    const head = s.d.revert.list(s.p.id).find((c) => c.entity === 'roadmap')!;
    s.d.revert.revert(head.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });
});

describe('A9 verify: proposals (D75)', () => {
  it('approve after the blocking change is reverted performs the revert', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const c = last(s.d, s.p.id);
    const prop = s.d.revert.propose(s.p.id, c.id, 'oops', CLAUDE);
    s.d.roadmap.updateTask(s.bom, { notes: 'later' }, UI);
    const later = last(s.d, s.p.id);
    expectDomainError(() => s.d.proposals.approve(prop.id, {}, UI), 'conflict');
    s.d.revert.revert(later.id, UI);
    s.d.proposals.approve(prop.id, {}, UI);
    expect(s.d.proposals.get(prop.id).state).toBe('approved');
    expect(s.d.roadmap.getTask(s.bom).done).toBe(false);
  });

  it('approving a proposal whose change the user already reverted fails cleanly', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const c = last(s.d, s.p.id);
    const prop = s.d.revert.propose(s.p.id, c.id, '', CLAUDE);
    s.d.revert.revert(c.id, UI);
    expectDomainError(() => s.d.proposals.approve(prop.id, {}, UI), 'conflict');
    expect(s.d.roadmap.getTask(s.bom).done).toBe(false);
  });

  it('rejecting a revert proposal changes nothing', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const c = last(s.d, s.p.id);
    const prop = s.d.revert.propose(s.p.id, c.id, '', CLAUDE);
    s.d.proposals.reject(prop.id, {}, UI);
    expect(s.d.roadmap.getTask(s.bom).done).toBe(true);
    expect(s.d.revert.get(c.id).revertedAt).toBeNull();
  });

  it('Claude with write disabled cannot propose; the user can still revert and approve', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const c = last(s.d, s.p.id);
    const prop = s.d.revert.propose(s.p.id, c.id, '', CLAUDE);
    s.d.projects.update(s.p.id, { claudeWriteEnabled: false }, UI);
    expectDomainError(() => s.d.revert.propose(s.p.id, c.id, '', CLAUDE), 'forbidden');
    s.d.proposals.approve(prop.id, {}, UI);
    expect(s.d.roadmap.getTask(s.bom).done).toBe(false);
  });

  it('propose by a group member id stores the head id', () => {
    const s = setup();
    s.d.restructure.restructure(
      s.p.id,
      { operations: [{ op: 'update_task', taskId: s.bom, title: 'B' }] },
      UI,
    );
    const head = last(s.d, s.p.id);
    const member = s.d.db
      .select()
      .from(changeLog)
      .where(eq(changeLog.groupId, head.id))
      .all()
      .find((r) => r.id !== head.id)!;
    const prop = s.d.revert.propose(s.p.id, member.id, '', CLAUDE);
    expect(prop.payload).toMatchObject({ changeId: head.id });
  });

  it('only ui reverts: system source is forbidden too', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, UI);
    const c = last(s.d, s.p.id);
    expectDomainError(() => s.d.revert.revert(c.id, { source: 'system' }), 'forbidden');
  });
});

describe('A9 verify: list() pagination and folding', () => {
  it('pages with before cover every head exactly once, newest first', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) {
      s.d.roadmap.updateTask(s.bom, { notes: `n${i}` }, UI);
      s.d.restructure.restructure(
        s.p.id,
        {
          operations: [
            { op: 'update_task', taskId: s.kase, title: `k${i}` },
            { op: 'update_phase', phase: s.design, description: `d${i}` },
          ],
        },
        UI,
      );
    }
    const all = s.d.revert.list(s.p.id, { limit: 200 });
    const paged: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = s.d.revert.list(s.p.id, { limit: 3, ...(before ? { before } : {}) });
      if (!page.length) break;
      paged.push(...page.map((c) => c.id));
      before = page.at(-1)!.id;
    }
    expect(paged).toEqual(all.map((c) => c.id));
    expect(new Set(paged).size).toBe(paged.length);
    expect([...paged].sort((a, b) => b - a)).toEqual(paged);
    expect(all.filter((c) => c.entity === 'roadmap')).toHaveLength(5);
    const memberIds = new Set(
      s.d.db
        .select()
        .from(changeLog)
        .all()
        .filter((r) => r.groupId !== null && r.groupId !== r.id)
        .map((r) => r.id),
    );
    expect(paged.some((id) => memberIds.has(id))).toBe(false);
  });

  it('a reverted change stays listed with revertedAt and revertible false', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, UI);
    const c = last(s.d, s.p.id);
    s.d.revert.revert(c.id, UI);
    const v = s.d.revert.list(s.p.id).find((x) => x.id === c.id)!;
    expect(v.revertedAt).not.toBeNull();
    expect(v.revertible).toBe(false);
  });
});

describe('A9 verify: next step and phase status side effects', () => {
  it('reverting a phase delete restores the override that pointed into it', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.deletePhase(s.build, UI);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('reverting a completion that cleared the override restores it', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.completeTask(s.wiring, UI);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('completing the last task (phase done) then reverting restores status and completedAt', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.clock.advance(5000);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.completeTask(s.bom, UI);
    s.clock.advance(5000);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('reopening a task of a done phase and reverting restores done with the old completedAt', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.completeTask(s.bom, UI);
    s.clock.advance(5000);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.reopenTask(s.bom, UI);
    s.clock.advance(5000);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('moving the last open task out of a phase (phase done) and reverting restores both phases', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.clock.advance(5000);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.moveTask(s.bom, { phaseId: s.build, position: 1 }, UI);
    expect(s.d.roadmap.getPhase(s.design).status).toBe('done');
    s.clock.advance(5000);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('deleting the last open task (phase done) and reverting restores phase status', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.clock.advance(5000);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.bom, UI);
    s.clock.advance(5000);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('BUG: out-of-order revert of a move marks a phase done although it has open tasks', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.kase, UI);
    s.d.roadmap.completeTask(s.wiring, UI);
    const doneWiring = last(s.d, s.p.id);
    expect(s.d.roadmap.getPhase(s.build).status).toBe('done');
    s.d.roadmap.moveTask(s.bom, { phaseId: s.build, position: 2 }, UI); // Build -> in_progress
    const move = last(s.d, s.p.id);
    // The move changed Build's status after the completion: blocked (fix of A9), newest first works.
    expect(
      expectDomainError(() => s.d.revert.revert(doneWiring.id, UI), 'conflict').details,
    ).toMatchObject({
      blockedBy: move.id,
    });
    s.d.revert.revert(move.id, UI);
    s.d.revert.revert(doneWiring.id, UI);
    // Build now holds Case (done) and Wiring (open): it must not be 'done'.
    expect(s.d.roadmap.getTask(s.wiring).done).toBe(false);
    expect(s.d.roadmap.getPhase(s.build).status).not.toBe('done');
  });

  it('reverting a set_next_task to a task completed since is blocked by that completion', () => {
    const s = setup();
    s.d.roadmap.setNextTask(s.p.id, s.wiring, UI);
    s.d.roadmap.setNextTask(s.p.id, s.kase, UI);
    const second = last(s.d, s.p.id);
    s.d.roadmap.completeTask(s.wiring, UI);
    const done = last(s.d, s.p.id);
    // set_next_task touches the task it points back to (fix of A9).
    expect(
      expectDomainError(() => s.d.revert.revert(second.id, UI), 'conflict').details,
    ).toMatchObject({
      blockedBy: done.id,
    });
    const pr = s.d.db.select().from(projects).where(eq(projects.id, s.p.id)).get()!;
    expect(pr.nextTaskOverrideId).toBe(s.kase);
  });
});

describe('A9 verify: materials and files', () => {
  it('material delete with phase, revert restores id, phase and position', () => {
    const s = setup();
    s.d.materials.add(s.p.id, { name: 'A' }, UI);
    const m = s.d.materials.add(s.p.id, { name: 'B', phaseId: s.build, price: 3.2 }, UI);
    s.d.materials.add(s.p.id, { name: 'C' }, UI);
    const before = snapshot(s.d, s.p.id);
    s.d.materials.delete(m.id, UI);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
    expect(s.d.materials.list(s.p.id).map((x) => x.name)).toEqual(['A', 'B', 'C']);
  });

  it('material delete whose phase was deleted later: revert restores it at project level', () => {
    const s = setup();
    const m = s.d.materials.add(s.p.id, { name: 'B', phaseId: s.build }, UI);
    s.d.materials.delete(m.id, UI);
    const del = last(s.d, s.p.id);
    s.d.roadmap.deletePhase(s.build, UI);
    s.d.revert.revert(del.id, UI);
    expect(s.d.materials.get(m.id).phaseId).toBeNull();
  });

  it('task delete with two files restores both attachments', async () => {
    const s = setup();
    const f1 = await s.d.files.ingest(
      s.p.id,
      { tempPath: await png(s.d), originalName: '1.png', target: { taskId: s.kase } },
      UI,
    );
    const f2 = await s.d.files.ingest(
      s.p.id,
      { tempPath: await png(s.d), originalName: '2.png', target: { taskId: s.kase } },
      UI,
    );
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.kase, UI);
    s.d.revert.revert(last(s.d, s.p.id).id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
    expect([s.d.files.get(f1.id).taskId, s.d.files.get(f2.id).taskId]).toEqual([s.kase, s.kase]);
  });
});

describe('A9 verify: random out-of-order reverts never lose data or corrupt state', () => {
  function rng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (let seed = 1; seed <= 30; seed++) {
    it(`seed ${seed}: invariants after reverts in random order`, () => {
      t = makeDomain();
      const d = t.d;
      const p = d.projects.create(
        {
          name: `R${seed}`,
          phases: [
            { title: 'A', tasks: ['a1', 'a2', 'a3'] },
            { title: 'B', tasks: ['b1', 'b2'] },
          ],
        },
        UI,
      );
      const r = rng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
      for (let i = 0; i < 10; i++) {
        const ph = d.roadmap.phasesOf(p.id);
        const all = ph.flatMap((x) => x.tasks);
        const k = Math.floor(r() * 6);
        try {
          if (k === 0 && all.length) d.roadmap.completeTask(pick(all).id, UI);
          else if (k === 1 && all.length)
            d.roadmap.updateTask(pick(all).id, { title: `t${i}` }, UI);
          else if (k === 2 && all.length)
            d.roadmap.moveTask(pick(all).id, { phaseId: pick(ph).id, position: 0 }, UI);
          else if (k === 3 && all.length > 2) d.roadmap.deleteTask(pick(all).id, UI);
          else if (k === 4) d.roadmap.movePhase(pick(ph).id, { position: Math.floor(r() * 2) }, UI);
          else if (k === 5 && all.length) d.roadmap.setNextTask(p.id, pick(all).id, UI);
        } catch {
          /* skip invalid steps */
        }
      }
      // Revert in random order whatever is allowed.
      for (let round = 0; round < 30; round++) {
        const open = d.revert.list(p.id, { limit: 200 }).filter((c) => c.revertible);
        if (!open.length) break;
        const c = pick(open);
        const e = tryRevert(d, c.id);
        if (e) expect(e.code).toBe('conflict');
        // Invariants: positions dense per phase, phase status consistent, override valid.
        const phs = d.db.select().from(phases).where(eq(phases.projectId, p.id)).all();
        expect(phs.map((x) => x.position).sort()).toEqual(phs.map((_, i) => i));
        for (const q of phs) {
          const ts = d.db.select().from(tasks).where(eq(tasks.phaseId, q.id)).all();
          expect(ts.map((x) => x.position).sort((a, b) => a - b)).toEqual(ts.map((_, i) => i));
          if (ts.length && ts.every((x) => x.done)) expect(q.status).toBe('done');
          if (ts.some((x) => !x.done)) expect(q.status).not.toBe('done');
        }
        const pr = d.db.select().from(projects).where(eq(projects.id, p.id)).get()!;
        if (pr.nextTaskOverrideId !== null) {
          const ot = d.db.select().from(tasks).where(eq(tasks.id, pr.nextTaskOverrideId)).get();
          expect(ot?.done).toBe(false);
        }
      }
    });
  }
});
