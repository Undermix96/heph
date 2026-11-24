import {
  AddNoteInput,
  type DiaryEntryView,
  DiaryQuery,
  type DiaryType,
  type EventKind,
} from '@heph/schema';
import { and, desc, eq, inArray, isNotNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { diaryEntries, files } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError, notFound } from './errors.js';
import type { ProjectRef } from './projects.js';
import { iso, parse } from './util.js';

type EntryRow = typeof diaryEntries.$inferSelect;

export interface AppendInput {
  type: DiaryType;
  eventKind?: EventKind | null;
  body: string;
  data?: Record<string, unknown> | null;
  /** Defaults to now. */
  occurredAt?: number;
  /** Existing files of the same project to attach to this entry. */
  fileIds?: number[] | undefined;
  origin?: string | null;
}

/**
 * The append-only project diary. Entries are never edited or deleted through
 * the domain; corrections are new entries.
 */
export class DiaryService {
  constructor(private readonly d: Domain) {}

  /** Adds a free-text entry. From a Claude Code session it is stored as type `session`. */
  addNote(projectRef: ProjectRef, input: unknown, ctx: Ctx): DiaryEntryView {
    const data = parse(AddNoteInput, input);
    const project = this.d.projects.writable(projectRef, ctx);
    const type: DiaryType = ctx.source === 'claude_code' && ctx.sessionId ? 'session' : 'note';
    const row = this.append(
      project.id,
      { type, body: data.body.trim(), fileIds: data.fileIds },
      ctx,
    );
    return this.get(row.id);
  }

  /** Low-level append used by every service. Bumps the project's last activity. */
  append(projectId: number, input: AppendInput, ctx: Ctx): EntryRow {
    return this.d.tx(() => {
      const now = this.d.now();
      const occurredAt = input.occurredAt ?? now;
      const row = this.d.db
        .insert(diaryEntries)
        .values({
          projectId,
          type: input.type,
          eventKind: input.eventKind ?? null,
          body: input.body,
          data: input.data ?? null,
          source: ctx.source,
          sessionId: ctx.sessionId ?? null,
          occurredAt,
          origin: input.origin ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (input.fileIds?.length) this.attachFiles(projectId, row.id, input.fileIds);
      if (ctx.source !== 'system') this.d.projects.touch(projectId, occurredAt);
      return row;
    });
  }

  /** Appends an automatic event entry. */
  event(
    projectId: number,
    kind: EventKind,
    body: string,
    data: Record<string, unknown>,
    ctx: Ctx,
    occurredAt?: number,
  ): EntryRow {
    return this.append(projectId, { type: 'event', eventKind: kind, body, data, occurredAt }, ctx);
  }

  get(id: number): DiaryEntryView {
    const row = this.d.db.select().from(diaryEntries).where(eq(diaryEntries.id, id)).get();
    if (!row) throw notFound('Diary entry', id);
    return this.toViews([row])[0] as DiaryEntryView;
  }

  /**
   * Lists entries newest first. `projectRef` null = all projects.
   * Paginate with `before` = the `occurredAt` and `beforeId` = the `id` of the
   * last entry received (keyset on the non-unique timestamp plus id).
   */
  list(projectRef: ProjectRef | null, query: unknown = {}): DiaryEntryView[] {
    const q = parse(DiaryQuery, query);
    const where: SQL[] = [];
    if (projectRef !== null)
      where.push(eq(diaryEntries.projectId, this.d.projects.row(projectRef).id));
    if (q.before !== undefined) {
      where.push(
        q.beforeId === undefined
          ? lt(diaryEntries.occurredAt, q.before)
          : (or(
              lt(diaryEntries.occurredAt, q.before),
              and(eq(diaryEntries.occurredAt, q.before), lt(diaryEntries.id, q.beforeId)),
            ) as SQL),
      );
    }
    if (q.source) where.push(eq(diaryEntries.source, q.source));
    if (q.type) where.push(eq(diaryEntries.type, q.type));
    if (q.withFiles) {
      where.push(sql`exists (select 1 from files f where f.diary_entry_id = ${diaryEntries.id})`);
    }
    const rows = this.d.db
      .select()
      .from(diaryEntries)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(diaryEntries.occurredAt), desc(diaryEntries.id))
      .limit(q.limit)
      .all();
    return this.toViews(rows);
  }

  /** Entries of one Claude Code session, oldest first. */
  bySession(sessionId: string): DiaryEntryView[] {
    const rows = this.d.db
      .select()
      .from(diaryEntries)
      .where(eq(diaryEntries.sessionId, sessionId))
      .orderBy(diaryEntries.occurredAt, diaryEntries.id)
      .all();
    return this.toViews(rows);
  }

  private attachFiles(projectId: number, entryId: number, fileIds: number[]): void {
    const rows = this.d.db.select().from(files).where(inArray(files.id, fileIds)).all();
    if (rows.length !== new Set(fileIds).size)
      throw new DomainError('validation', 'Unknown file id');
    if (rows.some((f) => f.projectId !== projectId)) {
      throw new DomainError('validation', 'Files must belong to the same project');
    }
    this.d.db
      .update(files)
      .set({ diaryEntryId: entryId, phaseId: null, taskId: null, updatedAt: this.d.now() })
      .where(inArray(files.id, fileIds))
      .run();
  }

  private toViews(rows: EntryRow[]): DiaryEntryView[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const fileRows = this.d.db
      .select()
      .from(files)
      .where(and(isNotNull(files.diaryEntryId), inArray(files.diaryEntryId, ids)))
      .orderBy(files.id)
      .all();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      type: r.type,
      eventKind: r.eventKind,
      body: r.body,
      data: r.data ?? null,
      source: r.source,
      sessionId: r.sessionId,
      occurredAt: iso(r.occurredAt),
      files: fileRows.filter((f) => f.diaryEntryId === r.id).map((f) => this.d.files.toView(f)),
    }));
  }
}
