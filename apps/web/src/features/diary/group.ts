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
