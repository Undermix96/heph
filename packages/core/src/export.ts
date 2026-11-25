import fs from 'node:fs';
import type { DiaryEntryView, ProjectExportJson } from '@heph/schema';
import type { Domain } from './domain.js';
import { renderMarkdown } from './export-md.js';
import type { ProjectRef } from './projects.js';
import { iso } from './util.js';

/** One file to copy into the export archive. */
export interface ExportFile {
  /** Path inside the archive, always `files/<id>-<safe name>`. */
  zipPath: string;
  /** Absolute path on disk. */
  absPath: string;
}

export interface ProjectExport {
  slug: string;
  markdown: string;
  json: ProjectExportJson;
  /** Files present on disk; missing ones are listed in the Markdown and JSON with a null path. */
  files: ExportFile[];
}

export { demote } from './export-md.js';

const DIARY_PAGE = 500;

/**
 * Whole-project export (spec §11, D32): one Markdown file, a `project.json` and the
 * project files. The archive itself is built by the HTTP adapter (D53).
 */
export class ExportService {
  constructor(private readonly d: Domain) {}

  build(ref: ProjectRef): ProjectExport {
    const project = this.d.projects.get(ref);
    const docs = this.d.projects.docs(project.id);
    const diary = this.allDiary(project.id);
    const materials = this.d.materials.list(project.id);
    const proposals = this.d.proposals.list(project.id);

    const files: ExportFile[] = [];
    const fileViews = this.d.files
      .list(project.id)
      .reverse()
      .map((f) => {
        const absPath = this.d.files.open(f.id).path;
        if (!isFile(absPath)) return { ...f, exportPath: null };
        const zipPath = `files/${f.id}-${safeName(f.originalName)}`;
        files.push({ zipPath, absPath });
        return { ...f, exportPath: zipPath };
      });

    const json: ProjectExportJson = {
      format: 'heph-project-export',
      version: 1,
      exportedAt: iso(this.d.now()),
      project,
      docs,
      diary,
      materials,
      files: fileViews,
      proposals,
    };
    return {
      slug: project.slug,
      markdown: renderMarkdown(json),
      json,
      files,
    };
  }

  /** Every diary entry of the project, oldest first. */
  private allDiary(projectId: number): DiaryEntryView[] {
    const out: DiaryEntryView[] = [];
    let cursor: { before: string; beforeId: number } | undefined;
    for (;;) {
      const page = this.d.diary.list(projectId, { limit: DIARY_PAGE, ...cursor });
      out.push(...page);
      const last = page.at(-1);
      if (page.length < DIARY_PAGE || !last) break;
      cursor = { before: last.occurredAt, beforeId: last.id };
    }
    return out.reverse();
  }
}

/**
 * File name safe inside an archive on every OS: no directories, no traversal,
 * ASCII letters, digits, dot, dash and underscore only, at most 100 characters.
 */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // Truncate first, then strip leading dots, so truncation cannot bring a dot back.
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-100)
    .replace(/^\.+/, '');
  return cleaned || 'file';
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
