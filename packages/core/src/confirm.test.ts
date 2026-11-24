import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type Ctx, SYSTEM, UI } from './context.js';
import { changeLog } from './db/schema.js';
import type { Domain } from './domain.js';
import { CLAUDE, CLAUDE_CONFIRMED, seedProject, taskIds } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  return { ...t, p };
}

function logRows(d: Domain, entity: string, action: string) {
  return d.db
    .select()
    .from(changeLog)
    .where(and(eq(changeLog.entity, entity), eq(changeLog.action, action)))
    .orderBy(asc(changeLog.id))
    .all();
}

function events(d: Domain, projectId: number, kind: string) {
  return d.diary.list(projectId).filter((e) => e.eventKind === kind);
}

describe('needsProposal', () => {
  it('follows source, confirmed and the allowClaudeConfirm setting', () => {
    const { d } = setup();
    const cases: [Ctx, boolean][] = [
      [UI, false],
      [{ source: 'ui', confirmed: true }, false],
      [SYSTEM, false],
      [{ source: 'github' }, false],
      [CLAUDE, true],
      [{ source: 'claude_code', confirmed: false }, true],
      [CLAUDE_CONFIRMED, false],
    ];
    for (const [ctx, expected] of cases) expect(d.proposals.needsProposal(ctx)).toBe(expected);
    expect(d.settings.get().allowClaudeConfirm).toBe(true);

    d.settings.update({ allowClaudeConfirm: false }, UI);
    expect(d.proposals.needsProposal(CLAUDE_CONFIRMED)).toBe(true);
    expect(d.proposals.needsProposal(CLAUDE)).toBe(true);
    expect(d.proposals.needsProposal(UI)).toBe(false);
    expect(d.proposals.needsProposal(SYSTEM)).toBe(false);

    d.settings.update({ allowClaudeConfirm: true }, UI);
    expect(d.proposals.needsProposal(CLAUDE_CONFIRMED)).toBe(false);
  });
});

describe('allowClaudeConfirm = false', () => {
  function disabled() {
    const s = setup();
    s.d.settings.update({ allowClaudeConfirm: false }, UI);
    return s;
  }

  it('confirmed delete_phase still becomes a proposal; UI approval applies it', () => {
    const { d, p } = disabled();
    const phaseId = p.phases[0]!.id;
    const prop = d.roadmap.deletePhase(phaseId, CLAUDE_CONFIRMED, 'cleanup');
    expect(prop).not.toBeNull();
    expect(prop).toMatchObject({ kind: 'delete_phase', state: 'pending', reason: 'cleanup' });
    expect(d.roadmap.phasesOf(p.id)).toHaveLength(2);
    expect(events(d, p.id, 'phase_deleted')).toHaveLength(0);
    d.proposals.approve(prop!.id, {}, UI);
    expect(d.roadmap.phasesOf(p.id).map((x) => x.title)).toEqual(['Build']);
  });

  it('confirmed delete_task still becomes a proposal; UI approval applies it', () => {
    const { d, p } = disabled();
    const taskId = p.phases[0]!.tasks[0]!.id;
    const prop = d.roadmap.deleteTask(taskId, CLAUDE_CONFIRMED);
    expect(prop).toMatchObject({ kind: 'delete_task', state: 'pending' });
    expect(taskIds(d, p.id).flat()).toContain(taskId);
    d.proposals.approve(prop!.id, {}, UI);
    expect(taskIds(d, p.id).flat()).not.toContain(taskId);
  });

  it('confirmed set_status completed/abandoned still becomes a proposal', () => {
    const { d, p } = disabled();
    const r = d.projects.setStatus(p.id, { status: 'completed', note: 'Done' }, CLAUDE_CONFIRMED);
    expect(r.applied).toBe(false);
    if (r.applied) return;
    expect(r.proposal.kind).toBe('set_status');
    expect(d.projects.get(p.id).lifecycleStatus).toBe('in_development');
    const r2 = d.projects.setStatus(p.id, { status: 'abandoned' }, CLAUDE_CONFIRMED);
    expect(r2.applied).toBe(false);
    d.proposals.approve(r.proposal.id, {}, UI);
    expect(d.projects.get(p.id).lifecycleStatus).toBe('completed');
  });

  it('non-terminal status changes still apply directly', () => {
    const { d, p } = disabled();
    const r = d.projects.setStatus(p.id, { status: 'on_hold', note: 'parts' }, CLAUDE_CONFIRMED);
    expect(r.applied).toBe(true);
  });

  it('confirmed restructure still becomes a proposal; UI approval applies it', () => {
    const { d, p } = disabled();
    const r = d.restructure.restructure(
      p.id,
      { operations: [{ op: 'add_phase', title: 'Test' }] },
      CLAUDE_CONFIRMED,
    );
    expect(r.applied).toBe(false);
    if (r.applied) return;
    expect(d.roadmap.phasesOf(p.id)).toHaveLength(2);
    d.proposals.approve(r.proposal.id, {}, UI);
    expect(d.roadmap.phasesOf(p.id).map((x) => x.title)).toEqual(['Design', 'Build', 'Test']);
  });

  it('non-destructive agent writes are unaffected', () => {
    const { d, p } = disabled();
    const task = d.roadmap.addTask(p.phases[0]!.id, { title: 'New' }, CLAUDE_CONFIRMED);
    expect(task.title).toBe('New');
    d.roadmap.completeTask(task.id, CLAUDE);
    expect(d.roadmap.getTask(task.id).done).toBe(true);
  });

  it('the user can still delete directly', () => {
    const { d, p } = disabled();
    expect(d.roadmap.deletePhase(p.phases[0]!.id, UI)).toBeNull();
    expect(d.roadmap.phasesOf(p.id)).toHaveLength(1);
  });
});

describe('change_log.confirmed', () => {
  it('is true only for claude_code + confirmed rows', () => {
    const { d, p } = setup();
    const [[schematic, bom], [caseId, wiring]] = taskIds(d, p.id) as [number[], number[]];
    d.roadmap.deleteTask(schematic!, UI);
    d.roadmap.deleteTask(bom!, { source: 'ui', confirmed: true });
    d.roadmap.deleteTask(caseId!, CLAUDE_CONFIRMED);
    const prop = d.roadmap.deleteTask(wiring!, CLAUDE)!;
    const rows = logRows(d, 'task', 'delete');
    expect(rows.map((r) => [r.entityId, r.source, r.confirmed])).toEqual([
      [schematic, 'ui', false],
      [bom, 'ui', false],
      [caseId, 'claude_code', true],
    ]);
    // The proposal itself is recorded as not confirmed.
    const propRow = logRows(d, 'proposal', 'create').find((r) => r.entityId === prop.id)!;
    expect(propRow.confirmed).toBe(false);
    // Approval applies as the user: not "confirmed in chat".
    d.proposals.approve(prop.id, {}, UI);
    const after = logRows(d, 'task', 'delete');
    expect(after.at(-1)).toMatchObject({ entityId: wiring, source: 'ui', confirmed: false });
    expect(logRows(d, 'proposal', 'approved')[0]!.confirmed).toBe(false);
  });

  it('defaults to false for ordinary writes and system rows', () => {
    const { d } = setup();
    const all = d.db.select().from(changeLog).all();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.confirmed === false)).toBe(true);
    d.settings.update({ contentLanguage: 'en' }, SYSTEM);
    expect(logRows(d, 'settings', 'update')[0]!.confirmed).toBe(false);
  });

  it('covers confirmed phase deletes and restructures (every row of the batch)', () => {
    const { d, p } = setup();
    d.roadmap.deletePhase(p.phases[0]!.id, CLAUDE_CONFIRMED);
    expect(logRows(d, 'phase', 'delete')[0]).toMatchObject({
      source: 'claude_code',
      sessionId: 'sess-1',
      confirmed: true,
    });
    const before = d.db.select().from(changeLog).all().length;
    d.restructure.restructure(
      p.id,
      {
        operations: [
          { op: 'add_phase', ref: 'n', title: 'N' },
          { op: 'add_task', phase: 'n', title: 'T' },
        ],
      },
      CLAUDE_CONFIRMED,
    );
    const added = d.db.select().from(changeLog).all().slice(before);
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(added.every((r) => r.source === 'claude_code' && r.confirmed)).toBe(true);
  });

  it('a confirmed set_status from claude is recorded as confirmed', () => {
    const { d, p } = setup();
    d.projects.setStatus(p.id, { status: 'completed' }, CLAUDE_CONFIRMED);
    expect(logRows(d, 'project', 'set_status')[0]!.confirmed).toBe(true);
  });
});

describe('deletion diary events', () => {
  it('phase_deleted from claude confirmed carries confirmedInChat', () => {
    const { d, p } = setup();
    const phase = p.phases[0]!;
    expect(d.roadmap.deletePhase(phase.id, CLAUDE_CONFIRMED)).toBeNull();
    const [ev] = events(d, p.id, 'phase_deleted');
    expect(ev).toMatchObject({
      source: 'claude_code',
      sessionId: 'sess-1',
      body: 'Deleted phase: Design (2 tasks)',
    });
    expect(ev!.data).toEqual({
      phaseId: phase.id,
      title: 'Design',
      taskCount: 2,
      confirmedInChat: true,
    });
  });

  it('phase_deleted from the user has no confirmedInChat (even with confirmed set)', () => {
    const { d, p } = setup();
    d.roadmap.deletePhase(p.phases[0]!.id, UI);
    d.roadmap.deletePhase(p.phases[1]!.id, { source: 'ui', confirmed: true });
    const evs = events(d, p.id, 'phase_deleted');
    expect(evs).toHaveLength(2);
    for (const ev of evs) {
      expect(ev.source).toBe('ui');
      expect(ev.data).not.toHaveProperty('confirmedInChat');
    }
  });

  it('task_deleted from claude confirmed carries confirmedInChat', () => {
    const { d, p } = setup();
    const task = p.phases[1]!.tasks[1]!;
    expect(d.roadmap.deleteTask(task.id, CLAUDE_CONFIRMED)).toBeNull();
    const [ev] = events(d, p.id, 'task_deleted');
    expect(ev).toMatchObject({ source: 'claude_code', body: 'Deleted task: Wiring' });
    expect(ev!.data).toEqual({ taskId: task.id, title: 'Wiring', confirmedInChat: true });
  });

  it('task_deleted from the user has no confirmedInChat', () => {
    const { d, p } = setup();
    const task = p.phases[0]!.tasks[0]!;
    d.roadmap.deleteTask(task.id, UI);
    const [ev] = events(d, p.id, 'task_deleted');
    expect(ev!.data).toEqual({ taskId: task.id, title: 'Schematic' });
  });

  it('an unconfirmed claude delete writes no deletion event until approved', () => {
    const { d, p } = setup();
    const phaseProp = d.roadmap.deletePhase(p.phases[0]!.id, CLAUDE)!;
    const taskProp = d.roadmap.deleteTask(p.phases[1]!.tasks[0]!.id, CLAUDE)!;
    expect(events(d, p.id, 'phase_deleted')).toHaveLength(0);
    expect(events(d, p.id, 'task_deleted')).toHaveLength(0);
    d.proposals.approve(phaseProp.id, {}, UI);
    d.proposals.approve(taskProp.id, {}, UI);
    const phaseEv = events(d, p.id, 'phase_deleted');
    const taskEv = events(d, p.id, 'task_deleted');
    expect(phaseEv).toHaveLength(1);
    expect(taskEv).toHaveLength(1);
    expect(phaseEv[0]!.source).toBe('ui');
    expect(phaseEv[0]!.data).not.toHaveProperty('confirmedInChat');
    expect(taskEv[0]!.data).not.toHaveProperty('confirmedInChat');
  });

  it('status_changed from claude confirmed carries confirmedInChat', () => {
    const { d, p } = setup();
    d.projects.setStatus(p.id, { status: 'abandoned', note: 'nope' }, CLAUDE_CONFIRMED);
    const [ev] = events(d, p.id, 'status_changed');
    expect(ev!.data).toMatchObject({ to: 'abandoned', confirmedInChat: true });
  });
});
