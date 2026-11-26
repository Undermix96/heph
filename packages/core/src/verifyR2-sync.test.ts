import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { FakeGitHub } from './test/fake-github.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

// Independent verification, round 2 of phase 6 fixes (D61-D63, D54). Invented data.
let t: TestDomain;
afterEach(() => t?.cleanup());

const REPO = 'example/verify-r2';
const NOW = Date.UTC(2026, 10, 24, 12);
const at = (daysAgo: number, hour = 10) =>
  new Date(NOW - daysAgo * DAY_MS + (hour - 12) * 3_600_000).toISOString();
const MIN16 = 16 * 60_000;

/** FakeGitHub that records the `since` of every commits call. */
class SpyGitHub extends FakeGitHub {
  sinces: string[] = [];
  override async commits(
    fullName: string,
    o: { branch: string; since: string; stopAt: string | null; max: number },
  ) {
    this.sinces.push(o.since);
    return super.commits(fullName, o);
  }
}

function setup(over: Record<string, unknown> = {}) {
  t = makeDomain(NOW);
  t.d.settings.update({ githubToken: 'invented-token' }, UI);
  const gh = new SpyGitHub();
  gh.add(REPO);
  const p = seedProject(t.d, { repos: [REPO], ...over });
  const events = (kind: string) =>
    t.d.diary.list(p.id, { limit: 500 }).filter((e) => e.type === 'event' && e.eventKind === kind);
  const total = () =>
    events('commits').reduce((s, e) => s + Number((e.data as { count: number }).count), 0);
  const row = () => t.d.projects.repoRows(p.id)[0];
  return { d: t.d, gh, p, events, total, row };
}

describe('verifyR2: stable `since` (ETag 304s) keeps importing correctly', () => {
  it('first sync imports the whole year, including a commit 364 days ago', async () => {
    const { d, gh, total } = setup();
    gh.push(REPO, { date: at(364, 13) });
    gh.push(REPO, { date: at(200) });
    gh.push(REPO, { date: at(0, 9) });
    await d.github.syncDue(gh);
    expect(total()).toBe(3);
  });

  it('same `since` on two polls of the same day, a later one the next day', async () => {
    const { d, gh } = setup();
    gh.push(REPO, { date: at(1) });
    await d.github.syncDue(gh);
    t.clock.advance(MIN16);
    gh.push(REPO, { date: new Date(t.clock.now).toISOString() });
    await d.github.syncDue(gh);
    expect(gh.sinces).toHaveLength(2);
    expect(gh.sinces[1]).toBe(gh.sinces[0]);
    t.clock.advance(DAY_MS);
    await d.github.syncDue(gh);
    expect(gh.sinces[2]).not.toBe(gh.sinces[0]);
  });

  it('incremental polls over several days: every commit exactly once', async () => {
    const { d, gh, total } = setup();
    let pushed = 0;
    for (let i = 0; i < 6; i++) {
      gh.push(REPO, { date: new Date(t.clock.now - 60_000).toISOString() });
      pushed++;
      await d.github.syncDue(gh);
      t.clock.advance(10 * 3_600_000); // crosses midnight every few polls
    }
    expect(total()).toBe(pushed);
  });

  it('force push (last seen commit gone): only commits newer than it are imported', async () => {
    const { d, gh, total } = setup();
    gh.push(REPO, { date: at(2), sha: 'a'.repeat(40) });
    gh.push(REPO, { date: at(1), sha: 'b'.repeat(40) });
    await d.github.syncDue(gh);
    expect(total()).toBe(2);
    // Rewrite history: b replaced by c (older than b) and d (newer).
    const r = gh.repos.get(REPO)!;
    r.commits.main = r.commits.main!.filter((c) => c.sha !== 'b'.repeat(40));
    t.clock.advance(MIN16);
    gh.push(REPO, { date: at(1, 8), sha: 'c'.repeat(40) });
    gh.push(REPO, { date: new Date(t.clock.now - 60_000).toISOString(), sha: 'd'.repeat(40) });
    await d.github.syncDue(gh);
    expect(total()).toBe(3); // a, b, d (c is older than the last seen commit)
  });
});

describe('verifyR2: docs origin after the hook copy matches GitHub', () => {
  function withDocs() {
    const s = setup();
    s.gh.repos.get(REPO)!.files['DECISIONS.md'] = {
      text: '# G1 (invented)\n',
      commits: [{ sha: '1'.repeat(40), message: 'Docs', author: 'Dev', date: at(3), url: 'u' }],
    };
    s.d.hooks.sessionStart('s1', { remote: `git@github.com:${REPO}.git` });
    return s;
  }
  const docs = (s: ReturnType<typeof setup>) => s.d.projects.docs(s.p.id).repos[0];

  it('local copy pushed later: GitHub copy (fix B6)', async () => {
    const s = withDocs();
    await s.d.github.syncDue(s.gh);
    t.clock.advance(MIN16);
    s.d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# L1\n'));
    t.clock.advance(MIN16);
    s.gh.repos.get(REPO)!.files['DECISIONS.md'] = {
      text: '# L1\n',
      commits: [
        {
          sha: '2'.repeat(40),
          message: 'Docs',
          author: 'Dev',
          date: new Date(t.clock.now - 60_000).toISOString(),
          url: 'u',
        },
      ],
    };
    await s.d.github.syncDue(s.gh);
    expect(docs(s)?.docsOrigin).toBe('github');
  });

  it('hook uploads bytes equal to the GitHub copy already seen: shown as the GitHub copy', async () => {
    // Pushed L1, then edited locally (L2, kept as newer local copy), then reverted to L1.
    const s = withDocs();
    await s.d.github.syncDue(s.gh);
    t.clock.advance(MIN16);
    s.gh.repos.get(REPO)!.files['DECISIONS.md'] = {
      text: '# L1\n',
      commits: [
        {
          sha: '2'.repeat(40),
          message: 'Docs',
          author: 'Dev',
          date: new Date(t.clock.now).toISOString(),
          url: 'u',
        },
      ],
    };
    t.clock.advance(60_000);
    s.d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# L2 local edit\n'));
    t.clock.advance(MIN16);
    await s.d.github.syncDue(s.gh);
    expect(docs(s)?.docsOrigin).toBe('hook'); // L2 newer than the push: local wins (D63)
    t.clock.advance(MIN16);
    s.d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# L1\n')); // reverted locally
    t.clock.advance(MIN16);
    await s.d.github.syncDue(s.gh);
    expect(docs(s)?.content).toBe('# L1\n');
    expect(docs(s)?.docsOrigin).toBe('github');
  });
});

describe('verifyR2: global status', () => {
  it('a failing repo (not found) still clears a stale refused-token status', async () => {
    const { d, gh } = setup();
    d.settings.setGithubStatus({ lastSyncAt: null, error: 'token_invalid', resetAt: null });
    gh.repos.clear(); // repo gone: per-repo error, but GitHub answered
    await d.github.syncDue(gh);
    expect(d.github.status().error).toBeNull();
  });

  it('saving a new token clears an active rate limit and the next run goes ahead', async () => {
    const { d, gh } = setup();
    const resetAt = new Date(NOW + 30 * 60_000).toISOString();
    d.settings.setGithubStatus({ lastSyncAt: null, error: 'rate_limited', resetAt });
    d.settings.update({ githubToken: 'invented-token-2' }, UI);
    // A new token has its own quota: clearing is expected here.
    expect(d.github.status().error).toBeNull();
    const r = await d.github.syncDue(gh);
    expect(r.skipped).toBeNull();
  });
});

describe('verifyR2: relink of a repo whose earlier link imported only releases', () => {
  it('does not import commits older than a year (D62)', async () => {
    const { d, gh, p, row, events } = setup();
    d.projects.updateRepo(row()!.id, { showCommits: false }, UI);
    gh.repos.get(REPO)!.releases = [
      {
        id: '1',
        tag: 'v1',
        name: 'v1',
        draft: false,
        prerelease: false,
        url: 'u',
        publishedAt: at(10),
      },
    ];
    await d.github.syncDue(gh);
    expect(events('release')).toHaveLength(1);
    d.projects.unlinkRepo(row()!.id, UI);
    d.projects.linkRepo(p.id, { fullName: REPO }, UI);
    gh.push(REPO, { date: at(800) }); // two years old
    gh.push(REPO, { date: at(5) });
    t.clock.advance(MIN16);
    await d.github.syncDue(gh);
    const counts = events('commits').map((e) => (e.data as { day: string }).day);
    expect(counts).toHaveLength(1);
  });
});
