import { type SearchHit, SearchQuery } from '@heph/schema';
import type { Domain } from './domain.js';
import { parse } from './util.js';

const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';

/**
 * Turns user text into a safe FTS5 query: every word becomes a quoted
 * prefix term, all terms must match. FTS operators typed by the user are inert.
 */
export function toFtsQuery(text: string): string | null {
  const words = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 20);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Full-text search over projects, phases, tasks, diary and docs (FTS5). */
export class SearchService {
  constructor(private readonly d: Domain) {}

  search(input: unknown): SearchHit[] {
    const q = parse(SearchQuery, input);
    const match = toFtsQuery(q.q);
    if (!match) return [];
    const params: unknown[] = [MARK_OPEN, MARK_CLOSE, match];
    let filter = '';
    if (q.projectId) {
      filter += ' and s.project_id = ?';
      params.push(q.projectId);
    }
    if (q.kinds?.length) {
      filter += ` and s.kind in (${q.kinds.map(() => '?').join(',')})`;
      params.push(...q.kinds);
    }
    params.push(q.limit);
    const rows = this.d.db.$client
      .prepare(
        `select s.kind, s.ref_id as refId, s.project_id as projectId, s.title,
                snippet(search_fts, 4, ?, ?, '…', 24) as snippet,
                bm25(search_fts, 0, 0, 0, 5.0, 1.0) as rank,
                p.name as projectName, p.slug as projectSlug
           from search_fts s join projects p on p.id = s.project_id
          where search_fts match ?${filter}
          order by rank limit ?`,
      )
      .all(...params) as (Omit<SearchHit, 'snippet'> & { snippet: string })[];
    return rows.map((r) => ({
      ...r,
      refId: Number(r.refId),
      projectId: Number(r.projectId),
      snippet: escapeHtml(r.snippet)
        .replaceAll(MARK_OPEN, '<mark>')
        .replaceAll(MARK_CLOSE, '</mark>'),
    }));
  }
}
