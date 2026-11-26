import type { DiaryEntryView } from '@heph/schema';

/**
 * Diary timeline grouping (design §4, §9): entries by local day, and consecutive
 * entries of the same Claude Code session as one block with a summary. Input and
 * output are newest first, as the API returns them.
 */
export type DiaryItem =
  | { kind: 'entry'; entry: DiaryEntryView }
  | {
      kind: 'session';
      sessionId: string;
      entries: DiaryEntryView[];
      start: string;
      end: string;
      summary: SessionSummary;
    };

export interface SessionSummary {
  tasks: number;
  tests: number;
  files: number;
  status: number;
  notes: number;
}

export interface DiaryDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  items: DiaryItem[];
}

export function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function summarize(entries: DiaryEntryView[]): SessionSummary {
  return {
    tasks: entries.filter((e) => e.eventKind === 'task_completed').length,
    tests: entries.filter((e) => e.eventKind === 'test_outcome').length,
    files: entries.reduce((n, e) => n + e.files.length, 0),
    status: entries.filter((e) => e.eventKind === 'status_changed').length,
    notes: entries.filter((e) => e.type === 'note').length,
  };
}

export function groupDiary(entries: DiaryEntryView[]): DiaryDay[] {
  const days: DiaryDay[] = [];
  for (const e of entries) {
    const day = localDay(e.occurredAt);
    let bucket = days.at(-1);
    if (!bucket || bucket.day !== day) {
      bucket = { day, items: [] };
      days.push(bucket);
    }
    const last = bucket.items.at(-1);
    // D62: each GitHub sync adds its own `commits` event (the diary is append-only);
    // all those of one repo and day are shown as one box, where the newest is.
    const same = bucket.items.find(
      (it): it is Extract<DiaryItem, { kind: 'entry' }> =>
        it.kind === 'entry' && sameCommitDay(it.entry, e),
    );
    if (same) {
      same.entry = mergeCommits(same.entry, e);
      continue;
    }
    const sid = e.sessionId;
    if (sid && last?.kind === 'session' && last.sessionId === sid) {
      last.entries.push(e);
      last.start = e.occurredAt; // newest first: the latest pushed is the earliest
    } else if (sid && last?.kind === 'entry' && last.entry.sessionId === sid) {
      // Two entries of the same session make a session block.
      bucket.items[bucket.items.length - 1] = {
        kind: 'session',
        sessionId: sid,
        entries: [last.entry, e],
        start: e.occurredAt,
        end: last.entry.occurredAt,
        summary: summarize([]),
      };
    } else {
      bucket.items.push({ kind: 'entry', entry: e });
    }
  }
  for (const d of days) {
    for (const it of d.items) if (it.kind === 'session') it.summary = summarize(it.entries);
  }
  return days;
}

/** Entry counts per source, for the filter labels. */
export function sourceCounts(entries: DiaryEntryView[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.source] = (out[e.source] ?? 0) + 1;
  return out;
}

function commitDay(e: DiaryEntryView): string | null {
  if (e.eventKind !== 'commits' || !e.data) return null;
  return `${String(e.data.repo ?? '')}|${String(e.data.day ?? '')}`;
}

/** Two `commits` events of the same repo and local day (D62). */
function sameCommitDay(a: DiaryEntryView, b: DiaryEntryView): boolean {
  const k = commitDay(a);
  return k !== null && k === commitDay(b);
}

/** `newer` and `older` as one event: commits newest first, counts added. */
function mergeCommits(newer: DiaryEntryView, older: DiaryEntryView): DiaryEntryView {
  const list = (e: DiaryEntryView) => (Array.isArray(e.data?.commits) ? e.data.commits : []);
  const count = (e: DiaryEntryView) => Number(e.data?.count ?? list(e).length);
  return {
    ...newer,
    data: {
      ...newer.data,
      count: count(newer) + count(older),
      commits: [...list(newer), ...list(older)],
    },
  };
}
