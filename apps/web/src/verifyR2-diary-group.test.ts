import type { DiaryEntryView } from '@heph/schema';
import { describe, expect, it } from 'vitest';
import { groupDiary } from './features/diary/group.js';

// Independent verification, round 2: one box per repo and day (D62). Invented entries,
// newest first as the API returns them.
let id = 1000;
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
const at = (day: number, hour: number, min = 0) => new Date(2026, 10, day, hour, min).toISOString();
function commits(occurredAt: string, repo: string, day: string, shas: string[], count?: number) {
  return entry(occurredAt, {
    type: 'event',
    eventKind: 'commits',
    source: 'github',
    body: `${shas.length} commits on main`,
    data: {
      repo,
      branch: 'main',
      day,
      count: count ?? shas.length,
      commits: shas.map((sha) => ({ sha })),
    },
  });
}
type Box = { kind: 'entry'; entry: DiaryEntryView };
const data = (it: unknown) =>
  (it as Box).entry.data as { count: number; commits: { sha: string }[] };

describe('verifyR2: commit boxes with interleaved repos and paging', () => {
  const day = '2026-11-26';
  const list = () => [
    commits(at(26, 18), 'ex/a', day, ['a3']),
    entry(at(26, 17)),
    commits(at(26, 16), 'ex/b', day, ['b2']),
    commits(at(26, 15), 'ex/a', day, ['a2']),
    entry(at(26, 14), {
      source: 'claude_code',
      sessionId: 's1',
      type: 'event',
      eventKind: 'status_changed',
    }),
    commits(at(26, 13), 'ex/b', day, ['b1'], 3),
    entry(at(26, 12), { source: 'claude_code', sessionId: 's1' }),
    commits(at(26, 11), 'ex/a', day, ['a1']),
  ];

  it('one box per repo, at the newest position, commits newest first, counts added', () => {
    const items = groupDiary(list())[0]!.items;
    const boxes = items.filter(
      (i) => i.kind === 'entry' && i.entry.eventKind === 'commits',
    ) as Box[];
    expect(boxes.map((b) => (b.entry.data as { repo: string }).repo)).toEqual(['ex/a', 'ex/b']);
    expect(data(boxes[0]).commits.map((c) => c.sha)).toEqual(['a3', 'a2', 'a1']);
    expect(data(boxes[0]).count).toBe(3);
    expect(data(boxes[1]).commits.map((c) => c.sha)).toEqual(['b2', 'b1']);
    expect(data(boxes[1]).count).toBe(4);
    // Position: a first, then the note, then b; the session entries become one block.
    expect(
      items.map((i) => (i.kind === 'session' ? 'session' : (i.entry.eventKind ?? 'note'))),
    ).toEqual(['commits', 'note', 'commits', 'session']);
    const total = items.reduce((n, i) => n + (i.kind === 'session' ? i.entries.length : 1), 0);
    expect(total).toBe(5); // 8 entries, 3 commit events merged into earlier boxes
  });

  it('the same result when the day is split across two loaded pages', () => {
    const all = list();
    const pages = [all.slice(0, 3), all.slice(3)];
    expect(groupDiary(pages.flat())).toEqual(groupDiary(all));
  });

  it('input entries are not mutated by the merge (react-query cache objects)', () => {
    const all = list();
    const before = JSON.parse(JSON.stringify(all));
    groupDiary(all);
    groupDiary(all);
    expect(all).toEqual(before);
  });

  it('grouping twice (re-render) gives the same counts', () => {
    const all = list();
    const a = groupDiary(all);
    const b = groupDiary(all);
    expect(b).toEqual(a);
  });
});
