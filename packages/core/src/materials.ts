import { MaterialInput, type MaterialView, UpdateMaterialInput } from '@heph/schema';
import { asc, eq } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { materials, phases } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError, notFound } from './errors.js';
import type { ProjectRef } from './projects.js';
import { iso, parse } from './util.js';

type MaterialRow = typeof materials.$inferSelect;

const toCents = (price: number | null | undefined) =>
  price === undefined ? undefined : price === null ? null : Math.round(price * 100);

/** Bill of materials / shopping list per project. */
export class MaterialsService {
  constructor(private readonly d: Domain) {}

  list(projectRef: ProjectRef): MaterialView[] {
    const project = this.d.projects.row(projectRef);
    const currency = this.d.settings.get().currency;
    return this.d.db
      .select()
      .from(materials)
      .where(eq(materials.projectId, project.id))
      .orderBy(asc(materials.position), asc(materials.id))
      .all()
      .map((m) => toView(m, currency));
  }

  get(id: number): MaterialView {
    return toView(this.rowOf(id), this.d.settings.get().currency);
  }

  add(projectRef: ProjectRef, input: unknown, ctx: Ctx): MaterialView {
    const data = parse(MaterialInput, input);
    const project = this.d.projects.writable(projectRef, ctx);
    if (data.phaseId) this.assertPhase(project.id, data.phaseId);
    const id = this.d.tx(() => {
      const now = this.d.now();
      const count = this.d.db.$count(materials, eq(materials.projectId, project.id));
      const row = this.d.db
        .insert(materials)
        .values({
          projectId: project.id,
          phaseId: data.phaseId ?? null,
          name: data.name,
          quantity: data.quantity ?? 1,
          unit: data.unit ?? null,
          link: data.link ?? null,
          priceCents: toCents(data.price) ?? null,
          notes: data.notes ?? '',
          status: data.status ?? 'to_buy',
          position: count,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      this.d.audit.record(ctx, {
        projectId: project.id,
        entity: 'material',
        entityId: row.id,
        action: 'create',
        after: row,
      });
      return row.id;
    });
    return this.get(id);
  }

  update(id: number, input: unknown, ctx: Ctx): MaterialView {
    const data = parse(UpdateMaterialInput, input);
    const before = this.rowOf(id);
    this.d.projects.writable(before.projectId, ctx);
    if (data.phaseId) this.assertPhase(before.projectId, data.phaseId);
    this.d.tx(() => {
      const { price, ...rest } = data;
      const cents = toCents(price);
      this.d.db
        .update(materials)
        .set({
          ...rest,
          ...(cents !== undefined ? { priceCents: cents } : {}),
          updatedAt: this.d.now(),
        })
        .where(eq(materials.id, id))
        .run();
      this.d.audit.record(ctx, {
        projectId: before.projectId,
        entity: 'material',
        entityId: id,
        action: 'update',
        before,
        after: data,
      });
    });
    return this.get(id);
  }

  delete(id: number, ctx: Ctx): void {
    const before = this.rowOf(id);
    this.d.projects.writable(before.projectId, ctx);
    this.d.tx(() => {
      this.d.db.delete(materials).where(eq(materials.id, id)).run();
      this.d.audit.record(ctx, {
        projectId: before.projectId,
        entity: 'material',
        entityId: id,
        action: 'delete',
        before,
      });
    });
  }

  private rowOf(id: number): MaterialRow {
    const row = this.d.db.select().from(materials).where(eq(materials.id, id)).get();
    if (!row) throw notFound('Material', id);
    return row;
  }

  private assertPhase(projectId: number, phaseId: number): void {
    const p = this.d.db
      .select({ projectId: phases.projectId })
      .from(phases)
      .where(eq(phases.id, phaseId))
      .get();
    if (!p || p.projectId !== projectId)
      throw new DomainError('validation', 'Phase belongs to another project');
  }
}

function toView(m: MaterialRow, currency: string): MaterialView {
  return {
    id: m.id,
    projectId: m.projectId,
    phaseId: m.phaseId,
    name: m.name,
    quantity: m.quantity,
    unit: m.unit,
    link: m.link,
    price: m.priceCents === null ? null : m.priceCents / 100,
    currency,
    notes: m.notes,
    status: m.status,
    position: m.position,
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
  };
}
