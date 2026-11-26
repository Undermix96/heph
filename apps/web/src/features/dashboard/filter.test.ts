import type { ProjectSummary } from '@heph/schema';
import { describe, expect, it } from 'vitest';
import { applyFilters, counts, EMPTY_FILTERS, matchesText, sortProjects } from './filter.js';

// Invented projects.
function project(over: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: 1,
    slug: 'p',
    name: 'P',
    description: '',
    tags: [],
    lifecycleStatus: 'in_development',
    statusNote: '',
    statusChangedAt: '2026-11-20T00:00:00.000Z',
    coverFileId: null,
    progress: { done: 0, total: 0, ratio: 0 },
    phaseProgress: [],
    currentPhase: null,
    nextTask: null,
    lastActivityAt: '2026-11-20T00:00:00.000Z',
    activityState: 'idle',
    badge: { kind: 'idle' },
    attentionGroup: 4,
    pendingProposals: 0,
    liveSessionIds: [],
    repos: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...over,
  };
}

const list = [
  project({ id: 1, name: 'Saldatrice a punti', tags: ['elettronica'], attentionGroup: 4 }),
  project({
    id: 2,
    name: 'Banco da lavoro',
    tags: ['legno'],
    lifecycleStatus: 'awaiting_manual_test',
    attentionGroup: 1,
  }),
  project({ id: 3, name: 'Vecchio', lifecycleStatus: 'completed', attentionGroup: 6 }),
  project({
    id: 4,
    name: 'Città',
    tags: ['software', 'elettronica'],
    activityState: 'claude_working',
    attentionGroup: 2,
    lastActivityAt: '2026-11-24T00:00:00.000Z',
    nextTask: {
      id: 9,
      title: 'Scrivere il firmware',
      phaseId: 1,
      phaseTitle: 'F',
      overridden: false,
    },
  }),
];

describe('dashboard filters', () => {
  it('hides closed projects unless asked or filtered by status', () => {
    expect(applyFilters(list, EMPTY_FILTERS).map((p) => p.id)).toEqual([1, 2, 4]);
    expect(applyFilters(list, { ...EMPTY_FILTERS, showClosed: true })).toHaveLength(4);
    expect(
      applyFilters(list, { ...EMPTY_FILTERS, statuses: ['completed'] }).map((p) => p.id),
    ).toEqual([3]);
  });

  it('combines status, activity and tags (all tags must match)', () => {
    expect(
      applyFilters(list, { ...EMPTY_FILTERS, tags: ['elettronica'] }).map((p) => p.id),
    ).toEqual([1, 4]);
    expect(
      applyFilters(list, { ...EMPTY_FILTERS, tags: ['elettronica', 'software'] }).map((p) => p.id),
    ).toEqual([4]);
    expect(
      applyFilters(list, { ...EMPTY_FILTERS, activities: ['claude_working'] }).map((p) => p.id),
    ).toEqual([4]);
  });

  it('matches text on every word, ignoring case and accents, also in the next task', () => {
    expect(matchesText(list[3]!, 'citta')).toBe(true);
    expect(matchesText(list[3]!, 'FIRMWARE scrivere')).toBe(true);
    expect(matchesText(list[0]!, 'saldatrice legno')).toBe(false);
    expect(matchesText(list[0]!, '   ')).toBe(true);
  });

  it('sorts by attention group, then most recent', () => {
    expect(sortProjects(list, 'attention', 'it').map((p) => p.id)).toEqual([2, 4, 1, 3]);
    expect(sortProjects(list, 'name', 'it').map((p) => p.name)).toEqual([
      'Banco da lavoro',
      'Città',
      'Saldatrice a punti',
      'Vecchio',
    ]);
    expect(sortProjects(list, 'updated', 'it')[0]!.id).toBe(4);
  });

  it('counts values, including several tags per project', () => {
    const c = counts(list, (p) => p.tags);
    expect(c.get('elettronica')).toBe(2);
    expect(c.get('legno')).toBe(1);
  });
});
