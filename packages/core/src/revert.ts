import {
  ChangesQuery,
  type ChangeView,
  type LifecycleStatus,
  type ProposalView,
} from '@heph/schema';
import { and, asc, desc, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { GROUP_HEAD } from './audit.js';
import type { Ctx } from './context.js';
import { changeLog, files, materials, phases, projects, tasks } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError, notFound } from './errors.js';
import type { ProjectRef } from './projects.js';
import { type DeletedLinks, type PhaseState, syncedPhaseStatus } from './roadmap.js';
import { iso, parse, reorder } from './util.js';

type LogRow = typeof changeLog.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type PhaseRow = typeof phases.$inferSelect;
type MaterialRow = typeof materials.$inferSelect;
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * What a change touched and what it needs to still exist (D74). Two changes
 * conflict when a later one touches a key of an earlier one, or deleted
 * something the earlier one needs. Side effects count as touches, so a revert
 * never overwrites a later change (verification A9):
 * - `task:<id>`, `phase:<id>`, `material:<id>`: the item itself;
 * - `order:<phase>`: the task order of a phase (task create, move, delete; phase create, delete);
 * - `phases:<project>`: the phase order (phase create, move, delete);
 * - `pstatus:<phase>`: the stored phase status, when a change moved it;
 * - `status:<project>`, `next:<project>`: project status and next-step override.
 * `set_next_task` also touches the tasks it points from and to.
 */
export function keysOf(
  r: Pick<LogRow, 'entity' | 'entityId' | 'action' | 'before' | 'after' | 'projectId'>,
): {
  touches: string[];
  needs: string[];
} {
  const b = obj(r.before);
  const a = obj(r.after);
  const touches: string[] = [];
  const needs: string[] = [];
  // Phases whose stored status the change moved.
  const before = new Map(phaseStatesOf(b.phaseStates).map((p) => [p.id, p]));
  for (const p of phaseStatesOf(a.phaseStates)) {
    const was = before.get(p.id);
    if (!was || was.status !== p.status || was.completedAt !== p.completedAt) {
      touches.push(`pstatus:${p.id}`);
    }
  }
  switch (r.entity) {
    case 'task': {
      touches.push(`task:${r.entityId}`);
      if (r.action === 'create') touches.push(`order:${num(a.phaseId)}`);
      if (r.action === 'delete') {
        const phaseId = num(obj(b.task).phaseId);
        touches.push(`order:${phaseId}`);
        needs.push(`phase:${phaseId}`);
        if (num(b.override) !== null) touches.push(`next:${r.projectId}`);
      }
      if (r.action === 'move') {
        touches.push(`order:${num(b.phaseId)}`, `order:${num(a.phaseId)}`);
        needs.push(`phase:${num(b.phaseId)}`);
      }
      if (r.action === 'complete' && b.wasOverride === true) touches.push(`next:${r.projectId}`);
      break;
    }
    case 'phase': {
      touches.push(`phase:${r.entityId}`);
      if (r.action === 'create' || r.action === 'delete') {
        touches.push(`order:${r.entityId}`, `pstatus:${r.entityId}`, `phases:${r.projectId}`);
      }
      if (r.action === 'move') touches.push(`phases:${r.projectId}`);
      if (r.action === 'update' && 'status' in a) touches.push(`pstatus:${r.entityId}`);
      if (r.action === 'delete') {
        for (const t of Array.isArray(b.tasks) ? b.tasks : [])
          touches.push(`task:${num(obj(t).id)}`);
        for (const m of Array.isArray(b.materialIds) ? b.materialIds : [])
          touches.push(`material:${m}`);
        if (num(b.override) !== null) touches.push(`next:${r.projectId}`);
      }
      break;
    }
    case 'material':
      touches.push(`material:${r.entityId}`);
      break;
    case 'project':
      if (r.action === 'set_status' || r.action === 'test_outcome') {
        touches.push(`status:${r.projectId}`);
      }
      if (r.action === 'set_next_task') {
        touches.push(`next:${r.projectId}`);
        for (const id of [num(b.nextTaskOverrideId), num(a.nextTaskOverrideId)]) {
          if (id !== null) touches.push(`task:${id}`);
        }
      }
      break;
  }
  return { touches, needs };
}

/** English one-line summary of a change (diary body of a revert, MCP list). */
export function summaryOf(
  v: Pick<ChangeView, 'entity' | 'action' | 'label' | 'fields' | 'status' | 'operations'>,
): string {
  const q = v.label ? ` "${v.label}"` : '';
  switch (`${v.entity}/${v.action}`) {
    case 'task/create':
      return `Added task${q}`;
    case 'task/update':
      return `Edited task${q} (${v.fields.join(', ')})`;
    case 'task/move':
      return `Moved task${q}`;
    case 'task/complete':
      return `Completed task${q}`;
    case 'task/reopen':
      return `Reopened task${q}`;
    case 'task/delete':
      return `Deleted task${q}`;
    case 'phase/create':
      return `Added phase${q}`;
    case 'phase/update':
      return `Edited phase${q} (${v.fields.join(', ')})`;
    case 'phase/move':
      return `Moved phase${q}`;
    case 'phase/delete':
      return `Deleted phase${q}`;
    case 'project/set_status':
      return v.status ? `Status ${v.status.from} → ${v.status.to}` : 'Status changed';
    case 'project/set_next_task':
      return v.label ? `Next step set to "${v.label}"` : 'Next step cleared';
    case 'material/create':
      return `Added material${q}`;
    case 'material/update':
      return `Edited material${q} (${v.fields.join(', ')})`;
    case 'material/delete':
      return `Deleted material${q}`;
    case 'roadmap/restructure':
      return `Roadmap restructured (${v.operations ?? 0} operation${v.operations === 1 ? '' : 's'})`;
    default:
      return `${v.entity} ${v.action.replaceAll('_', ' ')}${q}`;
  }
}

/**
 * Reverting recorded changes (D31, D74, D75). A change is one `change_log` row,
 * or a restructure group shown as its head row. Only the user reverts; Claude
 * can only propose (D75).
 */
export class RevertService {
  constructor(private readonly d: Domain) {}

  /** The project's changes, newest first. Members of a group are folded into its head. */
  list(projectRef: ProjectRef, query: unknown = {}): ChangeView[] {
    const q = parse(ChangesQuery, query);
    const project = this.d.projects.row(projectRef);
    const rows = this.d.db
      .select()
      .from(changeLog)
      .where(
        and(
          eq(changeLog.projectId, project.id),
          // The revert bookkeeping rows are not changes the user made.
          ne(changeLog.entity, 'change'),
          or(isNull(changeLog.groupId), eq(changeLog.groupId, changeLog.id)),
          q.before !== undefined ? lt(changeLog.id, q.before) : undefined,
          q.revertible ? eq(changeLog.revertible, true) : undefined,
        ),
      )
      .orderBy(desc(changeLog.id))
      .limit(q.limit)
      .all();
    return rows.map((r) => this.toView(r));
  }

  get(id: number): ChangeView {
    return this.toView(this.head(id));
  }

  /**
   * Checks that a change can be reverted now; throws the reason otherwise:
   * `validation` (kind never revertible), `conflict` (already reverted, or a
   * later change must be reverted first: `details.blockedBy`).
   */
  check(id: number): { head: LogRow; rows: LogRow[] } {
    const head = this.head(id);
    if (head.revertedAt !== null) {
      throw new DomainError('conflict', `Change ${head.id} was already reverted`, {
        reason: 'already_reverted',
      });
    }
    if (!head.revertible || head.projectId === null) {
      throw new DomainError('validation', `Change ${head.id} cannot be reverted`, {
        reason: 'not_revertible',
      });
    }
    const rows = this.membersOf(head);
    const blocker = this.blocker(head.projectId, rows);
    if (blocker !== null) {
      const b = this.get(blocker);
      throw new DomainError(
        'conflict',
        `Revert change ${blocker} first (${b.summary}): it changed the same item later`,
        { reason: 'blocked', blockedBy: blocker },
      );
    }
    return { head, rows };
  }

  /** Reverts a change as the user. Returns the reverted change. */
  revert(id: number, ctx: Ctx): ChangeView {
    if (ctx.source !== 'ui') {
      throw new DomainError('forbidden', 'Only the user can revert a change; propose it instead');
    }
    this.d.tx(() => {
      const { head, rows } = this.check(id);
      const projectId = head.projectId as number;
      this.d.projects.writable(projectId, ctx);
      const view = this.toView(head);
      this.d.audit.muted(() => {
        for (const r of [...rows].reverse()) {
          // Decide before the inverse step: it re-syncs the phases it touches.
          const restore = this.phasesToRestore(r);
          this.undo(r, projectId);
          this.restorePhaseStates(restore);
        }
      });
      const now = this.d.now();
      for (const r of rows) {
        this.d.db.update(changeLog).set({ revertedAt: now }).where(eq(changeLog.id, r.id)).run();
      }
      this.d.audit.record(ctx, {
        projectId,
        entity: 'change',
        entityId: head.id,
        action: 'revert',
      });
      this.d.diary.event(
        projectId,
        'reverted',
        `Reverted: ${view.summary}`,
        { changeId: head.id, entity: head.entity, action: head.action },
        ctx,
      );
    });
    return this.get(id);
  }

  /**
   * Claude proposes a revert (D75): always a proposal the user approves in the UI,
   * also with `confirmed: true`. Refused now if the revert would be refused.
   */
  propose(projectRef: ProjectRef, changeId: number, reason: string, ctx: Ctx): ProposalView {
    const project = this.d.projects.writable(projectRef, ctx);
    const head = this.head(changeId);
    if (head.projectId !== project.id) throw notFound('Change', changeId);
    this.check(head.id);
    const view = this.toView(head);
    return this.d.proposals.create(
      project.id,
      'revert_change',
      { changeId: head.id, summary: view.summary },
      reason,
      ctx,
    );
  }

  // ------------------------------------------------------------ internals

  /** The change a row belongs to: the row itself, or its group's head. */
  private head(id: number): LogRow {
    const row = this.d.db.select().from(changeLog).where(eq(changeLog.id, id)).get();
    if (!row || row.entity === 'change') throw notFound('Change', id);
    if (row.groupId !== null && row.groupId !== row.id) return this.head(row.groupId);
    return row;
  }

  /** Rows a change consists of, oldest first (the head itself for a single change). */
  private membersOf(head: LogRow): LogRow[] {
    if (head.groupId === null) return [head];
    return this.d.db
      .select()
      .from(changeLog)
      .where(eq(changeLog.groupId, head.id))
      .orderBy(asc(changeLog.id))
      .all();
  }

  /** The newest later change, not reverted, that conflicts with `rows`; null when none. */
  private blocker(projectId: number, rows: LogRow[]): number | null {
    const touches = new Set<string>();
    const needs = new Set<string>();
    for (const r of rows) {
      const k = keysOf(r);
      for (const t of k.touches) touches.add(t);
      for (const n of k.needs) needs.add(n);
    }
    const last = Math.max(...rows.map((r) => r.id));
    const later = this.d.db
      .select()
      .from(changeLog)
      .where(
        and(
          eq(changeLog.projectId, projectId),
          gt(changeLog.id, last),
          isNull(changeLog.revertedAt),
        ),
      )
      .orderBy(desc(changeLog.id))
      .all();
    for (const l of later) {
      const k = keysOf(l);
      const hit =
        k.touches.some((t) => touches.has(t)) ||
        (l.action === 'delete' && k.touches.some((t) => needs.has(t)));
      if (hit) return l.groupId ?? l.id;
    }
    return null;
  }

  /** Applies the inverse of one row. Runs with the audit muted, inside the revert's transaction. */
  private undo(r: LogRow, projectId: number): void {
    const b = obj(r.before);
    const a = obj(r.after);
    const id = r.entityId as number;
    switch (`${r.entity}/${r.action}`) {
      case `${GROUP_HEAD.entity}/${GROUP_HEAD.action}`:
        return;
      case 'task/create':
        this.taskOrConflict(id);
        this.d.roadmap.removeTask(id, { source: 'ui' });
        return;
      case 'task/update': {
        this.taskOrConflict(id);
        const set: Partial<TaskRow> = {};
        for (const f of ['title', 'notes', 'link'] as const) {
          if (f in a) (set as Obj)[f] = b[f] ?? (f === 'link' ? null : '');
        }
        this.d.db
          .update(tasks)
          .set({ ...set, updatedAt: this.d.now() })
          .where(eq(tasks.id, id))
          .run();
        return;
      }
      case 'task/move':
        this.taskOrConflict(id);
        this.d.roadmap.moveTask(
          id,
          { phaseId: num(b.phaseId) ?? undefined, position: num(b.position) ?? 0 },
          { source: 'ui' },
        );
        return;
      case 'task/complete': {
        const t = this.taskOrConflict(id);
        this.d.db
          .update(tasks)
          .set({ done: false, doneAt: null, updatedAt: this.d.now() })
          .where(eq(tasks.id, id))
          .run();
        if (b.wasOverride === true) this.restoreOverride(projectId, id);
        this.d.roadmap.syncPhase(t.phaseId);
        return;
      }
      case 'task/reopen': {
        const t = this.taskOrConflict(id);
        this.d.db
          .update(tasks)
          .set({ done: true, doneAt: num(b.doneAt) ?? this.d.now(), updatedAt: this.d.now() })
          .where(eq(tasks.id, id))
          .run();
        this.d.db
          .update(projects)
          .set({ nextTaskOverrideId: null })
          .where(and(eq(projects.id, projectId), eq(projects.nextTaskOverrideId, id)))
          .run();
        this.d.roadmap.syncPhase(t.phaseId);
        return;
      }
      case 'task/delete': {
        const task = obj(b.task) as unknown as TaskRow;
        this.phaseOrConflict(task.phaseId);
        this.insertTask(task);
        this.reattach(projectId, b as unknown as DeletedLinks);
        this.d.roadmap.syncPhase(task.phaseId);
        return;
      }
      case 'phase/create':
        this.phaseOrConflict(id);
        this.d.roadmap.removePhase(id, { source: 'ui' });
        return;
      case 'phase/update': {
        this.phaseOrConflict(id);
        const set: Partial<PhaseRow> = {};
        if ('title' in a) set.title = String(b.title ?? '');
        if ('description' in a) set.description = String(b.description ?? '');
        if ('status' in a) {
          set.status = b.status as PhaseRow['status'];
          set.completedAt = num(b.completedAt);
        }
        this.d.db
          .update(phases)
          .set({ ...set, updatedAt: this.d.now() })
          .where(eq(phases.id, id))
          .run();
        return;
      }
      case 'phase/move':
        this.phaseOrConflict(id);
        this.d.roadmap.movePhase(id, { position: num(b.position) ?? 0 }, { source: 'ui' });
        return;
      case 'phase/delete': {
        const phase = obj(b.phase) as unknown as PhaseRow;
        const ts = (Array.isArray(b.tasks) ? b.tasks : []) as TaskRow[];
        this.insertPhase(phase);
        for (const t of [...ts].sort((x, y) => x.position - y.position)) this.insertTask(t);
        this.reattach(projectId, b as unknown as DeletedLinks);
        return;
      }
      case 'project/set_status':
        this.d.db
          .update(projects)
          .set({
            lifecycleStatus: b.status as LifecycleStatus,
            statusNote: String(b.note ?? ''),
            statusChangedAt: this.d.now(),
            updatedAt: this.d.now(),
          })
          .where(eq(projects.id, projectId))
          .run();
        return;
      case 'project/set_next_task': {
        const target = num(b.nextTaskOverrideId);
        const t =
          target === null
            ? undefined
            : this.d.db.select().from(tasks).where(eq(tasks.id, target)).get();
        this.d.db
          .update(projects)
          .set({
            nextTaskOverrideId: t && !t.done && t.projectId === projectId ? t.id : null,
            updatedAt: this.d.now(),
          })
          .where(eq(projects.id, projectId))
          .run();
        return;
      }
      case 'material/update': {
        if (!this.d.db.select().from(materials).where(eq(materials.id, id)).get()) {
          throw gone();
        }
        const set: Obj = {};
        for (const f of Object.keys(a)) {
          const col = f === 'price' ? 'priceCents' : f;
          if (col in b) set[col] = b[col];
        }
        if (typeof set.phaseId === 'number' && !this.phaseExists(set.phaseId)) set.phaseId = null;
        this.d.db
          .update(materials)
          .set({ ...(set as Partial<MaterialRow>), updatedAt: this.d.now() })
          .where(eq(materials.id, id))
          .run();
        return;
      }
      case 'material/delete': {
        const m = b as unknown as MaterialRow;
        this.d.db
          .insert(materials)
          .values({
            ...m,
            phaseId: m.phaseId !== null && this.phaseExists(m.phaseId) ? m.phaseId : null,
            updatedAt: this.d.now(),
          })
          .run();
        return;
      }
      default:
        throw new DomainError('validation', `Change ${r.id} cannot be reverted`, {
          reason: 'not_revertible',
        });
    }
  }

  /**
   * Phase status is kept in sync with the tasks, so a task change can move it.
   * A phase goes back to its recorded state when it is still in the state the
   * change left; otherwise later changes moved it and it is re-synced instead.
   */
  private phasesToRestore(r: LogRow): { state: PhaseState; exact: boolean }[] {
    const after = new Map(phaseStatesOf(obj(r.after).phaseStates).map((p) => [p.id, p]));
    return phaseStatesOf(obj(r.before).phaseStates).map((state) => {
      const now = this.d.db.select().from(phases).where(eq(phases.id, state.id)).get();
      const left = after.get(state.id);
      const exact =
        !!now && !!left && left.status === now.status && left.completedAt === now.completedAt;
      return { state, exact };
    });
  }

  /**
   * The recorded state is put back only if it still agrees with the phase's tasks
   * (verification A9: never a done phase with open tasks); otherwise the phase is re-synced.
   */
  private consistent(state: PhaseState): boolean {
    const ts = this.d.db
      .select({ done: tasks.done })
      .from(tasks)
      .where(eq(tasks.phaseId, state.id))
      .all();
    return syncedPhaseStatus(state.status, ts) === state.status;
  }

  private restorePhaseStates(list: { state: PhaseState; exact: boolean }[]): void {
    for (const { state, exact } of list) {
      if (!this.phaseExists(state.id)) continue;
      if (exact && this.consistent(state)) {
        this.d.db
          .update(phases)
          .set({ status: state.status, completedAt: state.completedAt })
          .where(eq(phases.id, state.id))
          .run();
      } else {
        this.d.roadmap.syncPhase(state.id);
      }
    }
  }

  /** Puts a deleted task back with its id, at its old position among its siblings. */
  private insertTask(t: TaskRow): void {
    this.d.db
      .insert(tasks)
      .values({ ...t, updatedAt: this.d.now() })
      .run();
    const siblings = this.d.db
      .select()
      .from(tasks)
      .where(eq(tasks.phaseId, t.phaseId))
      .orderBy(asc(tasks.position), asc(tasks.id))
      .all();
    const self = siblings.find((x) => x.id === t.id) as TaskRow;
    reorder(siblings, self, t.position).forEach((x, i) => {
      if (x.position !== i || x.id === t.id) {
        this.d.db.update(tasks).set({ position: i }).where(eq(tasks.id, x.id)).run();
      }
    });
  }

  /** Puts a deleted phase back with its id, at its old position. */
  private insertPhase(p: PhaseRow): void {
    this.d.db
      .insert(phases)
      .values({ ...p, updatedAt: this.d.now() })
      .run();
    const siblings = this.d.db
      .select()
      .from(phases)
      .where(eq(phases.projectId, p.projectId))
      .orderBy(asc(phases.position), asc(phases.id))
      .all();
    const self = siblings.find((x) => x.id === p.id) as PhaseRow;
    reorder(siblings, self, p.position).forEach((x, i) => {
      if (x.position !== i || x.id === p.id) {
        this.d.db.update(phases).set({ position: i }).where(eq(phases.id, x.id)).run();
      }
    });
  }

  /**
   * Re-attaches files and materials of a deleted phase or task that are still
   * where the deletion left them (project level), and the next-step override
   * when none was set since.
   */
  private reattach(projectId: number, links: Partial<DeletedLinks>): void {
    for (const f of links.files ?? []) {
      this.d.db
        .update(files)
        .set({ phaseId: f.phaseId, taskId: f.taskId, updatedAt: this.d.now() })
        .where(
          and(
            eq(files.id, f.id),
            eq(files.projectId, projectId),
            isNull(files.phaseId),
            isNull(files.taskId),
            isNull(files.diaryEntryId),
          ),
        )
        .run();
    }
    for (const mid of links.materialIds ?? []) {
      // The phase id is the deleted phase's, back now.
      const phaseId = this.phaseIdOfLinks(links);
      if (phaseId === null) continue;
      this.d.db
        .update(materials)
        .set({ phaseId, updatedAt: this.d.now() })
        .where(
          and(eq(materials.id, mid), eq(materials.projectId, projectId), isNull(materials.phaseId)),
        )
        .run();
    }
    if (typeof links.override === 'number') this.restoreOverride(projectId, links.override);
  }

  private phaseIdOfLinks(links: Partial<DeletedLinks>): number | null {
    const phase = (links as unknown as { phase?: { id?: unknown } }).phase;
    return num(phase?.id);
  }

  /** Sets the override back to `taskId` unless another one was set since. */
  private restoreOverride(projectId: number, taskId: number): void {
    this.d.db
      .update(projects)
      .set({ nextTaskOverrideId: taskId })
      .where(and(eq(projects.id, projectId), isNull(projects.nextTaskOverrideId)))
      .run();
  }

  private taskOrConflict(id: number): TaskRow {
    const t = this.d.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!t) throw gone();
    return t;
  }

  private phaseOrConflict(id: number): void {
    if (!this.phaseExists(id)) throw gone();
  }

  private phaseExists(id: number): boolean {
    return !!this.d.db.select({ id: phases.id }).from(phases).where(eq(phases.id, id)).get();
  }

  private toView(r: LogRow): ChangeView {
    const b = obj(r.before);
    const a = obj(r.after);
    const action = r.action;
    const status =
      r.entity === 'project' && action === 'set_status'
        ? { from: b.status as LifecycleStatus, to: a.status as LifecycleStatus }
        : null;
    const base = {
      entity: r.entity,
      action,
      label: this.labelOf(r, b, a),
      fields: action === 'update' ? Object.keys(a).filter((k) => a[k] !== undefined) : [],
      status,
      operations: r.entity === GROUP_HEAD.entity ? num(a.operations) : null,
    };
    return {
      id: r.id,
      projectId: r.projectId as number,
      entityId: r.entityId,
      ...base,
      source: r.source,
      sessionId: r.sessionId,
      createdAt: iso(r.createdAt),
      revertible: r.revertible && r.revertedAt === null,
      revertedAt: iso(r.revertedAt),
      summary: summaryOf(base),
    };
  }

  /** Title or name of the touched item: from the record, else the item as it is now. */
  private labelOf(r: LogRow, b: Obj, a: Obj): string | null {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    if (r.entity === 'project' && r.action === 'set_next_task') {
      const tid = num(a.nextTaskOverrideId);
      return tid === null ? null : this.taskTitle(tid);
    }
    const stored =
      str(a.title) ??
      str(a.name) ??
      str(b.title) ??
      str(b.name) ??
      str(obj(b.task).title) ??
      str(obj(b.phase).title);
    if (r.action === 'update') {
      // An edit is named by the old title, as it was when the change was made.
      return str(b.title) ?? str(b.name) ?? stored;
    }
    if (stored) return stored;
    if (r.entityId === null) return null;
    if (r.entity === 'task') return this.taskTitle(r.entityId);
    if (r.entity === 'phase') {
      return (
        this.d.db.select({ t: phases.title }).from(phases).where(eq(phases.id, r.entityId)).get()
          ?.t ?? null
      );
    }
    return null;
  }

  private taskTitle(id: number): string | null {
    return (
      this.d.db.select({ t: tasks.title }).from(tasks).where(eq(tasks.id, id)).get()?.t ?? null
    );
  }
}

function phaseStatesOf(v: unknown): PhaseState[] {
  return Array.isArray(v) ? (v as PhaseState[]) : [];
}

function gone(): DomainError {
  return new DomainError('conflict', 'The item this change touched no longer exists', {
    reason: 'gone',
  });
}
