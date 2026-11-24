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

/** Writes before/after records of every mutation; the basis for reverts. */
export class AuditLog {
  constructor(private readonly d: Domain) {}

  record(ctx: Ctx, r: AuditRecord): void {
    this.d.db
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
        createdAt: this.d.now(),
      })
      .run();
    // Any non-system change counts as project activity.
    if (r.projectId !== null && ctx.source !== 'system') this.d.projects.touch(r.projectId);
  }
}
