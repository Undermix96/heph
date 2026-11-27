import { eq } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { changeLog } from './db/schema.js';
import type { Domain } from './domain.js';

export interface AuditRecord {
  projectId: number | null;
  entity: string;
  entityId: number | null;
  action: string;
  before?: unknown;
  after?: unknown;
}

/** Head row of a restructure group (D74). */
export const GROUP_HEAD = { entity: 'roadmap', action: 'restructure' } as const;

/**
 * Whether a change of this kind can be reverted (D74). Creating a task or phase
 * alone is not revertible (delete it instead); inside a group it is.
 */
export function revertibleKind(entity: string, action: string, inGroup: boolean): boolean {
  switch (entity) {
    case 'task':
      return (
        ['complete', 'reopen', 'update', 'move', 'delete'].includes(action) ||
        (inGroup && action === 'create')
      );
    case 'phase':
      return ['update', 'move', 'delete'].includes(action) || (inGroup && action === 'create');
    case 'project':
      return action === 'set_status' || action === 'set_next_task';
    case 'material':
      return action === 'update' || action === 'delete';
    default:
      return false;
  }
}

/** Writes before/after records of every mutation; the basis for reverts (D31, D74). */
export class AuditLog {
  /** Open group: its head row id, and whether every member so far is revertible. */
  private group: { id: number; revertible: boolean } | null = null;

  constructor(private readonly d: Domain) {}

  /**
   * Runs `fn` without recording its changes: a revert's inverse steps are not
   * changes of their own; the revert writes one `change/revert` row instead (D74).
   */
  muted<T>(fn: () => T): T {
    this.mutedDepth++;
    try {
      return fn();
    } finally {
      this.mutedDepth--;
    }
  }

  private mutedDepth = 0;

  record(ctx: Ctx, r: AuditRecord): number | null {
    if (this.mutedDepth > 0) return null;
    const inGroup = this.group !== null;
    const revertible = revertibleKind(r.entity, r.action, inGroup);
    if (this.group && !revertible) this.group.revertible = false;
    const row = this.d.db
      .insert(changeLog)
      .values({
        projectId: r.projectId,
        entity: r.entity,
        entityId: r.entityId,
        action: r.action,
        before: r.before ?? null,
        after: r.after ?? null,
        source: ctx.source,
        sessionId: ctx.sessionId ?? null,
        confirmed: ctx.source === 'claude_code' && !!ctx.confirmed,
        groupId: this.group?.id ?? null,
        revertible,
        createdAt: this.d.now(),
      })
      .returning({ id: changeLog.id })
      .get();
    // Any non-system change counts as project activity.
    if (r.projectId !== null && ctx.source !== 'system') this.d.projects.touch(r.projectId);
    return row.id;
  }

  /**
   * Runs `fn` with every change it records grouped under one head row, so the
   * whole batch is reverted as one change (a restructure, D74). Must run inside
   * a transaction. Nested calls join the outer group.
   */
  grouped<T>(ctx: Ctx, head: AuditRecord, fn: () => T): T {
    if (this.group) return fn();
    const id = this.d.db
      .insert(changeLog)
      .values({
        projectId: head.projectId,
        entity: head.entity,
        entityId: head.entityId,
        action: head.action,
        before: head.before ?? null,
        after: head.after ?? null,
        source: ctx.source,
        sessionId: ctx.sessionId ?? null,
        confirmed: ctx.source === 'claude_code' && !!ctx.confirmed,
        revertible: false,
        createdAt: this.d.now(),
      })
      .returning({ id: changeLog.id })
      .get().id;
    this.group = { id, revertible: true };
    try {
      const out = fn();
      this.d.db
        .update(changeLog)
        .set({ groupId: id, revertible: this.group.revertible })
        .where(eq(changeLog.id, id))
        .run();
      return out;
    } finally {
      this.group = null;
    }
  }
}
