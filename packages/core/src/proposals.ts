import {
  DecideProposalInput,
  type ProposalKind,
  type ProposalState,
  type ProposalView,
  RestructureInput,
} from '@heph/schema';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { proposals } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError, notFound } from './errors.js';
import type { ProjectRef } from './projects.js';
import type { RestructurePayload } from './restructure.js';
import { iso, parse } from './util.js';

type ProposalRow = typeof proposals.$inferSelect;

/**
 * Pending destructive agent changes (graduated trust, spec §2.6).
 * A proposal changes nothing until the user approves it.
 */
export class ProposalsService {
  constructor(private readonly d: Domain) {}

  /** True when a destructive operation must become a proposal instead of running. */
  needsProposal(ctx: Ctx): boolean {
    if (ctx.source !== 'claude_code') return false;
    return !ctx.confirmed || !this.d.settings.get().allowClaudeConfirm;
  }

  create(
    projectId: number,
    kind: ProposalKind,
    payload: Record<string, unknown>,
    reason: string,
    ctx: Ctx,
  ): ProposalView {
    return this.d.tx(() => {
      const now = this.d.now();
      const row = this.d.db
        .insert(proposals)
        .values({
          projectId,
          kind,
          payload,
          reason,
          createdBy: ctx.source,
          sessionId: ctx.sessionId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      this.d.audit.record(ctx, {
        projectId,
        entity: 'proposal',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return toView(row);
    });
  }

  list(projectRef: ProjectRef | null, state?: ProposalState): ProposalView[] {
    const where: SQL[] = [];
    if (projectRef !== null)
      where.push(eq(proposals.projectId, this.d.projects.row(projectRef).id));
    if (state) where.push(eq(proposals.state, state));
    return this.d.db
      .select()
      .from(proposals)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(proposals.createdAt), desc(proposals.id))
      .all()
      .map(toView);
  }

  get(id: number): ProposalView {
    return toView(this.rowOf(id));
  }

  /** Applies the proposed change on behalf of the user. */
  approve(id: number, input: unknown, ctx: Ctx): ProposalView {
    const { note } = parse(DecideProposalInput, input);
    const p = this.pending(id, ctx);
    const as: Ctx = { source: ctx.source, confirmed: true };
    this.d.tx(() => {
      this.apply(p, as);
      this.decide(p, 'approved', note, ctx);
    });
    return this.get(id);
  }

  reject(id: number, input: unknown, ctx: Ctx): ProposalView {
    const { note } = parse(DecideProposalInput, input);
    const p = this.pending(id, ctx);
    this.d.tx(() => this.decide(p, 'rejected', note, ctx));
    return this.get(id);
  }

  private apply(p: ProposalRow, ctx: Ctx): void {
    const payload = p.payload;
    switch (p.kind) {
      case 'set_status':
        this.d.projects.setStatus(p.projectId, { status: payload.status, note: payload.note }, ctx);
        return;
      case 'delete_phase':
        this.d.roadmap.deletePhase(Number(payload.phaseId), ctx);
        return;
      case 'delete_task':
        this.d.roadmap.deleteTask(Number(payload.taskId), ctx);
        return;
      case 'restructure_roadmap':
        try {
          // Re-validate the stored batch: the payload is data from the database.
          const { operations } = parse(RestructureInput, {
            operations: (payload as Partial<RestructurePayload>).operations,
          });
          this.d.restructure.apply(p.projectId, operations, ctx);
        } catch (e) {
          if (e instanceof DomainError && (e.code === 'validation' || e.code === 'not_found')) {
            throw new DomainError(
              'conflict',
              `The roadmap changed since this proposal was made: ${e.message}`,
            );
          }
          throw e;
        }
        return;
      case 'revert_change':
        // D75: approving performs the revert as the user; a conflict keeps the proposal pending.
        this.d.revert.revert(Number(payload.changeId), ctx);
        return;
    }
  }

  private decide(
    p: ProposalRow,
    state: 'approved' | 'rejected',
    note: string | undefined,
    ctx: Ctx,
  ): void {
    const now = this.d.now();
    this.d.db
      .update(proposals)
      .set({ state, decisionNote: note?.trim() || null, decidedAt: now, updatedAt: now })
      .where(eq(proposals.id, p.id))
      .run();
    this.d.diary.event(
      p.projectId,
      'proposal_decided',
      `Proposal ${state}: ${p.kind}${note?.trim() ? ` — ${note.trim()}` : ''}`,
      { proposalId: p.id, kind: p.kind, state, note: note?.trim() ?? '' },
      ctx,
    );
    this.d.audit.record(ctx, {
      projectId: p.projectId,
      entity: 'proposal',
      entityId: p.id,
      action: state,
    });
  }

  private pending(id: number, ctx: Ctx): ProposalRow {
    if (ctx.source !== 'ui')
      throw new DomainError('forbidden', 'Only the user can decide on proposals');
    const p = this.rowOf(id);
    if (p.state !== 'pending')
      throw new DomainError('conflict', `Proposal ${id} is already ${p.state}`);
    return p;
  }

  private rowOf(id: number): ProposalRow {
    const row = this.d.db.select().from(proposals).where(eq(proposals.id, id)).get();
    if (!row) throw notFound('Proposal', id);
    return row;
  }
}

function toView(r: ProposalRow): ProposalView {
  return {
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    payload: r.payload,
    reason: r.reason,
    createdBy: r.createdBy,
    sessionId: r.sessionId,
    state: r.state,
    decisionNote: r.decisionNote,
    decidedAt: iso(r.decidedAt),
    createdAt: iso(r.createdAt),
  };
}
