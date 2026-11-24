import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { type FileTarget, FileTargetInput, type FileView, UpdateFileInput } from '@heph/schema';
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { fileTypeFromFile } from 'file-type';
import sharp from 'sharp';
import type { Ctx } from './context.js';
import { diaryEntries, files, phases, projects, tasks, uploadTokens } from './db/schema.js';
import type { Domain } from './domain.js';
import { DomainError, notFound } from './errors.js';
import type { ProjectRef } from './projects.js';
import { parse, randomToken, sha256 } from './util.js';

type FileRow = typeof files.$inferSelect;

/** Raster formats re-encoded to auto-orient and strip metadata (EXIF, GPS, XMP). */
const PROCESSED_IMAGES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/avif',
]);
/** Formats we can thumbnail without re-encoding the original. */
const THUMBNAILABLE = new Set([...PROCESSED_IMAGES, 'image/gif']);
const THUMB_SIZE = 480;
export const UPLOAD_TOKEN_TTL_MS = 60 * 60_000;

export interface IngestInput {
  /** Path of the uploaded bytes on disk (a temp file); it is consumed. */
  tempPath: string;
  originalName: string;
  /** MIME type declared by the client; used only when sniffing finds nothing. */
  declaredMime?: string | null;
  caption?: string | null;
  target?: FileTargetInput;
}

export interface StoredFile {
  row: FileRow;
  /** Absolute path of the file on disk. */
  absPath: string;
}

export class FilesService {
  constructor(private readonly d: Domain) {}

  /** Max upload size in bytes, from settings. */
  maxBytes(): number {
    return this.d.settings.get().maxUploadMb * 1024 * 1024;
  }

  /** A fresh temp path inside the files directory (same filesystem → cheap rename). */
  tempPath(): string {
    const dir = path.join(this.d.filesDir, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${Date.now()}-${randomToken(9)}`);
  }

  /**
   * Stores an uploaded file: sniffs the type, re-encodes raster images
   * (auto-orientation, metadata stripped), makes a thumbnail, records the row,
   * logs a diary event and applies Claude screenshot retention.
   */
  async ingest(projectRef: ProjectRef, input: IngestInput, ctx: Ctx): Promise<FileView> {
    try {
      const project = this.d.projects.writable(projectRef, ctx);
      const target = this.resolveTarget(project.id, input.target ?? {});
      const originalName = sanitizeName(input.originalName);
      const size = (await fsp.stat(input.tempPath)).size;
      if (size > this.maxBytes())
        throw new DomainError('too_large', `File exceeds ${this.d.settings.get().maxUploadMb} MB`);
      if (size === 0) throw new DomainError('validation', 'Empty file');

      const sniffed = await fileTypeFromFile(input.tempPath);
      const mime = sniffed?.mime ?? normalizeMime(input.declaredMime) ?? 'application/octet-stream';
      const ext = sniffed?.ext ?? (path.extname(originalName).slice(1).toLowerCase() || 'bin');

      const name = `${randomToken(12)}.${ext}`;
      const relPath = path.posix.join(String(project.id), name);
      const absPath = this.abs(relPath);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });

      let width: number | null = null;
      let height: number | null = null;
      if (PROCESSED_IMAGES.has(mime)) {
        try {
          // .rotate() applies EXIF orientation; sharp drops all metadata unless asked to keep it.
          const info = await sharp(input.tempPath, { failOn: 'error' })
            .rotate()
            .keepIccProfile()
            .toFile(absPath);
          width = info.width;
          height = info.height;
        } catch {
          throw new DomainError('validation', 'The image could not be decoded');
        }
      } else {
        await fsp.rename(input.tempPath, absPath).catch(async () => {
          await fsp.copyFile(input.tempPath, absPath);
        });
      }

      let thumbPath: string | null = null;
      if (THUMBNAILABLE.has(mime)) {
        thumbPath = path.posix.join(String(project.id), 'thumbs', `${path.parse(name).name}.webp`);
        try {
          await fsp.mkdir(path.dirname(this.abs(thumbPath)), { recursive: true });
          const img = sharp(absPath, { pages: 1 }).rotate();
          if (width === null) {
            const meta = await sharp(absPath).metadata();
            width = meta.width ?? null;
            height = meta.pageHeight ?? meta.height ?? null;
          }
          await img
            .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 78 })
            .toFile(this.abs(thumbPath));
        } catch {
          thumbPath = null;
        }
      }

      const finalSize = (await fsp.stat(absPath)).size;
      const hash = await hashFile(absPath);
      const now = this.d.now();
      const row = this.d.tx(() => {
        const r = this.d.db
          .insert(files)
          .values({
            projectId: project.id,
            phaseId: target.phaseId,
            taskId: target.taskId,
            diaryEntryId: target.diaryEntryId,
            originalName,
            mime,
            size: finalSize,
            sha256: hash,
            storagePath: relPath,
            thumbPath,
            width,
            height,
            caption: input.caption?.trim() || null,
            source: ctx.source,
            sessionId: ctx.sessionId ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        this.d.diary.event(
          project.id,
          'file_uploaded',
          `File uploaded: ${originalName}`,
          { fileId: r.id, mime, target: targetKind(target), targetId: targetId(target) },
          ctx,
        );
        this.d.audit.record(ctx, {
          projectId: project.id,
          entity: 'file',
          entityId: r.id,
          action: 'create',
          after: r,
        });
        return r;
      });
      if (ctx.source === 'claude_code') await this.applyRetention(row);
      return this.toView(row);
    } finally {
      await fsp.rm(input.tempPath, { force: true });
    }
  }

  list(
    projectRef: ProjectRef,
    filter: { target?: FileTarget; targetId?: number; pinned?: boolean } = {},
  ): FileView[] {
    const project = this.d.projects.row(projectRef);
    const where: SQL[] = [eq(files.projectId, project.id)];
    if (filter.pinned !== undefined) where.push(eq(files.pinned, filter.pinned));
    if (filter.target === 'phase' && filter.targetId)
      where.push(eq(files.phaseId, filter.targetId));
    if (filter.target === 'task' && filter.targetId) where.push(eq(files.taskId, filter.targetId));
    if (filter.target === 'diary_entry' && filter.targetId)
      where.push(eq(files.diaryEntryId, filter.targetId));
    if (filter.target === 'project') {
      where.push(isNull(files.phaseId), isNull(files.taskId), isNull(files.diaryEntryId));
    }
    return this.d.db
      .select()
      .from(files)
      .where(and(...where))
      .orderBy(desc(files.createdAt), desc(files.id))
      .all()
      .map((f) => this.toView(f));
  }

  get(id: number): FileView {
    return this.toView(this.rowOf(id));
  }

  /**
   * Agent-friendly preview of a file: raster images downscaled to `maxEdge`
   * (WebP), small text files as UTF-8, anything else nothing.
   */
  async preview(
    id: number,
    maxEdge = 1568,
  ): Promise<
    | { kind: 'image'; data: Buffer; mime: string }
    | { kind: 'text'; text: string }
    | { kind: 'none'; reason: string }
  > {
    const f = this.rowOf(id);
    const p = this.abs(f.storagePath);
    if (!fs.existsSync(p)) return { kind: 'none', reason: 'content missing on disk' };
    if (THUMBNAILABLE.has(f.mime)) {
      const data = await sharp(p, { pages: 1 })
        .rotate()
        .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      return { kind: 'image', data, mime: 'image/webp' };
    }
    if (isTextLike(f.mime, f.originalName)) {
      if (f.size > TEXT_PREVIEW_MAX) {
        return { kind: 'none', reason: `text file larger than ${TEXT_PREVIEW_MAX / 1024} KB` };
      }
      return { kind: 'text', text: await fsp.readFile(p, 'utf8') };
    }
    return { kind: 'none', reason: 'binary file' };
  }

  /** Absolute path (and metadata) for download; `thumb` picks the thumbnail. */
  open(id: number, thumb = false): { path: string; mime: string; name: string; size: number } {
    const f = this.rowOf(id);
    if (thumb) {
      if (!f.thumbPath) throw new DomainError('not_found', 'This file has no thumbnail');
      const p = this.abs(f.thumbPath);
      return {
        path: p,
        mime: 'image/webp',
        name: `${path.parse(f.originalName).name}.webp`,
        size: fs.statSync(p).size,
      };
    }
    return { path: this.abs(f.storagePath), mime: f.mime, name: f.originalName, size: f.size };
  }

  update(id: number, input: unknown, ctx: Ctx): FileView {
    const data = parse(UpdateFileInput, input);
    const before = this.rowOf(id);
    this.d.projects.writable(before.projectId, ctx);
    this.d.tx(() => {
      this.d.db
        .update(files)
        .set({
          ...(data.caption !== undefined ? { caption: data.caption?.trim() || null } : {}),
          ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
          updatedAt: this.d.now(),
        })
        .where(eq(files.id, id))
        .run();
      this.d.audit.record(ctx, {
        projectId: before.projectId,
        entity: 'file',
        entityId: id,
        action: 'update',
        before,
        after: data,
      });
    });
    return this.get(id);
  }

  delete(id: number, ctx: Ctx): void {
    const f = this.rowOf(id);
    this.d.projects.writable(f.projectId, ctx);
    this.d.tx(() => {
      this.d.db
        .update(projects)
        .set({ coverFileId: null })
        .where(eq(projects.coverFileId, id))
        .run();
      this.d.db.delete(files).where(eq(files.id, id)).run();
      this.d.audit.record(ctx, {
        projectId: f.projectId,
        entity: 'file',
        entityId: id,
        action: 'delete',
        before: f,
      });
    });
    this.unlink(f);
  }

  /** Before a phase/task is deleted, keeps its files by moving them to project level. */
  detachToProject(t: { phaseId?: number; taskIds?: number[] }): void {
    const now = this.d.now();
    if (t.phaseId) {
      this.d.db
        .update(files)
        .set({ phaseId: null, updatedAt: now })
        .where(eq(files.phaseId, t.phaseId))
        .run();
    }
    if (t.taskIds?.length) {
      this.d.db
        .update(files)
        .set({ taskId: null, updatedAt: now })
        .where(inArray(files.taskId, t.taskIds))
        .run();
    }
  }

  // ------------------------------------------------------------ one-time upload tokens

  /** Issues a one-time upload token for the agent (`request_upload`). */
  createUploadToken(
    projectRef: ProjectRef,
    input: { target?: unknown; caption?: string | null },
    ctx: Ctx,
  ): { token: string; expiresAt: number } {
    const project = this.d.projects.writable(projectRef, ctx);
    const target = this.resolveTarget(project.id, parse(FileTargetInput, input.target ?? {}));
    const token = randomToken(24);
    const now = this.d.now();
    const expiresAt = now + UPLOAD_TOKEN_TTL_MS;
    this.d.db
      .insert(uploadTokens)
      .values({
        tokenHash: sha256(token),
        projectId: project.id,
        phaseId: target.phaseId,
        taskId: target.taskId,
        diaryEntryId: target.diaryEntryId,
        caption: input.caption ?? null,
        source: ctx.source,
        sessionId: ctx.sessionId ?? null,
        createdAt: now,
        expiresAt,
      })
      .run();
    return { token, expiresAt };
  }

  /** Marks a token used and returns what the upload should be attached to. */
  consumeUploadToken(token: string): {
    projectId: number;
    target: FileTargetInput;
    caption: string | null;
    ctx: Ctx;
  } {
    return this.d.tx(() => {
      const row = this.d.db
        .select()
        .from(uploadTokens)
        .where(eq(uploadTokens.tokenHash, sha256(token)))
        .get();
      if (!row || row.usedAt !== null || row.expiresAt <= this.d.now()) {
        throw new DomainError('not_found', 'Upload link is invalid, expired or already used');
      }
      this.d.db
        .update(uploadTokens)
        .set({ usedAt: this.d.now() })
        .where(eq(uploadTokens.tokenHash, row.tokenHash))
        .run();
      return {
        projectId: row.projectId,
        target: {
          ...(row.phaseId ? { phaseId: row.phaseId } : {}),
          ...(row.taskId ? { taskId: row.taskId } : {}),
          ...(row.diaryEntryId ? { diaryEntryId: row.diaryEntryId } : {}),
        },
        caption: row.caption,
        ctx: { source: row.source, sessionId: row.sessionId },
      };
    });
  }

  // ------------------------------------------------------------ helpers

  toView(f: FileRow): FileView {
    return {
      id: f.id,
      projectId: f.projectId,
      phaseId: f.phaseId,
      taskId: f.taskId,
      diaryEntryId: f.diaryEntryId,
      originalName: f.originalName,
      mime: f.mime,
      size: f.size,
      width: f.width,
      height: f.height,
      hasThumbnail: f.thumbPath !== null,
      caption: f.caption,
      pinned: f.pinned,
      source: f.source,
      sessionId: f.sessionId,
      createdAt: f.createdAt,
    };
  }

  /**
   * Keeps the last N unpinned Claude Code uploads per target (spec §5);
   * older ones are deleted. Pinned files are never deleted.
   */
  private async applyRetention(file: FileRow): Promise<void> {
    const keep = this.d.settings.get().screenshotRetentionPerTarget;
    const sameTarget = and(
      eq(files.projectId, file.projectId),
      eq(files.source, 'claude_code'),
      eq(files.pinned, false),
      file.taskId ? eq(files.taskId, file.taskId) : isNull(files.taskId),
      file.phaseId ? eq(files.phaseId, file.phaseId) : isNull(files.phaseId),
      file.diaryEntryId ? eq(files.diaryEntryId, file.diaryEntryId) : isNull(files.diaryEntryId),
    );
    const stale = this.d.db
      .select()
      .from(files)
      .where(sameTarget)
      .orderBy(desc(files.createdAt), desc(files.id))
      .all()
      .slice(keep);
    if (stale.length === 0) return;
    this.d.tx(() => {
      const ids = stale.map((f) => f.id);
      this.d.db
        .update(projects)
        .set({ coverFileId: null })
        .where(inArray(projects.coverFileId, ids))
        .run();
      this.d.db.delete(files).where(inArray(files.id, ids)).run();
      this.d.audit.record(
        { source: 'system' },
        {
          projectId: file.projectId,
          entity: 'file',
          entityId: null,
          action: 'retention_delete',
          before: stale.map((f) => ({ id: f.id, originalName: f.originalName })),
        },
      );
    });
    for (const f of stale) this.unlink(f);
  }

  private resolveTarget(projectId: number, t: FileTargetInput) {
    const set = [t.phaseId, t.taskId, t.diaryEntryId].filter((x) => x !== undefined);
    if (set.length > 1)
      throw new DomainError('validation', 'A file can be attached to only one target');
    const check = (rowProjectId: number | undefined, what: string) => {
      if (rowProjectId === undefined) throw notFound(what);
      if (rowProjectId !== projectId)
        throw new DomainError('validation', `${what} belongs to another project`);
    };
    if (t.phaseId)
      check(
        this.d.db.select({ p: phases.projectId }).from(phases).where(eq(phases.id, t.phaseId)).get()
          ?.p,
        'Phase',
      );
    if (t.taskId)
      check(
        this.d.db.select({ p: tasks.projectId }).from(tasks).where(eq(tasks.id, t.taskId)).get()?.p,
        'Task',
      );
    if (t.diaryEntryId) {
      check(
        this.d.db
          .select({ p: diaryEntries.projectId })
          .from(diaryEntries)
          .where(eq(diaryEntries.id, t.diaryEntryId))
          .get()?.p,
        'Diary entry',
      );
    }
    return {
      phaseId: t.phaseId ?? null,
      taskId: t.taskId ?? null,
      diaryEntryId: t.diaryEntryId ?? null,
    };
  }

  private rowOf(id: number): FileRow {
    const row = this.d.db.select().from(files).where(eq(files.id, id)).get();
    if (!row) throw notFound('File', id);
    return row;
  }

  private abs(rel: string): string {
    const p = path.resolve(this.d.filesDir, rel);
    if (!p.startsWith(path.resolve(this.d.filesDir) + path.sep))
      throw new DomainError('validation', 'Bad path');
    return p;
  }

  private unlink(f: FileRow): void {
    fs.rmSync(this.abs(f.storagePath), { force: true });
    if (f.thumbPath) fs.rmSync(this.abs(f.thumbPath), { force: true });
  }
}

function targetKind(t: {
  phaseId: number | null;
  taskId: number | null;
  diaryEntryId: number | null;
}): FileTarget {
  return t.taskId ? 'task' : t.phaseId ? 'phase' : t.diaryEntryId ? 'diary_entry' : 'project';
}

function targetId(t: {
  phaseId: number | null;
  taskId: number | null;
  diaryEntryId: number | null;
}): number | null {
  return t.taskId ?? t.phaseId ?? t.diaryEntryId ?? null;
}

const TEXT_PREVIEW_MAX = 100 * 1024;
const TEXT_MIME = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/javascript',
  'image/svg+xml',
]);
const TEXT_EXT =
  /\.(md|markdown|txt|log|csv|tsv|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|s?css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|c|h|cpp|hpp|java|kt|sh|ps1|sql|gcode|ino|svg)$/i;

function isTextLike(mime: string, name: string): boolean {
  return mime.startsWith('text/') || TEXT_MIME.has(mime) || TEXT_EXT.test(name);
}

function sanitizeName(name: string): string {
  // Keep only the base name; drop control characters and path separators.
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
  return clean || 'file';
}

function normalizeMime(m: string | null | undefined): string | null {
  if (!m) return null;
  const v = m.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(v) ? v : null;
}

async function hashFile(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p), h);
  return h.digest('hex');
}
