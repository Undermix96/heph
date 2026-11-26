import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { commitsByDay, type GhRelease, GitHubError } from './github.js';
import { FakeGitHub } from './test/fake-github.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

// Independent verification of phase 6 group A. Invented repos and commits.
let t: TestDomain;
afterEach(() => t?.cleanup());

const REPO = 'example/spot-welder';
const NOW = Date.UTC(2026, 10, 24, 12);
const at = (daysAgo: number, hour = 10) =>
  new Date(NOW - daysAgo * DAY_MS + (hour - 12) * 3_600_000).toISOString();
const MIN16 = 16 * 60_000;

function rel(id: string, publishedAt: string | null, over: Partial<GhRelease> = {}): GhRelease {
  return {
    id,
    tag: `v${id}`,
    name: `v${id}`,
    draft: false,
    prerelease: false,
    url: `u${id}`,
    publishedAt,
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}) {
  t = makeDomain();
  t.d.settings.update({ githubToken: 'invented-token' }, UI);
  const gh = new FakeGitHub();
  gh.add(REPO);
  const p = seedProject(t.d, { repos: [REPO], ...over });
  const events = (kind?: string, projectId = p.id) =>
    t.d.diary
      .list(projectId, { limit: 500 })
      .filter((e) => e.type === 'event' && (!kind || e.eventKind === kind));
  const row = () => t.d.projects.repoRows(p.id)[0];
  const totalCount = () =>
    events('commits').reduce((s, e) => s + ((e.data as { count: number }).count ?? 0), 0);
  return { d: t.d, gh, p, events, row, totalCount };
}

describe('verifyA6: per-day grouping, DST and midnight (Europe/Rome)', () => {
  it('commits around midnight and both DST changes land on the right local day', async () => {
    const { d, gh, events } = setup();
    // 2026-03-29: CET -> CEST. 2026-10-25: CEST -> CET.
    const dates = [
      '2026-03-28T22:59:00Z', // 23:59 Mar 28
      '2026-03-28T23:30:00Z', // 00:30 Mar 29
      '2026-03-29T21:59:00Z', // 23:59 Mar 29 (CEST)
      '2026-03-29T22:01:00Z', // 00:01 Mar 30
      '2026-10-24T21:59:00Z', // 23:59 Oct 24 (CEST)
      '2026-10-24T22:30:00Z', // 00:30 Oct 25
      '2026-10-25T00:30:00Z', // 02:30 CEST, first pass
      '2026-10-25T01:30:00Z', // 02:30 CET, second pass
      '2026-10-25T22:59:00Z', // 23:59 Oct 25 (CET)
      '2026-10-25T23:00:00Z', // 00:00 Oct 26
    ];
    for (const date of dates) gh.push(REPO, { date, message: date });
    await d.github.syncDue(gh);
    const byDay = Object.fromEntries(
      events('commits').map((e) => {
        const data = e.data as { day: string; count: number };
        return [data.day, data.count];
      }),
    );
    expect(byDay).toEqual({
      '2026-03-28': 1,
      '2026-03-29': 2,
      '2026-03-30': 1,
      '2026-10-24': 1,
      '2026-10-25': 4,
      '2026-10-26': 1,
    });
    const oct25 = events('commits').find((e) => (e.data as { day: string }).day === '2026-10-25');
    expect(oct25?.occurredAt).toBe('2026-10-25T22:59:00.000Z');
    expect(oct25?.body).toBe('4 commits on main: 2026-10-25T22:59:00Z');
  });

  it('newest commit of a day is chosen by instant, not by string, with mixed precision', () => {
    const c = (date: string, sha: string) => ({ sha, message: sha, author: null, date, url: '' });
    const g = commitsByDay(
      [c('2026-11-23T10:00:00Z', 'early'), c('2026-11-23T10:00:00.500Z', 'late')],
      'Europe/Rome',
    );
    expect(g[0]?.commits[0]?.sha).toBe('late');
  });

  it('newest commit of a day is chosen by instant with offset timestamps', () => {
    const c = (date: string, sha: string) => ({ sha, message: sha, author: null, date, url: '' });
    // 10:30+02:00 = 08:30Z is older than 09:00Z.
    const g = commitsByDay(
      [c('2026-11-23T10:30:00+02:00', 'older'), c('2026-11-23T09:00:00Z', 'newer')],
      'Europe/Rome',
    );
    expect(g[0]?.commits[0]?.sha).toBe('newer');
  });

  it('commit event data: count is the real count, commits capped at 50, url set', async () => {
    const { d, gh, events } = setup();
    for (let i = 0; i < 60; i++) gh.push(REPO, { date: at(1, 8 + i / 10), message: `c${i}` });
    await d.github.syncDue(gh);
    const e = events('commits')[0];
    const data = e?.data as { count: number; commits: unknown[]; url: string; day: string };
    expect(data.count).toBe(60);
    expect(data.commits).toHaveLength(50);
    expect(data.url).toBe(`https://github.com/${REPO}/commits/main`);
    expect(e?.body).toBe('60 commits on main: c59');
  });
});

describe('verifyA6: incremental normal use', () => {
  it('two polls on the same day: each commit once, one event per sync and day (D62)', async () => {
    const { d, gh, events, totalCount } = setup();
    gh.push(REPO, { date: at(0, 8), message: 'morning' });
    await d.github.syncDue(gh);
    t.clock.advance(MIN16);
    gh.push(REPO, { date: at(0, 9), message: 'later' });
    await d.github.syncDue(gh);
    expect(totalCount()).toBe(2);
    // Owner decision 2026-11-26 (D62): the diary stays append-only (D11, D31), so a later
    // sync adds its own event for the same day; the web UI shows the events of one repo
    // and day as one box (apps/web/src/features/diary/group.ts).
    const days = events('commits').map((e) => (e.data as { day: string }).day);
    expect(days).toHaveLength(2);
    expect(new Set(days).size).toBe(1);
  });

  it('merging a feature branch whose commits are dated before the last seen commit imports them', async () => {
    const { d, gh, totalCount } = setup();
    gh.push(REPO, { date: at(1), message: 'A on main' });
    await d.github.syncDue(gh);
    // A feature branch with a commit from 3 days ago is merged now (merge commit M).
    gh.push(REPO, { date: at(3), message: 'B on feature', sha: 'b'.repeat(40) });
    gh.push(REPO, { date: at(0, 11), message: 'Merge feature', sha: 'c'.repeat(40) });
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    // Graph-wise both B and M are newer than A, which is reachable as the stop commit.
    expect(totalCount()).toBe(3);
  });

  it('repo empty at link time: later commits are imported', async () => {
    const { d, gh, totalCount, row } = setup();
    await d.github.syncDue(gh);
    expect(row()?.backfilledAt).not.toBeNull();
    gh.push(REPO, { date: at(0, 11) });
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(totalCount()).toBe(1);
  });

  it('more than 2000 commits in the year: no crash, exactly once, newest kept', async () => {
    const { d, gh, totalCount, row } = setup();
    // 2500 commits over the last 250 days, 10 per day, oldest pushed first.
    for (let day = 249; day >= 0; day--) {
      for (let h = 0; h < 10; h++) gh.push(REPO, { date: at(day, 8 + h) });
    }
    const newest = gh.repos.get(REPO)!.commits.main![0]!;
    const run = await d.github.syncDue(gh);
    expect(run.repos[0]?.error).toBeNull();
    expect(totalCount()).toBe(2000);
    expect(row()?.lastSeenCommitSha).toBe(newest.sha);
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(totalCount()).toBe(2000);
  });

  it('old import never moves last activity backwards', async () => {
    const { d, gh, p } = setup();
    const before = d.projects.get(p.id).lastActivityAt;
    gh.push(REPO, { date: at(100) });
    gh.repos.get(REPO)!.releases = [rel('1', at(200))];
    await d.github.syncDue(gh);
    expect(d.projects.get(p.id).lastActivityAt).toBe(before);
  });

  it('a repo linked between polls gets its own one-year import; others are not re-imported', async () => {
    const { d, gh, p, totalCount } = setup();
    gh.push(REPO, { date: at(5) });
    await d.github.syncDue(gh);
    gh.add('example/second');
    gh.push('example/second', { date: at(20) });
    d.projects.linkRepo(p.id, { fullName: 'example/second' }, UI);
    const run = await d.github.syncDue(gh);
    expect(run.repos.map((r) => r.repo)).toEqual(['example/second']);
    expect(totalCount()).toBe(2);
  });

  it('unlink then relink the same repo: the history is not imported twice', async () => {
    const { d, gh, p, events, row } = setup();
    gh.push(REPO, { date: at(5) });
    gh.repos.get(REPO)!.releases = [rel('1', at(3))];
    await d.github.syncDue(gh);
    d.projects.unlinkRepo(row()!.id, UI);
    d.projects.linkRepo(p.id, { fullName: REPO }, UI);
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(events('commits')).toHaveLength(1);
    expect(events('release')).toHaveLength(1);
  });

  it('syncProject on an unknown project returns an empty run', async () => {
    const { d, gh } = setup();
    await expect(d.github.syncProject(99_999, gh)).resolves.toEqual({ skipped: null, repos: [] });
  });
});

describe('verifyA6: releases', () => {
  it('a draft at link time is imported once when published later', async () => {
    const { d, gh, events } = setup();
    const r = gh.repos.get(REPO)!;
    r.releases = [rel('5', null, { draft: true }), rel('4', at(10))];
    await d.github.syncDue(gh);
    expect(events('release').map((e) => e.body)).toEqual(['Release v4']);
    r.releases = [rel('5', at(0, 11)), rel('4', at(10))];
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(events('release').map((e) => e.body)).toEqual(['Release v5', 'Release v4']);
  });

  it('only drafts at link time: published later, imported once', async () => {
    const { d, gh, events } = setup();
    const r = gh.repos.get(REPO)!;
    r.releases = [rel('7', null, { draft: true })];
    await d.github.syncDue(gh);
    r.releases = [rel('7', at(0, 11))];
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(events('release')).toHaveLength(1);
  });

  it('last seen release deleted: a new one is imported, the old ones are not re-imported', async () => {
    const { d, gh, events } = setup();
    const r = gh.repos.get(REPO)!;
    r.releases = [rel('2', at(5)), rel('1', at(10))];
    await d.github.syncDue(gh);
    t.clock.advance(MIN16);
    r.releases = [rel('3', new Date(t.clock.now - 60_000).toISOString()), rel('1', at(10))];
    await d.github.syncDue(gh);
    expect(events('release').map((e) => e.body)).toEqual([
      'Release v3',
      'Release v2',
      'Release v1',
    ]);
  });

  it('numeric-looking string ids (9 -> 10) are compared as ids, not order', async () => {
    const { d, gh, events } = setup();
    const r = gh.repos.get(REPO)!;
    r.releases = [rel('9', at(5))];
    await d.github.syncDue(gh);
    r.releases = [rel('10', at(0, 11)), rel('9', at(5))];
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(events('release').map((e) => e.body)).toEqual(['Release v10', 'Release v9']);
  });

  it('release whose name equals the tag or is empty: body is just the tag', async () => {
    const { d, gh, events } = setup();
    gh.repos.get(REPO)!.releases = [rel('1', at(5), { name: '' })];
    await d.github.syncDue(gh);
    expect(events('release')[0]?.body).toBe('Release v1');
    expect(events('release')[0]?.source).toBe('github');
  });
});

describe('verifyA6: errors never escape', () => {
  it('a non-GitHubError from the port becomes a repo error', async () => {
    const { d, gh, row } = setup();
    gh.commits = async () => {
      throw new TypeError('fetch failed');
    };
    const run = await d.github.syncDue(gh);
    expect(run.repos[0]?.error).toBe('unavailable');
    expect(row()?.lastSyncError).toBe('unavailable');
    expect(row()?.backfilledAt).toBeNull();
  });

  it('rate limited without resetAt: blocked for a while, then runs', async () => {
    const { d, gh } = setup();
    gh.fail = new GitHubError('rate_limited', 'limit');
    await d.github.syncDue(gh);
    gh.fail = null;
    expect(d.github.status().error).toBe('rate_limited');
    expect((await d.github.syncDue(gh)).skipped).toBe('rate_limited');
    t.clock.advance(60 * 60_000);
    expect((await d.github.syncDue(gh)).skipped).toBeNull();
    expect(d.github.status().error).toBeNull();
  });

  it('401 on the second repo: the first repo keeps its events, lastSyncAt is not advanced', async () => {
    const { d, gh, p, totalCount } = setup();
    gh.push(REPO, { date: at(1) });
    d.projects.linkRepo(p.id, { fullName: 'example/second' }, UI);
    gh.add('example/second');
    const orig = gh.repo.bind(gh);
    gh.repo = async (name: string) => {
      if (name === 'example/second') throw new GitHubError('unauthorized', 'Bad credentials');
      return orig(name);
    };
    const run = await d.github.syncDue(gh);
    expect(run.repos.map((r) => r.repo)).toEqual([REPO]);
    expect(totalCount()).toBe(1);
    expect(d.github.status()).toMatchObject({ error: 'token_invalid', lastSyncAt: null });
  });

  it('token removed: status of a previous run stays readable, no calls', async () => {
    const { d, gh } = setup();
    await d.github.syncDue(gh);
    const calls = { ...gh.calls };
    d.settings.update({ githubToken: null }, UI);
    expect(d.settings.get().githubToken).toBeFalsy();
    t.clock.advance(MIN16);
    expect((await d.github.syncDue(gh)).skipped).toBe('no_token');
    expect(gh.calls).toEqual(calls);
    expect(d.github.status().lastSyncAt).not.toBeNull();
  });
});

describe('verifyA6: docs', () => {
  it('GitHub copy with no commits touching it still replaces an older hook copy', async () => {
    const { d, gh, p } = setup();
    d.hooks.sessionStart('s1', { remote: `git@github.com:${REPO}.git` });
    d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# local\n'));
    t.clock.advance(MIN16);
    gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: '# pushed\n', commits: [] };
    const run = await d.github.syncDue(gh);
    expect(run.repos[0]?.error).toBeNull();
    // No commit date available: the documented rule cannot decide; just must not crash.
    expect(d.projects.docs(p.id).repos[0]?.content).toBeTruthy();
  });

  it('docs fixed after docs_not_utf8: error cleared and content stored', async () => {
    const { d, gh, row } = setup();
    const files = gh.repos.get(REPO)!.files;
    files['DECISIONS.md'] = { text: Buffer.from([0xff, 0xfe, 0x41]), commits: [] };
    await d.github.syncDue(gh);
    expect(row()?.lastSyncError).toBe('docs_not_utf8');
    files['DECISIONS.md'] = { text: '# ok è\n', commits: [] };
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(row()?.lastSyncError).toBeNull();
    expect(row()?.docsContent).toBe('# ok è\n');
    expect(row()?.docsOrigin).toBe('github');
  });

  it('docs_not_utf8 does not block commits and releases', async () => {
    const { d, gh, totalCount, events } = setup();
    gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: Buffer.from([0xc3]), commits: [] };
    gh.push(REPO, { date: at(1) });
    gh.repos.get(REPO)!.releases = [rel('1', at(2))];
    await d.github.syncDue(gh);
    expect(totalCount()).toBe(1);
    expect(events('release')).toHaveLength(1);
  });

  it('after changing docsPath the new path is read from GitHub on the next sync', async () => {
    const { d, gh, row } = setup();
    const files = gh.repos.get(REPO)!.files;
    files['DECISIONS.md'] = { text: '# same\n', commits: [] };
    files['docs/ADR.md'] = { text: '# same\n', commits: [] }; // same bytes, same blob sha
    await d.github.syncDue(gh);
    d.projects.updateRepo(row()!.id, { docsPath: 'docs/ADR.md' }, UI);
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    expect(row()?.docsContent).toBe('# same\n');
    expect(row()?.docsOrigin).toBe('github');
  });

  it('docs file deleted on GitHub: no error, the cached copy is not corrupted', async () => {
    const { d, gh, row } = setup();
    const files = gh.repos.get(REPO)!.files;
    files['DECISIONS.md'] = { text: '# x\n', commits: [] };
    await d.github.syncDue(gh);
    delete files['DECISIONS.md'];
    t.clock.advance(MIN16);
    const run = await d.github.syncDue(gh);
    expect(run.repos[0]?.error).toBeNull();
    expect(row()?.lastSyncError).toBeNull();
  });
});
