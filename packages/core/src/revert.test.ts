import { and, asc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { changeLog, files, materials, phases, projects, tasks } from './db/schema.js';
import type { Domain } from './domain.js';
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

/** Everything a revert must restore, without bookkeeping timestamps (updatedAt). */
function snapshot(d: Domain, projectId: number) {
  const pr = d.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
  return {
    project: {
      status: pr.lifecycleStatus,
      note: pr.statusNote,
      override: pr.nextTaskOverrideId,
    },
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
        createdAt: tasks.createdAt,
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
        notes: materials.notes,
        position: materials.position,
      })
      .from(materials)
      .where(eq(materials.projectId, projectId))
      .orderBy(asc(materials.id))
      .all(),
  };
}

/** The newest change of the project that is not reverted. */
const lastChange = (d: Domain, projectId: number) =>
  d.revert.list(projectId).find((c) => c.revertedAt === null)!;

async function png(d: Domain): Promise<string> {
  const bytes = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  return writeTemp(d, bytes);
}

describe('revert: single changes', () => {
  it('reverting a completion reopens the task, re-syncs the phase and logs a diary event', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.completeTask(s.bom, UI);
    expect(s.d.roadmap.getPhase(s.design).status).toBe('done');
    const before = snapshot(s.d, s.p.id);
    s.clock.advance(1000);
    // The newest change is the BOM completion.
    const c = lastChange(s.d, s.p.id);
    expect(c).toMatchObject({ entity: 'task', action: 'complete', label: 'BOM', revertible: true });
    const r = s.d.revert.revert(c.id, UI);
    expect(r.revertible).toBe(false);
    expect(r.revertedAt).not.toBeNull();
    expect(s.d.roadmap.getTask(s.bom).done).toBe(false);
    expect(s.d.roadmap.getPhase(s.design).status).toBe('in_progress');
    expect(snapshot(s.d, s.p.id)).not.toEqual(before);
    const ev = s.d.diary.list(s.p.id, { limit: 1 })[0]!;
    expect(ev).toMatchObject({
      eventKind: 'reverted',
      source: 'ui',
      body: 'Reverted: Completed task "BOM"',
    });
    expect(ev.data).toMatchObject({ changeId: c.id, entity: 'task', action: 'complete' });
  });

  it('writes exactly one change row (change/revert) and nothing revertible', () => {
    const s = setup();
    s.d.roadmap.deleteTask(s.bom, UI);
    const c = lastChange(s.d, s.p.id);
    const n = s.d.db.select().from(changeLog).all().length;
    s.d.revert.revert(c.id, UI);
    const added = s.d.db.select().from(changeLog).all().slice(n);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      entity: 'change',
      action: 'revert',
      entityId: c.id,
      revertible: false,
    });
    // The bookkeeping row is not listed as a change.
    expect(s.d.revert.list(s.p.id).some((x) => x.entity === 'change')).toBe(false);
  });

  it('cannot revert the same change twice', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.schematic, UI);
    const c = lastChange(s.d, s.p.id);
    s.d.revert.revert(c.id, UI);
    const e = expectDomainError(() => s.d.revert.revert(c.id, UI), 'conflict');
    expect(e.details).toMatchObject({ reason: 'already_reverted' });
  });

  it('restores a deleted task with its id, position, file and next-step override', async () => {
    const s = setup();
    const f = await s.d.files.ingest(
      s.p.id,
      { tempPath: await png(s.d), originalName: 'a.png', target: { taskId: s.bom } },
      UI,
    );
    s.d.roadmap.setNextTask(s.p.id, s.bom, UI);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.deleteTask(s.schematic, UI); // shifts BOM to position 0
    s.d.roadmap.deleteTask(s.bom, UI);
    expect(s.d.files.get(f.id).taskId).toBeNull();
    s.d.revert.revert(lastChange(s.d, s.p.id).id, UI);
    s.d.revert.revert(lastChange(s.d, s.p.id).id, UI);
    // Both deletions were the newest non-reverted changes in turn.
    expect(snapshot(s.d, s.p.id)).toEqual(before);
    expect(s.d.files.get(f.id).taskId).toBe(s.bom);
  });

  it('restores a deleted phase with tasks, files and materials', async () => {
    const s = setup();
    const f = await s.d.files.ingest(
      s.p.id,
      { tempPath: await png(s.d), originalName: 'p.png', target: { phaseId: s.build } },
      UI,
    );
    const g = await s.d.files.ingest(
      s.p.id,
      { tempPath: await png(s.d), originalName: 't.png', target: { taskId: s.wiring } },
      UI,
    );
    const m = s.d.materials.add(s.p.id, { name: 'Copper strip', phaseId: s.build }, UI);
    s.d.roadmap.completeTask(s.kase, UI);
    const before = snapshot(s.d, s.p.id);
    s.d.roadmap.deletePhase(s.build, UI);
    expect(s.d.materials.get(m.id).phaseId).toBeNull();
    const c = lastChange(s.d, s.p.id);
    expect(c).toMatchObject({ entity: 'phase', action: 'delete', label: 'Build' });
    s.d.revert.revert(c.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
    expect(s.d.files.get(f.id).phaseId).toBe(s.build);
    expect(s.d.files.get(g.id).taskId).toBe(s.wiring);
    expect(s.d.materials.get(m.id).phaseId).toBe(s.build);
  });

  it('a file re-attached elsewhere since the deletion stays where the user put it', async () => {
    const s = setup();
    const f = await s.d.files.ingest(
      s.p.id,
      { tempPath: await png(s.d), originalName: 'a.png', target: { taskId: s.bom } },
      UI,
    );
    s.d.roadmap.deleteTask(s.bom, UI);
    const del = lastChange(s.d, s.p.id);
    // Attach it to a diary note in the meantime (not a roadmap change: no conflict).
    s.d.diary.addNote(s.p.id, { body: 'photo', fileIds: [f.id] }, UI);
    s.d.revert.revert(del.id, UI);
    expect(s.d.files.get(f.id)).toMatchObject({ taskId: null });
    expect(s.d.roadmap.getTask(s.bom).title).toBe('BOM');
  });

  it('reverts edits, moves, status, next step and materials', () => {
    const s = setup();
    const m = s.d.materials.add(s.p.id, { name: 'Wire', quantity: 2, price: 1.5 }, UI);
    const before = snapshot(s.d, s.p.id);
    const ids: number[] = [];
    const step = (fn: () => unknown) => {
      s.clock.advance(1000);
      fn();
      ids.push(lastChange(s.d, s.p.id).id);
    };
    step(() =>
      s.d.roadmap.updateTask(
        s.bom,
        { title: 'Parts list', notes: 'n', link: 'https://x.test/a' },
        UI,
      ),
    );
    step(() => s.d.roadmap.moveTask(s.bom, { phaseId: s.build, position: 0 }, UI));
    step(() => s.d.roadmap.updatePhase(s.design, { title: 'Draw', status: 'done' }, UI));
    step(() => s.d.roadmap.movePhase(s.build, { position: 0 }, UI));
    step(() => s.d.projects.setStatus(s.p.id, { status: 'on_hold', note: 'waiting' }, UI));
    step(() => s.d.roadmap.setNextTask(s.p.id, s.wiring, UI));
    step(() => s.d.materials.update(m.id, { name: 'Cable', price: 2, status: 'ordered' }, UI));
    step(() => s.d.materials.delete(m.id, UI));
    for (const id of ids.reverse()) s.d.revert.revert(id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('an edit is named by its old title and lists the changed fields', () => {
    const s = setup();
    s.d.roadmap.updateTask(s.bom, { title: 'Parts list' }, UI);
    expect(lastChange(s.d, s.p.id)).toMatchObject({
      label: 'BOM',
      fields: ['title'],
      summary: 'Edited task "BOM" (title)',
    });
  });
});

describe('revert: conflicts', () => {
  it('a later change to the same task blocks the revert and is named', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, UI);
    const done = lastChange(s.d, s.p.id);
    s.d.roadmap.updateTask(s.bom, { notes: 'later' }, UI);
    const edit = lastChange(s.d, s.p.id);
    const e = expectDomainError(() => s.d.revert.revert(done.id, UI), 'conflict');
    expect(e.details).toEqual({ reason: 'blocked', blockedBy: edit.id });
    // Nothing changed by the refused revert.
    expect(s.d.roadmap.getTask(s.bom).done).toBe(true);
    s.d.revert.revert(edit.id, UI);
    s.d.revert.revert(done.id, UI);
    expect(s.d.roadmap.getTask(s.bom)).toMatchObject({ done: false, notes: '' });
  });

  it('a change to another task does not block', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, UI);
    const done = lastChange(s.d, s.p.id);
    s.d.roadmap.completeTask(s.schematic, UI);
    s.d.roadmap.updateTask(s.wiring, { title: 'Wires' }, UI);
    s.d.revert.revert(done.id, UI);
    expect(s.d.roadmap.getTask(s.bom).done).toBe(false);
    expect(s.d.roadmap.getTask(s.schematic).done).toBe(true);
  });

  it('a later deletion of the phase blocks reverting a task change in it', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.kase, UI);
    const done = lastChange(s.d, s.p.id);
    s.d.roadmap.deletePhase(s.build, UI);
    const del = lastChange(s.d, s.p.id);
    const e = expectDomainError(() => s.d.revert.revert(done.id, UI), 'conflict');
    expect(e.details).toMatchObject({ blockedBy: del.id });
  });

  it('a later phase deletion blocks restoring a task deleted from it', () => {
    const s = setup();
    s.d.roadmap.deleteTask(s.kase, UI);
    const delTask = lastChange(s.d, s.p.id);
    s.d.roadmap.deletePhase(s.build, UI);
    const delPhase = lastChange(s.d, s.p.id);
    expect(
      expectDomainError(() => s.d.revert.revert(delTask.id, UI), 'conflict').details,
    ).toMatchObject({ blockedBy: delPhase.id });
    s.d.revert.revert(delPhase.id, UI);
    s.d.revert.revert(delTask.id, UI);
    expect(s.d.roadmap.phasesOf(s.p.id)[1]!.tasks.map((x) => x.title)).toEqual(['Case', 'Wiring']);
  });

  it('a manual test outcome (not revertible) blocks reverting the status before it', () => {
    const s = setup();
    s.d.projects.setStatus(s.p.id, { status: 'awaiting_manual_test', note: 'check X' }, UI);
    const st = lastChange(s.d, s.p.id);
    s.d.projects.recordTestOutcome(s.p.id, { passed: true }, UI);
    const outcome = lastChange(s.d, s.p.id);
    expect(outcome.revertible).toBe(false);
    expect(expectDomainError(() => s.d.revert.revert(st.id, UI), 'conflict').details).toMatchObject(
      {
        blockedBy: outcome.id,
      },
    );
  });
});

describe('revert: what is not revertible', () => {
  it('creating a task, phase or material alone, files, project fields, settings', async () => {
    const s = setup();
    const check = (fn: () => unknown) => {
      fn();
      const c = lastChange(s.d, s.p.id);
      expect(c.revertible).toBe(false);
      expect(
        expectDomainError(() => s.d.revert.revert(c.id, UI), 'validation').details,
      ).toMatchObject({
        reason: 'not_revertible',
      });
    };
    check(() => s.d.roadmap.addTask(s.design, { title: 'New' }, UI));
    check(() => s.d.roadmap.addPhase(s.p.id, { title: 'New phase' }, UI));
    check(() => s.d.materials.add(s.p.id, { name: 'Glue' }, UI));
    check(() => s.d.projects.update(s.p.id, { name: 'Renamed' }, UI));
    await s.d.files.ingest(s.p.id, { tempPath: await png(s.d), originalName: 'x.png' }, UI);
    expect(lastChange(s.d, s.p.id)).toMatchObject({ entity: 'file', revertible: false });
  });

  it('changes recorded before this release (revertible false) cannot be reverted', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, UI);
    const c = lastChange(s.d, s.p.id);
    s.d.db.update(changeLog).set({ revertible: false }).where(eq(changeLog.id, c.id)).run();
    expectDomainError(() => s.d.revert.revert(c.id, UI), 'validation');
  });

  it('an unknown change id or a bookkeeping row is not found', () => {
    const s = setup();
    expectDomainError(() => s.d.revert.revert(99_999, UI), 'not_found');
    s.d.roadmap.completeTask(s.bom, UI);
    s.d.revert.revert(lastChange(s.d, s.p.id).id, UI);
    const book = s.d.db.select().from(changeLog).where(eq(changeLog.entity, 'change')).get()!;
    expectDomainError(() => s.d.revert.revert(book.id, UI), 'not_found');
  });
});

describe('revert: restructure as one change', () => {
  const ops = (s: ReturnType<typeof setup>) => [
    { op: 'add_phase' as const, ref: 'test', title: 'Test', position: 1 },
    { op: 'add_task' as const, phase: 'test', title: 'Bench test' },
    { op: 'move_task' as const, taskId: s.bom, phase: 'test', position: 0 },
    { op: 'update_phase' as const, phase: s.design, title: 'Design v2' },
    { op: 'delete_task' as const, taskId: s.wiring },
    { op: 'move_phase' as const, phase: s.build, position: 0 },
  ];

  it('is listed once, with members folded, and reverting restores everything', () => {
    const s = setup();
    const before = snapshot(s.d, s.p.id);
    s.d.restructure.restructure(s.p.id, { operations: ops(s) }, UI);
    const list = s.d.revert.list(s.p.id);
    expect(list[0]).toMatchObject({
      entity: 'roadmap',
      action: 'restructure',
      operations: 6,
      revertible: true,
      summary: 'Roadmap restructured (6 operations)',
    });
    // The group's members are not listed separately.
    expect(list.filter((c) => c.id > list[0]!.id)).toHaveLength(0);
    expect(list.filter((c) => c.entity === 'roadmap')).toHaveLength(1);
    s.d.revert.revert(list[0]!.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('reverting by a member id reverts the whole group', () => {
    const s = setup();
    const before = snapshot(s.d, s.p.id);
    s.d.restructure.restructure(s.p.id, { operations: ops(s) }, UI);
    const member = s.d.db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.entity, 'task'), eq(changeLog.action, 'move')))
      .get()!;
    const r = s.d.revert.revert(member.id, UI);
    expect(r).toMatchObject({ entity: 'roadmap', action: 'restructure' });
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('a later change to a task of the restructure blocks it', () => {
    const s = setup();
    s.d.restructure.restructure(s.p.id, { operations: ops(s) }, UI);
    const head = lastChange(s.d, s.p.id);
    s.d.roadmap.completeTask(s.bom, UI);
    const done = lastChange(s.d, s.p.id);
    expect(
      expectDomainError(() => s.d.revert.revert(head.id, UI), 'conflict').details,
    ).toMatchObject({
      blockedBy: done.id,
    });
  });

  it('a restructure approved from a proposal is also one revertible change', () => {
    const s = setup();
    const before = snapshot(s.d, s.p.id);
    const g = s.d.restructure.restructure(s.p.id, { operations: ops(s) }, CLAUDE);
    expect(g.applied).toBe(false);
    if (g.applied) return;
    s.d.proposals.approve(g.proposal.id, {}, UI);
    const head = s.d.revert.list(s.p.id).find((c) => c.entity === 'roadmap')!;
    s.d.revert.revert(head.id, UI);
    expect(snapshot(s.d, s.p.id)).toEqual(before);
  });

  it('a rolled-back preview leaves no change rows behind', () => {
    const s = setup();
    const n = s.d.db.select().from(changeLog).all().length;
    s.d.restructure.preview(s.p.id, ops(s), UI);
    expect(s.d.db.select().from(changeLog).all()).toHaveLength(n);
  });
});

describe('revert: Claude proposes, the user confirms (D75)', () => {
  it('Claude cannot revert directly, even confirmed', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const c = lastChange(s.d, s.p.id);
    expectDomainError(() => s.d.revert.revert(c.id, CLAUDE_CONFIRMED), 'forbidden');
    expect(s.d.roadmap.getTask(s.bom).done).toBe(true);
  });

  it('propose always creates a proposal; approving reverts as the user', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const c = lastChange(s.d, s.p.id);
    const prop = s.d.revert.propose(s.p.id, c.id, 'completed by mistake', CLAUDE_CONFIRMED);
    expect(prop).toMatchObject({
      kind: 'revert_change',
      state: 'pending',
      payload: { changeId: c.id, summary: 'Completed task "BOM"' },
      reason: 'completed by mistake',
    });
    expect(s.d.roadmap.getTask(s.bom).done).toBe(true);
    s.d.proposals.approve(prop.id, {}, UI);
    expect(s.d.roadmap.getTask(s.bom).done).toBe(false);
    expect(s.d.revert.get(c.id).revertedAt).not.toBeNull();
    const rev = s.d.diary.list(s.p.id, {}).find((e) => e.eventKind === 'reverted')!;
    expect(rev.source).toBe('ui');
  });

  it('propose refuses what the revert would refuse', () => {
    const s = setup();
    s.d.roadmap.addTask(s.design, { title: 'X' }, CLAUDE);
    const create = lastChange(s.d, s.p.id);
    expectDomainError(() => s.d.revert.propose(s.p.id, create.id, '', CLAUDE), 'validation');
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const done = lastChange(s.d, s.p.id);
    s.d.roadmap.reopenTask(s.bom, CLAUDE);
    expectDomainError(() => s.d.revert.propose(s.p.id, done.id, '', CLAUDE), 'conflict');
    expect(s.d.proposals.list(s.p.id)).toHaveLength(0);
  });

  it('propose refuses a change of another project', () => {
    const s = setup();
    const other = seedProject(s.d, { name: 'Other' });
    s.d.roadmap.completeTask(s.bom, UI);
    const c = lastChange(s.d, s.p.id);
    expectDomainError(() => s.d.revert.propose(other.id, c.id, '', CLAUDE), 'not_found');
  });

  it('approving a proposal whose revert became blocked fails and keeps it pending', () => {
    const s = setup();
    s.d.roadmap.completeTask(s.bom, CLAUDE);
    const c = lastChange(s.d, s.p.id);
    const prop = s.d.revert.propose(s.p.id, c.id, '', CLAUDE);
    s.d.roadmap.updateTask(s.bom, { notes: 'later' }, UI);
    expectDomainError(() => s.d.proposals.approve(prop.id, {}, UI), 'conflict');
    expect(s.d.proposals.get(prop.id).state).toBe('pending');
    expect(s.d.roadmap.getTask(s.bom).done).toBe(true);
  });
});

describe('revert: random sequences undo exactly, newest first (property)', () => {
  /** Small deterministic PRNG (mulberry32). */
  function rng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => {
      t = makeDomain();
      const d = t.d;
      const p = d.projects.create(
        {
          name: `P${seed}`,
          phases: [
            { title: 'A', tasks: ['a1', 'a2', 'a3'] },
            { title: 'B', tasks: ['b1', 'b2'] },
            { title: 'C', tasks: ['c1'] },
          ],
        },
        UI,
      );
      d.materials.add(p.id, { name: 'm1', phaseId: p.phases[0]!.id }, UI);
      d.materials.add(p.id, { name: 'm2' }, UI);
      const r = rng(seed);
      const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)];
      const states = [snapshot(d, p.id)];
      const changes: number[] = [];
      for (let i = 0; i < 14; i++) {
        t.clock.advance(1000);
        const ph = d.roadmap.phasesOf(p.id);
        const all = ph.flatMap((x) => x.tasks);
        const open = all.filter((x) => !x.done);
        const done = all.filter((x) => x.done);
        const mats = d.materials.list(p.id);
        const n = d.revert.list(p.id, { limit: 1 })[0]!.id;
        const kind = Math.floor(r() * 11);
        try {
          if (kind === 0 && open.length) d.roadmap.completeTask(pick(open)!.id, UI);
          else if (kind === 1 && done.length) d.roadmap.reopenTask(pick(done)!.id, UI);
          else if (kind === 2 && all.length)
            d.roadmap.updateTask(pick(all)!.id, { title: `t${i}`, notes: `n${i}` }, UI);
          else if (kind === 3 && all.length && ph.length)
            d.roadmap.moveTask(
              pick(all)!.id,
              { phaseId: pick(ph)!.id, position: Math.floor(r() * 4) },
              UI,
            );
          else if (kind === 4 && all.length > 2) d.roadmap.deleteTask(pick(all)!.id, UI);
          else if (kind === 5 && ph.length > 1) d.roadmap.deletePhase(pick(ph)!.id, UI);
          else if (kind === 6 && ph.length)
            d.roadmap.movePhase(pick(ph)!.id, { position: Math.floor(r() * 3) }, UI);
          else if (kind === 7)
            d.projects.setStatus(
              p.id,
              { status: pick(['on_hold', 'in_development', 'completed'] as const)!, note: `s${i}` },
              UI,
            );
          else if (kind === 8 && open.length) d.roadmap.setNextTask(p.id, pick(open)!.id, UI);
          else if (kind === 9 && mats.length) {
            const m = pick(mats)!;
            if (r() < 0.5) d.materials.update(m.id, { name: `m${i}`, quantity: i + 1 }, UI);
            else d.materials.delete(m.id, UI);
          } else if (kind === 10 && ph.length && all.length) {
            d.restructure.restructure(
              p.id,
              {
                operations: [
                  { op: 'add_phase', ref: 'x', title: `X${i}`, position: 0 },
                  { op: 'move_task', taskId: pick(all)!.id, phase: 'x', position: 0 },
                  { op: 'add_task', phase: pick(ph)!.id, title: `new${i}`, position: 1 },
                  { op: 'update_phase', phase: pick(ph)!.id, description: `d${i}` },
                ],
              },
              UI,
            );
          } else continue;
        } catch {
          continue;
        }
        const c = d.revert.list(p.id, { limit: 1 })[0]!;
        if (c.id === n) continue; // a no-op (e.g. same next step) records nothing
        expect(c.revertible).toBe(true);
        changes.push(c.id);
        states.push(snapshot(d, p.id));
      }
      // Undo newest first: each revert must land exactly on the state before that change.
      for (let k = changes.length - 1; k >= 0; k--) {
        d.revert.revert(changes[k]!, UI);
        expect(snapshot(d, p.id)).toEqual(states[k]);
      }
    });
  }
});
