import type { DiaryEntryView } from '@heph/schema';
import { describe, expect, it } from 'vitest';
import { groupDiary, localDay } from './group.js';

// Invented entries, newest first (as the API returns them). Times are local noon-ish
// so the day does not depend on the machine time zone.
let id = 100;
function entry(occurredAt: string, over: Partial<DiaryEntryView> = {}): DiaryEntryView {
  return {
    id: id--,
    projectId: 1,
    type: 'note',
    eventKind: null,
    body: 'x',
    data: null,
    source: 'ui',
    sessionId: null,
    occurredAt,
    files: [],
    ...over,
  };
}
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();

describe('groupDiary', () => {
  it('splits by local day, newest first', () => {
    const days = groupDiary([entry(at(25, 15)), entry(at(25, 9)), entry(at(24, 18))]);
    expect(days.map((d) => [d.day, d.items.length])).toEqual([
      ['2026-11-25', 2],
      ['2026-11-24', 1],
    ]);
    expect(localDay(at(24, 23))).toBe('2026-11-24');
  });

  it('groups consecutive entries of one session and summarizes them', () => {
    const s = { source: 'claude_code' as const, sessionId: 's1' };
    const days = groupDiary([
      entry(at(25, 12), { ...s, type: 'event', eventKind: 'task_completed' }),
      entry(at(25, 11), { ...s, type: 'note', files: [{} as never, {} as never] }),
      entry(at(25, 10), { ...s, type: 'event', eventKind: 'test_outcome' }),
      entry(at(25, 9)),
    ]);
    const [session, single] = days[0]!.items;
    expect(session).toMatchObject({
      kind: 'session',
      sessionId: 's1',
      start: at(25, 10),
      end: at(25, 12),
      summary: { tasks: 1, tests: 1, files: 2, status: 0, notes: 1 },
    });
    expect(session?.kind === 'session' && session.entries).toHaveLength(3);
    expect(single?.kind).toBe('entry');
  });

  it('keeps a single session entry as a plain entry and splits interrupted sessions', () => {
    const s = { source: 'claude_code' as const, sessionId: 's1' };
    const days = groupDiary([entry(at(25, 12), s), entry(at(25, 11)), entry(at(25, 10), s)]);
    expect(days[0]!.items.map((i) => i.kind)).toEqual(['entry', 'entry', 'entry']);
  });

  it('does not merge a session across days', () => {
    const s = { source: 'claude_code' as const, sessionId: 's1' };
    const days = groupDiary([entry(at(25, 1), s), entry(at(24, 23), s)]);
    expect(days.map((d) => d.items.map((i) => i.kind))).toEqual([['entry'], ['entry']]);
  });
});

describe('GitHub commit events of one repo and day (D62)', () => {
  const commits = (at: string, repo: string, day: string, shas: string[]) =>
    entry(at, {
      type: 'event',
      eventKind: 'commits',
      source: 'github',
      data: { repo, day, count: shas.length, commits: shas.map((sha) => ({ sha, message: sha })) },
    });

  it('consecutive syncs of the same day become one box, newest commits first', () => {
    const days = groupDiary([
      commits('2026-11-26T16:00:00.000Z', 'ex/meteo', '2026-11-26', ['c3']),
      commits('2026-11-26T09:00:00.000Z', 'ex/meteo', '2026-11-26', ['c2', 'c1']),
    ]);
    expect(days[0]?.items).toHaveLength(1);
    const it0 = days[0]?.items[0];
    expect(it0?.kind === 'entry' && it0.entry.data).toMatchObject({
      count: 3,
      commits: [{ sha: 'c3' }, { sha: 'c2' }, { sha: 'c1' }],
    });
  });

  it('other repos, other days and entries in between stay separate', () => {
    const days = groupDiary([
      commits('2026-11-26T16:00:00.000Z', 'ex/meteo', '2026-11-26', ['a']),
      commits('2026-11-26T15:00:00.000Z', 'ex/firmware', '2026-11-26', ['b']),
      entry('2026-11-26T14:00:00.000Z'),
      commits('2026-11-26T13:00:00.000Z', 'ex/firmware', '2026-11-26', ['c']),
    ]);
    expect(days[0]?.items).toHaveLength(4);
  });
});
