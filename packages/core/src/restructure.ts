import {
  type Gated,
  type PhaseRef,
  type PhaseView,
  RestructureInput,
  type RestructureOp,
} from '@heph/schema';
import { GROUP_HEAD } from './audit.js';
import type { Ctx } from './context.js';
import type { Domain } from './domain.js';
import { DomainError } from './errors.js';
import type { ProjectRef } from './projects.js';
import { confirmedFlag } from './roadmap.js';
import { parse } from './util.js';

export interface RestructurePreview {
  before: string[];
  after: string[];
}

/** Proposal payload for `restructure_roadmap`. */
export interface RestructurePayload extends RestructurePreview {
  operations: RestructureOp[];
}

class Rollback extends Error {
  constructor(readonly preview: RestructurePreview) {
    super('rollback');
  }
}

/** Plain-text outline of a roadmap, used for the before/after review. */
export function outline(phases: PhaseView[]): string[] {
  const lines: string[] = [];
  phases.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.title}`);
    p.tasks.forEach((t, j) => {
      lines.push(`   ${i + 1}.${j + 1} [${t.done ? 'x' : ' '}] ${t.title}`);
    });
  });
  return lines;
}

/**
 * Roadmap restructuring as a batch of operations (destructive: gated like deletes).
 * The batch is validated by running it inside a transaction that is rolled back,
 * which also yields the before/after outline stored in the proposal.
 */
export class RestructureService {
  constructor(private readonly d: Domain) {}

  restructure(projectRef: ProjectRef, input: unknown, ctx: Ctx): Gated<PhaseView[]> {
    const { operations, reason } = parse(RestructureInput, input);
    const project = this.d.projects.writable(projectRef, ctx);
    if (this.d.proposals.needsProposal(ctx)) {
      const preview = this.preview(project.id, operations, ctx);
      const payload: RestructurePayload = { operations, ...preview };
      const proposal = this.d.proposals.create(
        project.id,
        'restructure_roadmap',
        payload as unknown as Record<string, unknown>,
        reason ?? '',
        ctx,
      );
      return { applied: false, proposal };
    }
    return { applied: true, result: this.apply(project.id, operations, ctx) };
  }

  /** Validates the batch and returns the outline before and after, changing nothing. */
  preview(projectId: number, operations: RestructureOp[], ctx: Ctx): RestructurePreview {
    try {
      this.d.tx(() => {
        const before = outline(this.d.roadmap.phasesOf(projectId));
        this.run(projectId, operations, ctx);
        const after = outline(this.d.roadmap.phasesOf(projectId));
        throw new Rollback({ before, after });
      });
    } catch (e) {
      if (e instanceof Rollback) return e.preview;
      throw e;
    }
    throw new Error('unreachable');
  }

  /** Applies the batch atomically and records one diary event. */
  apply(projectId: number, operations: RestructureOp[], ctx: Ctx): PhaseView[] {
    return this.d.tx(() => {
      const before = outline(this.d.roadmap.phasesOf(projectId));
      // One revertible change for the whole batch (D74).
      this.d.audit.grouped(
        ctx,
        {
          projectId,
          entity: GROUP_HEAD.entity,
          entityId: projectId,
          action: GROUP_HEAD.action,
          before: { outline: before },
          after: { operations: operations.length },
        },
        () => this.run(projectId, operations, ctx),
      );
      const after = outline(this.d.roadmap.phasesOf(projectId));
      this.d.diary.event(
        projectId,
        'roadmap_restructured',
        `Roadmap restructured (${operations.length} operation${operations.length === 1 ? '' : 's'})`,
        { operations: operations.length, before, after, ...confirmedFlag(ctx) },
        ctx,
      );
      return this.d.roadmap.phasesOf(projectId);
    });
  }

  private run(projectId: number, operations: RestructureOp[], ctx: Ctx): void {
    const refs = new Map<string, number>();
    const phaseId = (ref: PhaseRef, i: number): number => {
      if (typeof ref === 'string') {
        const id = refs.get(ref);
        if (id === undefined)
          throw opError(i, `unknown phase ref "${ref}" (define it with add_phase first)`);
        return id;
      }
      this.assertPhase(projectId, ref, i);
      return ref;
    };

    operations.forEach((op, i) => {
      switch (op.op) {
        case 'add_phase': {
          if (op.ref && refs.has(op.ref)) throw opError(i, `duplicate phase ref "${op.ref}"`);
          const phase = this.d.roadmap.addPhase(
            projectId,
            { title: op.title, description: op.description, position: op.position },
            ctx,
          );
          if (op.ref) refs.set(op.ref, phase.id);
          return;
        }
        case 'update_phase':
          this.d.roadmap.updatePhase(
            phaseId(op.phase, i),
            { title: op.title, description: op.description },
            ctx,
          );
          return;
        case 'move_phase':
          this.d.roadmap.movePhase(phaseId(op.phase, i), { position: op.position }, ctx);
          return;
        case 'delete_phase':
          this.assertPhase(projectId, op.phaseId, i);
          this.d.roadmap.removePhase(op.phaseId, ctx);
          return;
        case 'add_task':
          this.d.roadmap.addTask(
            phaseId(op.phase, i),
            { title: op.title, notes: op.notes, position: op.position },
            ctx,
          );
          return;
        case 'update_task':
          this.assertTask(projectId, op.taskId, i);
          this.d.roadmap.updateTask(op.taskId, { title: op.title, notes: op.notes }, ctx);
          return;
        case 'move_task':
          this.assertTask(projectId, op.taskId, i);
          this.d.roadmap.moveTask(
            op.taskId,
            {
              ...(op.phase !== undefined ? { phaseId: phaseId(op.phase, i) } : {}),
              position: op.position,
            },
            ctx,
          );
          return;
        case 'delete_task':
          this.assertTask(projectId, op.taskId, i);
          this.d.roadmap.removeTask(op.taskId, ctx);
          return;
      }
    });
  }

  private assertPhase(projectId: number, id: number, i: number): void {
    let p: { projectId: number };
    try {
      p = this.d.roadmap.getPhase(id);
    } catch {
      throw opError(i, `phase #${id} does not exist`);
    }
    if (p.projectId !== projectId) throw opError(i, `phase #${id} belongs to another project`);
  }

  private assertTask(projectId: number, id: number, i: number): void {
    let t: { projectId: number };
    try {
      t = this.d.roadmap.getTask(id);
    } catch {
      throw opError(i, `task #${id} does not exist`);
    }
    if (t.projectId !== projectId) throw opError(i, `task #${id} belongs to another project`);
  }
}

function opError(i: number, message: string): DomainError {
  return new DomainError('validation', `operations[${i}]: ${message}`);
}
