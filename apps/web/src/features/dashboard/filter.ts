import type { ActivityState, LifecycleStatus, ProjectSummary } from '@heph/schema';

/** Dashboard filters and ordering (design §5–6). Pure, so it is unit-tested. */

export const CLOSED: LifecycleStatus[] = ['completed', 'abandoned'];

export interface Filters {
  text: string;
  statuses: LifecycleStatus[];
  activities: ActivityState[];
  tags: string[];
  showClosed: boolean;
}

export type Sort = 'attention' | 'name' | 'updated';

export const EMPTY_FILTERS: Filters = {
  text: '',
  statuses: [],
  activities: [],
  tags: [],
  showClosed: false,
};

/** Text match on name, description, next task, tags and repos; case- and accent-insensitive. */
export function matchesText(p: ProjectSummary, text: string): boolean {
  const q = fold(text.trim());
  if (!q) return true;
  const hay = fold(
    [p.name, p.slug, p.description, p.nextTask?.title ?? '', ...p.tags, ...p.repos].join(' '),
  );
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export function applyFilters(projects: ProjectSummary[], f: Filters): ProjectSummary[] {
  return projects.filter(
    (p) =>
      (f.showClosed || f.statuses.length > 0 || !CLOSED.includes(p.lifecycleStatus)) &&
      (f.statuses.length === 0 || f.statuses.includes(p.lifecycleStatus)) &&
      (f.activities.length === 0 || f.activities.includes(p.activityState)) &&
      (f.tags.length === 0 || f.tags.every((t) => p.tags.includes(t))) &&
      matchesText(p, f.text),
  );
}

/** Attention order comes from the server (attentionGroup, D25); ties by last activity. */
export function sortProjects(
  projects: ProjectSummary[],
  sort: Sort,
  lang: string,
): ProjectSummary[] {
  const byName = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
  const recent = (a: ProjectSummary, b: ProjectSummary) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt);
  return [...projects].sort((a, b) => {
    if (sort === 'name') return byName.compare(a.name, b.name);
    if (sort === 'updated') return recent(a, b);
    return a.attentionGroup - b.attentionGroup || recent(a, b) || byName.compare(a.name, b.name);
  });
}

/** Counts per value for the side filters, on the projects visible before that filter. */
export function counts<T extends string>(
  projects: ProjectSummary[],
  pick: (p: ProjectSummary) => T | T[],
): Map<T, number> {
  const m = new Map<T, number>();
  for (const p of projects) {
    const v = pick(p);
    for (const x of Array.isArray(v) ? v : [v]) m.set(x, (m.get(x) ?? 0) + 1);
  }
  return m;
}

export function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
