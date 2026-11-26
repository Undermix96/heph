import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { commitsByDay, GitHubError, localDay } from './github.js';
import { FakeGitHub } from './test/fake-github.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

// Invented repos and commits. The clock starts 2026-11-24T12:00Z (makeDomain), Europe/Rome.
let t: TestDomain;
afterEach(() => t?.cleanup());

const REPO = 'example/spot-welder';
const NOW = Date.UTC(2026, 10, 24, 12);
const at = (daysAgo: number, hour = 10) =>
  new Date(NOW - daysAgo * DAY_MS + (hour - 12) * 3_600_000).toISOString();

function setup(over: Record<string, unknown> = {}) {
  t = makeDomain();
  t.d.settings.update({ githubToken: 'invented-token' }, UI);
  const gh = new FakeGitHub();
  gh.add(REPO);
  const p = seedProject(t.d, { repos: [REPO], ...over });
  const events = (kind?: string) =>
    t.d.diary
      .list(p.id, { limit: 500 })
      .filter((e) => e.type === 'event' && (!kind || e.eventKind === kind));
  const repo = () => t.d.projects.get(p.id).repoDetails[0];
  const row = () => t.d.projects.repoRows(p.id)[0];
  return { ...t, gh, p, events, repo, row };
}

describe('commitsByDay / localDay', () => {
  it('groups by local day in the given time zone, days oldest first', () => {
    // 23:30 UTC on the 1st is already the 2nd in Rome.
    expect(localDay('2026-03-01T23:30:00Z', 'Europe/Rome')).toBe('2026-03-02');
    expect(localDay('2026-03-01T23:30:00Z', 'UTC')).toBe('2026-03-01');
    const c = (date: string, sha: string) => ({ sha, message: sha, author: null, date, url: '' });
    const g = commitsByDay(
      [
        c('2026-03-02T08:00:00Z', 'b'),
        c('2026-03-01T09:00:00Z', 'a'),
        c('2026-03-02T09:00:00Z', 'c'),
      ],
      'Europe/Rome',
    );
    expect(g.map((x) => x.day)).toEqual(['2026-03-01', '2026-03-02']);
    expect(g[1]?.commits.map((x) => x.sha)).toEqual(['c', 'b']);
  });
});

describe('first sync: one-year import (D62)', () => {
  it('imports commits of the last year as one event per day, and releases, once', async () => {
    const { d, gh, events, row } = setup();
    gh.push(REPO, { date: at(400), message: 'too old' });
    gh.push(REPO, { date: at(30, 9), message: 'Schematic' });
    gh.push(REPO, { date: at(30, 15), message: 'BOM' });
    gh.push(REPO, { date: at(2), message: 'Case' });
    gh.repos.get(REPO)!.releases = [
      {
        id: '3',
        tag: 'v0.3',
        name: 'v0.3',
        draft: true,
        prerelease: false,
        url: 'u3',
        publishedAt: null,
      },
      {
        id: '2',
        tag: 'v0.2',
        name: 'Copper',
        draft: false,
        prerelease: true,
        url: 'u2',
        publishedAt: at(5),
      },
      {
        id: '1',
        tag: 'v0.1',
        name: 'v0.1',
        draft: false,
        prerelease: false,
        url: 'u1',
        publishedAt: at(500),
      },
    ];
    const run = await d.github.syncDue(gh);
    expect(run.skipped).toBeNull();
    expect(run.repos[0]).toMatchObject({ commitEvents: 2, releaseEvents: 1, error: null });

    const commits = events('commits');
    expect(commits).toHaveLength(2);
    // Newest first in the diary: the day 2 days ago, then the day 30 days ago (2 commits).
    expect(commits[0]?.body).toBe('1 commit on main: Case');
    expect(commits[1]?.body).toBe('2 commits on main: BOM');
    expect(commits[1]?.data).toMatchObject({ repo: REPO, branch: 'main', count: 2 });
    expect(commits[1]?.occurredAt).toBe(at(30, 15));
    expect(commits.every((e) => e.source === 'github')).toBe(true);

    const releases = events('release');
    expect(releases.map((e) => e.body)).toEqual(['Release v0.2: Copper (pre-release)']);
    expect(row()?.backfilledAt).not.toBeNull();

    // A second poll adds nothing.
    t.clock.advance(20 * 60_000);
    const again = await d.github.syncDue(gh);
    expect(again.repos[0]).toMatchObject({ commitEvents: 0, releaseEvents: 0 });
    expect(events('commits')).toHaveLength(2);
    expect(events('release')).toHaveLength(1);
  });

  it('updates the project last activity to the newest commit', async () => {
    const { d, gh, p } = setup();
    gh.push(REPO, { date: at(0, 11) });
    await d.github.syncDue(gh);
    expect(Date.parse(d.projects.get(p.id).lastActivityAt)).toBeGreaterThanOrEqual(
      Date.parse(at(0, 11)),
    );
  });
});

describe('incremental sync', () => {
  it('only new commits, grouped per day, after the poll interval', async () => {
    const { d, gh, events } = setup();
    gh.push(REPO, { date: at(3) });
    await d.github.syncDue(gh);
    expect(events('commits')).toHaveLength(1);

    gh.push(REPO, { date: at(0, 8), message: 'Wiring' });
    gh.push(REPO, { date: at(0, 9), message: 'Fuse' });
    // Not due yet (15 minutes by default).
    t.clock.advance(5 * 60_000);
    expect((await d.github.syncDue(gh)).repos).toHaveLength(0);
    t.clock.advance(11 * 60_000);
    const run = await d.github.syncDue(gh);
    expect(run.repos[0]?.commitEvents).toBe(1);
    expect(events('commits')[0]?.body).toBe('2 commits on main: Fuse');
  });

  it('showCommits off: no commit events, but state moves on', async () => {
    const { d, gh, events, p, row } = setup();
    const repoId = d.projects.get(p.id).repoDetails[0]!.id;
    d.projects.updateRepo(repoId, { showCommits: false }, UI);
    const c = gh.push(REPO, { date: at(1) });
    await d.github.syncDue(gh);
    expect(events('commits')).toHaveLength(0);
    expect(row()?.lastSeenCommitSha).toBe(c.sha);
    d.projects.updateRepo(repoId, { showCommits: true }, UI);
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    expect(events('commits')).toHaveLength(0); // the old commit is not imported later
  });

  it('force push: the last seen commit is gone, only commits newer than it are imported', async () => {
    const { d, gh, events } = setup();
    gh.push(REPO, { date: at(2), message: 'old' });
    await d.github.syncDue(gh);
    // History rewritten: the old commit disappears, a rewritten copy and a new one appear.
    gh.repos.get(REPO)!.commits.main = [];
    gh.push(REPO, { date: at(2), message: 'old (rewritten)', sha: 'f'.repeat(40) });
    gh.push(REPO, { date: at(0, 9), message: 'new', sha: 'e'.repeat(40) });
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    const bodies = events('commits').map((e) => e.body);
    expect(bodies).toEqual(['1 commit on main: new', '1 commit on main: old']);
  });

  it('new releases by id, oldest first in time', async () => {
    const { d, gh, events } = setup();
    const r = gh.repos.get(REPO)!;
    r.releases = [
      {
        id: '1',
        tag: 'v1',
        name: 'v1',
        draft: false,
        prerelease: false,
        url: 'u',
        publishedAt: at(3),
      },
    ];
    await d.github.syncDue(gh);
    r.releases = [
      {
        id: '3',
        tag: 'v3',
        name: 'v3',
        draft: false,
        prerelease: false,
        url: 'u',
        publishedAt: at(0, 9),
      },
      {
        id: '2',
        tag: 'v2',
        name: 'v2',
        draft: false,
        prerelease: false,
        url: 'u',
        publishedAt: at(0, 8),
      },
      ...r.releases,
    ];
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    expect(events('release').map((e) => e.body)).toEqual([
      'Release v3',
      'Release v2',
      'Release v1',
    ]);
  });

  it('default branch renamed: commits of the new branch after the last seen time', async () => {
    const { d, gh, events } = setup();
    gh.push(REPO, { date: at(2) });
    await d.github.syncDue(gh);
    const r = gh.repos.get(REPO)!;
    r.defaultBranch = 'trunk';
    r.commits.trunk = [...(r.commits.main ?? [])];
    gh.push(REPO, { date: at(0, 9), message: 'on trunk' }, 'trunk');
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    expect(events('commits')[0]?.body).toBe('1 commit on trunk: on trunk');
    expect(events('commits')).toHaveLength(2);
  });
});

describe('docs (D63)', () => {
  const touch = (daysAgo: number) => ({
    sha: 'd'.repeat(40),
    message: 'Docs: D2',
    author: 'Invented Dev',
    date: at(daysAgo),
    url: 'https://github.com/example/spot-welder/commit/ddd',
  });

  it('stores the pushed DECISIONS.md with origin github and the commits touching it', async () => {
    const { d, gh, repo, p } = setup();
    gh.repos.get(REPO)!.files['DECISIONS.md'] = {
      text: '# Decisions\n\n## D1 — Rame\n',
      commits: [touch(1)],
    };
    await d.github.syncDue(gh);
    expect(repo()).toMatchObject({ docsOrigin: 'github' });
    const docs = d.projects.docs(p.id);
    expect(docs.repos[0]?.content).toContain('D1 — Rame');
    expect(t.d.projects.repoRows(p.id)[0]?.docsCommits?.[0]?.message).toBe('Docs: D2');
    // Unchanged on GitHub: no new read of the commits.
    const before = gh.calls.pathCommits;
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    expect(gh.calls.pathCommits).toBe(before);
  });

  it('a newer local hook copy wins until GitHub changes again', async () => {
    const { d, gh, p } = setup();
    const files = gh.repos.get(REPO)!.files;
    files['DECISIONS.md'] = { text: '# v1\n', commits: [touch(2)] };
    await d.github.syncDue(gh);
    // Claude edits locally; the Stop hook uploads it.
    t.clock.advance(60_000);
    d.hooks.sessionStart('s1', { remote: `git@github.com:${REPO}.git` });
    d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# v1 + local edit\n'));
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    expect(d.projects.docs(p.id).repos[0]?.content).toBe('# v1 + local edit\n');
    // The edit is pushed later: GitHub's copy changes and is newer.
    files['DECISIONS.md'] = {
      text: '# v2 pushed\n',
      commits: [{ ...touch(0), date: new Date(t.clock.now).toISOString() }],
    };
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    const r = d.projects.docs(p.id).repos[0];
    expect(r?.content).toBe('# v2 pushed\n');
    expect(r?.docsOrigin).toBe('github');
  });

  it('a hook copy newer than the first GitHub read is kept', async () => {
    const { d, gh, p } = setup();
    d.hooks.sessionStart('s1', { remote: `git@github.com:${REPO}.git` });
    d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# local, unpushed\n'));
    gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: '# old pushed\n', commits: [touch(5)] };
    await d.github.syncDue(gh);
    expect(d.projects.docs(p.id).repos[0]?.content).toBe('# local, unpushed\n');
  });

  it('missing file, internal docs and non-UTF-8 files', async () => {
    const { d, gh, row } = setup();
    await d.github.syncDue(gh);
    expect(row()?.docsOrigin).toBeNull();
    gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: Buffer.from([0xe0, 0x80]), commits: [] };
    t.clock.advance(16 * 60_000);
    const run = await d.github.syncDue(gh);
    expect(run.repos[0]?.error).toBe('docs_not_utf8');
    expect(row()?.lastSyncError).toBe('docs_not_utf8');

    const other = setup({ docsSource: 'internal' });
    other.gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: '# x\n', commits: [] };
    await other.d.github.syncDue(other.gh);
    expect(other.gh.calls.content ?? 0).toBe(0);
  });

  it('changing the docs path forgets the GitHub copy', async () => {
    const { d, gh, p, row } = setup();
    gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: '# x\n', commits: [touch(1)] };
    await d.github.syncDue(gh);
    d.projects.updateRepo(row()!.id, { docsPath: 'docs/ADR.md' }, UI);
    expect(row()).toMatchObject({ docsGithubSha: null, docsCommits: null, docsContent: null });
    expect(d.projects.get(p.id).repoDetails[0]?.docsPath).toBe('docs/ADR.md');
  });
});

describe('no token, errors (D61)', () => {
  it('no token: no calls at all', async () => {
    const { d, gh } = setup();
    d.settings.update({ githubToken: null }, UI);
    expect(await d.github.syncDue(gh)).toEqual({ skipped: 'no_token', repos: [] });
    expect(gh.calls).toEqual({});
  });

  it('invalid token stops the run and is reported until a run succeeds', async () => {
    const { d, gh } = setup();
    gh.fail = new GitHubError('unauthorized', 'Bad credentials');
    await d.github.syncDue(gh);
    expect(d.github.status().error).toBe('token_invalid');
    gh.fail = null;
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    expect(d.github.status()).toMatchObject({ error: null });
    expect(d.github.status().lastSyncAt).not.toBeNull();
  });

  it('rate limit: nothing runs until the reset time', async () => {
    const { d, gh } = setup();
    gh.fail = new GitHubError('rate_limited', 'limit', NOW + 30 * 60_000);
    await d.github.syncDue(gh);
    gh.fail = null;
    t.clock.advance(20 * 60_000);
    expect((await d.github.syncDue(gh)).skipped).toBe('rate_limited');
    t.clock.advance(11 * 60_000);
    expect((await d.github.syncDue(gh)).skipped).toBeNull();
  });

  it('a missing repo is a repo error; the others still sync', async () => {
    const { d, gh, p, events } = setup();
    d.projects.linkRepo(p.id, { fullName: 'example/gone' }, UI);
    gh.push(REPO, { date: at(1) });
    const run = await d.github.syncDue(gh);
    expect(run.repos.map((r) => [r.repo, r.error])).toEqual([
      [REPO, null],
      ['example/gone', 'not_found'],
    ]);
    expect(events('commits')).toHaveLength(1);
    // Not retried on every tick: it waits for the next interval.
    expect((await d.github.syncDue(gh)).repos).toHaveLength(0);
  });

  it('a network error is a repo error and is retried next interval', async () => {
    const { d, gh, row } = setup();
    gh.fail = new GitHubError('unavailable', 'ECONNRESET');
    await d.github.syncDue(gh);
    expect(row()?.lastSyncError).toBe('unavailable');
    gh.fail = null;
    gh.push(REPO, { date: at(0, 9) });
    t.clock.advance(16 * 60_000);
    await d.github.syncDue(gh);
    expect(row()?.lastSyncError).toBeNull();
    expect(row()?.backfilledAt).not.toBeNull();
  });

  it('Sync now ignores the interval for one project', async () => {
    const { d, gh, p, events } = setup();
    await d.github.syncDue(gh);
    gh.push(REPO, { date: at(0, 11) });
    const run = await d.github.syncProject(p.id, gh);
    expect(run.repos[0]?.commitEvents).toBe(1);
    expect(events('commits')).toHaveLength(1);
  });
});
