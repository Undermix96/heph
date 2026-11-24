/** Small Markdown/text helpers shared by the briefing and the MCP adapter (English, agent-facing). */
import type { Badge, DiaryEntryView, Progress, Source } from '@heph/schema';
import { DAY_MS, toMs } from './util.js';

/** Full UTC ISO 8601 timestamp, e.g. 2026-11-24T12:00:00.000Z (D39). */
export function isoTimestamp(t: string | number): string {
  return new Date(toMs(t)).toISOString();
}

/** "just now", "5 min ago", "3 h ago", "12 days ago". */
export function relTime(t: string | number, now: number): string {
  const d = Math.max(0, now - toMs(t));
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < DAY_MS) return `${Math.floor(d / 3_600_000)} h ago`;
  const days = Math.floor(d / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function pct(p: Progress): string {
  return `${p.done}/${p.total} (${Math.round(p.ratio * 100)}%)`;
}

export function badgeLabel(b: Badge): string {
  switch (b.kind) {
    case 'claude_testing':
      return 'Claude running tests';
    case 'claude_working':
      return 'Claude working';
    case 'awaiting_manual_test':
      return 'awaiting manual test';
    case 'on_hold':
      return 'on hold';
    case 'completed':
      return 'completed';
    case 'abandoned':
      return 'abandoned';
    case 'no_next_step':
      return 'no next step';
    case 'inactive':
      return `inactive for ${b.days ?? '?'} days`;
    case 'recently_active':
      return 'recently active';
    case 'idle':
      return 'in development';
  }
}

export const SOURCE_LABEL: Record<Source, string> = {
  ui: 'user',
  claude_code: 'claude',
  github: 'github',
  system: 'system',
};

/** Collapses whitespace and truncates to `max` characters. */
export function oneLine(text: string, max = 280): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One diary line: `- 2026-11-24 14:03 · claude · note: …`. */
export function diaryLine(e: DiaryEntryView, max = 280): string {
  const kind = e.type === 'event' ? (e.eventKind ?? 'event') : e.type;
  const files = e.files.length ? ` [${e.files.length} file${e.files.length === 1 ? '' : 's'}]` : '';
  const session = e.sessionId ? ` (session ${e.sessionId.slice(0, 8)})` : '';
  return `- ${isoTimestamp(e.occurredAt)} · ${SOURCE_LABEL[e.source]}${session} · ${kind} #${e.id}: ${oneLine(e.body, max)}${files}`;
}
