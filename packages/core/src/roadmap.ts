import {
  AddPhaseInput,
  AddTaskInput,
  MovePhaseInput,
  MoveTaskInput,
  type NextTaskRef,
  type PhaseStatus,
  type PhaseView,
  type Progress,
  type TaskView,
  UpdatePhaseInput,
  UpdateTaskInput,
} from '@heph/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { phases, projects, tasks } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError, notFound } from './errors.js';
import { parse, reorder } from './util.js';

type PhaseRow = typeof phases.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export function progressOf(items: { done: boolean }[]): Progress {
  const total = items.length;
  const done = items.filter((t) => t.done).length;
  return { done, total, ratio: total === 0 ? 0 : done / total };
}

export function toTaskView(t: TaskRow): TaskView {
  return {
    id: t.id,
    phaseId: t.phaseId,
    projectId: t.projectId,
    title: t.title,
    notes: t.notes,
    position: t.position,
    done: t.done,
    doneAt: t.doneAt,
    link: t.link,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function buildPhaseViews(phaseRows: PhaseRow[], taskRows: TaskRow[]): PhaseView[] {
  const byPhase = new Map<number, TaskView[]>();
  for (const t of [...taskRows].sort((a, b) => a.position - b.position)) {
    const list = byPhase.get(t.phaseId) ?? [];
    list.push(toTaskView(t));
    byPhase.set(t.phaseId, list);
  }
  return [...phaseRows]
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      const ts = byPhase.get(p.id) ?? [];
      return {
        id: p.id,
        projectId: p.projectId,
        title: p.title,
        description: p.description,
        position: p.position,
        status: p.status,
        completedAt: p.completedAt,
        progress: progressOf(ts),
        tasks: ts,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
}

/**
 * Next task (spec §5): the override if it points to an open task of the project,
 * else the first open task of the first non-done phase that has one.
 */
export function computeNextTask(
  phaseViews: PhaseView[],
  overrideId: number | null,
): NextTaskRef | null {
  if (overrideId !== null) {
    for (const p of phaseViews) {
      const t = p.tasks.find((x) => x.id === overrideId);
      if (t && !t.done) {
        return { id: t.id, title: t.title, phaseId: p.id, phaseTitle: p.title, overridden: true };
      }
    }
  }
  for (const p of phaseViews) {
    if (p.status === 'done') continue;
    const t = p.tasks.find((x) => !x.done);
    if (t)
      return { id: t.id, title: t.title, phaseId: p.id, phaseTitle: p.title, overridden: false };
  }
  return null;
}

/** Current phase: the first phase that is not done. */
export function currentPhaseOf(phaseViews: PhaseView[]): PhaseView | null {
  return phaseViews.find((p) => p.status !== 'done') ?? null;
}

/** Phase status implied by its tasks, given the current (possibly explicit) status. */
export function syncedPhaseStatus(current: PhaseStatus, ts: { done: boolean }[]): PhaseStatus {
  if (ts.length === 0) return current;
  const done = ts.filter((t) => t.done).length;
  if (done === ts.length) return 'done';
  if (current === 'done') return done > 0 ? 'in_progress' : 'todo';
  if (done > 0) return 'in_progress';
  return current;
}

export class RoadmapService {
  constructor(private readonly d: Domain) {}

  // ------------------------------------------------------------ reads

  phasesOf(projectId: number): PhaseView[] {
    const ps = this.d.db.select().from(phases).where(eq(phases.projectId, projectId)).all();
    const ts = this.d.db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
    return buildPhaseViews(ps, ts);
  }

  /** Phases and tasks for many projects at once (dashboard). */
  phasesOfMany(projectIds: number[]): Map<number, PhaseView[]> {
    const out = new Map<number, PhaseView[]>();
    if (projectIds.length === 0) return out;
    const ps = this.d.db.select().from(phases).where(inArray(phases.projectId, projectIds)).all();
    const ts = this.d.db.select().from(tasks).where(inArray(tasks.projectId, projectIds)).all();
    for (const id of projectIds) {
      out.set(
        id,
        buildPhaseViews(
          ps.filter((p) => p.projectId === id),
          ts.filter((t) => t.projectId === id),
        ),
      );
    }
    return out;
  }

  nextTaskOf(projectId: number): NextTaskRef | null {
    const p = this.d.db
      .select({ o: projects.nextTaskOverrideId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!p) throw notFound('Project', projectId);
    return computeNextTask(this.phasesOf(projectId), p.o);
  }

  getPhase(id: number): PhaseRow {
    const row = this.d.db.select().from(phases).where(eq(phases.id, id)).get();
    if (!row) throw notFound('Phase', id);
    return row;
  }

  getTask(id: number): TaskView {
    return toTaskView(this.taskRow(id));
  }

  // ------------------------------------------------------------ phases

  addPhase(projectRef: number | string, input: unknown, ctx: Ctx): PhaseView {
    const data = parse(AddPhaseInput, input);
    const project = this.d.projects.writable(projectRef, ctx);
    return this.d.tx(() => {
      const now = this.d.now();
      const siblings = this.phaseRows(project.id);
      const row = this.d.db
        .insert(phases)
        .values({
          projectId: project.id,
          title: data.title,
          description: data.description ?? '',
          position: siblings.length,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (data.position !== undefined && data.position < siblings.length) {
        this.renumberPhases(reorder([...siblings, row], row, data.position));
      }
      this.d.audit.record(ctx, {
        projectId: project.id,
        entity: 'phase',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return this.phaseView(row.id);
    });
  }

  updatePhase(id: number, input: unknown, ctx: Ctx): PhaseView {
    const data = parse(UpdatePhaseInput, input);
    const before = this.getPhase(id);
    this.d.projects.writable(before.projectId, ctx);
    return this.d.tx(() => {
      const now = this.d.now();
      const status = data.status ?? before.status;
      this.d.db
        .update(phases)
        .set({
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          status,
          completedAt: status === 'done' ? (before.completedAt ?? now) : null,
          updatedAt: now,
        })
        .where(eq(phases.id, id))
        .run();
      this.d.audit.record(ctx, {
        projectId: before.projectId,
        entity: 'phase',
        entityId: id,
        action: 'update',
        before,
        after: data,
      });
      return this.phaseView(id);
    });
  }

  movePhase(id: number, input: unknown, ctx: Ctx): PhaseView[] {
    const { position } = parse(MovePhaseInput, input);
    const phase = this.getPhase(id);
    this.d.projects.writable(phase.projectId, ctx);
    return this.d.tx(() => {
      const siblings = this.phaseRows(phase.projectId);
      const target = siblings.find((p) => p.id === id) as PhaseRow;
      this.renumberPhases(reorder(siblings, target, position));
      this.d.audit.record(ctx, {
        projectId: phase.projectId,
        entity: 'phase',
        entityId: id,
        action: 'move',
        before: { position: phase.position },
        after: { position },
      });
      return this.phasesOf(phase.projectId);
    });
  }

  /** Destructive: agent calls without confirmation become a proposal. */
  deletePhase(id: number, ctx: Ctx, reason?: string) {
    const phase = this.getPhase(id);
    this.d.projects.writable(phase.projectId, ctx);
    if (this.d.proposals.needsProposal(ctx)) {
      return this.d.proposals.create(
        phase.projectId,
        'delete_phase',
        { phaseId: id, title: phase.title, taskCount: this.taskRowsOfPhase(id).length },
        reason ?? '',
        ctx,
      );
    }
    this.d.tx(() => {
      const ts = this.taskRowsOfPhase(id);
      this.clearOverrideIfIn(
        phase.projectId,
        ts.map((t) => t.id),
      );
      this.d.files.detachToProject({ phaseId: id, taskIds: ts.map((t) => t.id) });
      this.d.db.delete(phases).where(eq(phases.id, id)).run();
      this.renumberPhases(this.phaseRows(phase.projectId));
      this.d.audit.record(ctx, {
        projectId: phase.projectId,
        entity: 'phase',
        entityId: id,
        action: 'delete',
        before: { phase, tasks: ts },
      });
    });
    return null;
  }

  // ------------------------------------------------------------ tasks

  addTask(phaseId: number, input: unknown, ctx: Ctx): TaskView {
    const data = parse(AddTaskInput, input);
    const phase = this.getPhase(phaseId);
    this.d.projects.writable(phase.projectId, ctx);
    return this.d.tx(() => {
      const now = this.d.now();
      const siblings = this.taskRowsOfPhase(phaseId);
      const row = this.d.db
        .insert(tasks)
        .values({
          phaseId,
          projectId: phase.projectId,
          title: data.title,
          notes: data.notes ?? '',
          link: data.link ?? null,
          position: siblings.length,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (data.position !== undefined && data.position < siblings.length) {
        this.renumberTasks(reorder([...siblings, row], row, data.position));
      }
      this.syncPhase(phaseId);
      this.d.audit.record(ctx, {
        projectId: phase.projectId,
        entity: 'task',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return this.getTask(row.id);
    });
  }

  updateTask(id: number, input: unknown, ctx: Ctx): TaskView {
    const data = parse(UpdateTaskInput, input);
    const before = this.taskRow(id);
    this.d.projects.writable(before.projectId, ctx);
    return this.d.tx(() => {
      this.d.db
        .update(tasks)
        .set({
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
          ...(data.link !== undefined ? { link: data.link } : {}),
          updatedAt: this.d.now(),
        })
        .where(eq(tasks.id, id))
        .run();
      this.d.audit.record(ctx, {
        projectId: before.projectId,
        entity: 'task',
        entityId: id,
        action: 'update',
        before,
        after: data,
      });
      return this.getTask(id);
    });
  }

  /** Moves a task within its phase or to another phase of the same project. */
  moveTask(id: number, input: unknown, ctx: Ctx): PhaseView[] {
    const { phaseId, position } = parse(MoveTaskInput, input);
    const task = this.taskRow(id);
    this.d.projects.writable(task.projectId, ctx);
    const targetPhaseId = phaseId ?? task.phaseId;
    if (targetPhaseId !== task.phaseId) {
      const target = this.getPhase(targetPhaseId);
      if (target.projectId !== task.projectId) {
        throw new DomainError(
          'validation',
          'Tasks can only move between phases of the same project',
        );
      }
    }
    return this.d.tx(() => {
      if (targetPhaseId !== task.phaseId) {
        this.d.db
          .update(tasks)
          .set({ phaseId: targetPhaseId, updatedAt: this.d.now() })
          .where(eq(tasks.id, id))
          .run();
        this.renumberTasks(this.taskRowsOfPhase(task.phaseId));
        this.syncPhase(task.phaseId);
      }
      const siblings = this.taskRowsOfPhase(targetPhaseId);
      const moved = siblings.find((t) => t.id === id) as TaskRow;
      this.renumberTasks(reorder(siblings, moved, position));
      this.syncPhase(targetPhaseId);
      this.d.audit.record(ctx, {
        projectId: task.projectId,
        entity: 'task',
        entityId: id,
        action: 'move',
        before: { phaseId: task.phaseId, position: task.position },
        after: { phaseId: targetPhaseId, position },
      });
      return this.phasesOf(task.projectId);
    });
  }

  /** Marks a task done and returns the new next task. */
  completeTask(id: number, ctx: Ctx): { task: TaskView; nextTask: NextTaskRef | null } {
    const task = this.taskRow(id);
    const project = this.d.projects.writable(task.projectId, ctx);
    return this.d.tx(() => {
      if (!task.done) {
        const now = this.d.now();
        this.d.db
          .update(tasks)
          .set({ done: true, doneAt: now, updatedAt: now })
          .where(eq(tasks.id, id))
          .run();
        if (project.nextTaskOverrideId === id) this.setOverride(project.id, null);
        this.syncPhase(task.phaseId);
        const nextTask = this.nextTaskOf(project.id);
        this.d.diary.event(
          project.id,
          'task_completed',
          `Completed task: ${task.title}`,
          { taskId: id, phaseId: task.phaseId, nextTaskId: nextTask?.id ?? null },
          ctx,
        );
        this.d.audit.record(ctx, {
          projectId: project.id,
          entity: 'task',
          entityId: id,
          action: 'complete',
          before: { done: false, wasOverride: project.nextTaskOverrideId === id },
          after: { done: true },
        });
      }
      return { task: this.getTask(id), nextTask: this.nextTaskOf(project.id) };
    });
  }

  reopenTask(id: number, ctx: Ctx): TaskView {
    const task = this.taskRow(id);
    this.d.projects.writable(task.projectId, ctx);
    return this.d.tx(() => {
      if (task.done) {
        this.d.db
          .update(tasks)
          .set({ done: false, doneAt: null, updatedAt: this.d.now() })
          .where(eq(tasks.id, id))
          .run();
        this.syncPhase(task.phaseId);
        this.d.diary.event(
          task.projectId,
          'task_reopened',
          `Reopened task: ${task.title}`,
          { taskId: id },
          ctx,
        );
        this.d.audit.record(ctx, {
          projectId: task.projectId,
          entity: 'task',
          entityId: id,
          action: 'reopen',
          before: { done: true, doneAt: task.doneAt },
        });
      }
      return this.getTask(id);
    });
  }

  /** Destructive: agent calls without confirmation become a proposal. */
  deleteTask(id: number, ctx: Ctx, reason?: string) {
    const task = this.taskRow(id);
    this.d.projects.writable(task.projectId, ctx);
    if (this.d.proposals.needsProposal(ctx)) {
      return this.d.proposals.create(
        task.projectId,
        'delete_task',
        { taskId: id, title: task.title },
        reason ?? '',
        ctx,
      );
    }
    this.d.tx(() => {
      this.clearOverrideIfIn(task.projectId, [id]);
      this.d.files.detachToProject({ taskIds: [id] });
      this.d.db.delete(tasks).where(eq(tasks.id, id)).run();
      this.renumberTasks(this.taskRowsOfPhase(task.phaseId));
      this.syncPhase(task.phaseId);
      this.d.audit.record(ctx, {
        projectId: task.projectId,
        entity: 'task',
        entityId: id,
        action: 'delete',
        before: task,
      });
    });
    return null;
  }

  /** Sets (or clears, with null) the next-task override. */
  setNextTask(projectRef: number | string, taskId: number | null, ctx: Ctx): NextTaskRef | null {
    const project = this.d.projects.writable(projectRef, ctx);
    if (taskId !== null) {
      const t = this.taskRow(taskId);
      if (t.projectId !== project.id)
        throw new DomainError('validation', 'Task belongs to another project');
      if (t.done) throw new DomainError('validation', 'A completed task cannot be the next step');
    }
    return this.d.tx(() => {
      const before = this.nextTaskOf(project.id);
      this.setOverride(project.id, taskId);
      const after = this.nextTaskOf(project.id);
      if (before?.id !== after?.id) {
        this.d.diary.event(
          project.id,
          'next_task_changed',
          after ? `Next step: ${after.title}` : 'Next step cleared',
          { fromTaskId: before?.id ?? null, toTaskId: after?.id ?? null },
          ctx,
        );
      }
      this.d.audit.record(ctx, {
        projectId: project.id,
        entity: 'project',
        entityId: project.id,
        action: 'set_next_task',
        before: { nextTaskOverrideId: project.nextTaskOverrideId },
        after: { nextTaskOverrideId: taskId },
      });
      return after;
    });
  }

  // ------------------------------------------------------------ internals

  private phaseView(id: number): PhaseView {
    const p = this.getPhase(id);
    const view = this.phasesOf(p.projectId).find((x) => x.id === id);
    if (!view) throw notFound('Phase', id);
    return view;
  }

  private taskRow(id: number): TaskRow {
    const row = this.d.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw notFound('Task', id);
    return row;
  }

  private phaseRows(projectId: number): PhaseRow[] {
    return this.d.db
      .select()
      .from(phases)
      .where(eq(phases.projectId, projectId))
      .orderBy(asc(phases.position), asc(phases.id))
      .all();
  }

  private taskRowsOfPhase(phaseId: number): TaskRow[] {
    return this.d.db
      .select()
      .from(tasks)
      .where(eq(tasks.phaseId, phaseId))
      .orderBy(asc(tasks.position), asc(tasks.id))
      .all();
  }

  private renumberPhases(rows: PhaseRow[]): void {
    rows.forEach((p, i) => {
      if (p.position !== i)
        this.d.db.update(phases).set({ position: i }).where(eq(phases.id, p.id)).run();
    });
  }

  private renumberTasks(rows: TaskRow[]): void {
    rows.forEach((t, i) => {
      if (t.position !== i)
        this.d.db.update(tasks).set({ position: i }).where(eq(tasks.id, t.id)).run();
    });
  }

  /** Keeps the stored phase status consistent with its tasks. */
  syncPhase(phaseId: number): void {
    const phase = this.getPhase(phaseId);
    const next = syncedPhaseStatus(phase.status, this.taskRowsOfPhase(phaseId));
    if (next !== phase.status) {
      this.d.db
        .update(phases)
        .set({
          status: next,
          completedAt: next === 'done' ? this.d.now() : null,
          updatedAt: this.d.now(),
        })
        .where(eq(phases.id, phaseId))
        .run();
    }
  }

  private setOverride(projectId: number, taskId: number | null): void {
    this.d.db
      .update(projects)
      .set({ nextTaskOverrideId: taskId, updatedAt: this.d.now() })
      .where(eq(projects.id, projectId))
      .run();
  }

  private clearOverrideIfIn(projectId: number, taskIds: number[]): void {
    if (taskIds.length === 0) return;
    this.d.db
      .update(projects)
      .set({ nextTaskOverrideId: null })
      .where(and(eq(projects.id, projectId), inArray(projects.nextTaskOverrideId, taskIds)))
      .run();
  }
}
