import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { FakeGitHub } from './test/fake-github.js';
import { seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';
import { DAY_MS } from './util.js';

// Independent verification of phase 6 group A: concurrency between the poller, "Sync now",
// the UI and the Stop hook while a sync awaits GitHub. Invented data.
let t: TestDomain;
afterEach(() => t?.cleanup());

const REPO = 'example/spot-welder';
const NOW = Date.UTC(2026, 10, 24, 12);
const at = (daysAgo: number, hour = 10) =>
  new Date(NOW - daysAgo * DAY_MS + (hour - 12) * 3_600_000).toISOString();
const MIN16 = 16 * 60_000;

/** A FakeGitHub that runs `hook` once, right when `method` is called. */
class HookedGitHub extends FakeGitHub {
  on: { method: string; hook: () => void } | null = null;
  private fire(method: string) {
    if (this.on?.method === method) {
      const h = this.on.hook;
      this.on = null;
      h();
    }
  }
  override async releases(fullName: string, max: number) {
    this.fire('releases');
    return super.releases(fullName, max);
  }
  override async pathCommits(fullName: string, path: string, n: number) {
    this.fire('pathCommits');
    return super.pathCommits(fullName, path, n);
  }
}

function setup() {
  t = makeDomain();
  t.d.settings.update({ githubToken: 'invented-token' }, UI);
  const gh = new HookedGitHub();
  gh.add(REPO);
  const p = seedProject(t.d, { repos: [REPO] });
  const events = (kind: string) =>
    t.d.diary.list(p.id, { limit: 500 }).filter((e) => e.type === 'event' && e.eventKind === kind);
  const row = () => t.d.projects.repoRows(p.id)[0];
  return { d: t.d, gh, p, events, row };
}

describe('verifyA6: concurrent runs', () => {
  it('Sync now during the first poll: the year is imported once', async () => {
    const { d, gh, p, events } = setup();
    gh.push(REPO, { date: at(3) });
    gh.repos.get(REPO)!.releases = [
      {
        id: '1',
        tag: 'v1',
        name: 'v1',
        draft: false,
        prerelease: false,
        url: 'u',
        publishedAt: at(2),
      },
    ];
    await Promise.all([d.github.syncDue(gh), d.github.syncProject(p.id, gh)]);
    expect(events('commits')).toHaveLength(1);
    expect(events('release')).toHaveLength(1);
  });

  it('Sync now during an incremental poll: new commits are imported once', async () => {
    const { d, gh, p, events } = setup();
    gh.push(REPO, { date: at(3) });
    await d.github.syncDue(gh);
    gh.push(REPO, { date: at(0, 11) });
    t.clock.advance(MIN16);
    await Promise.all([d.github.syncDue(gh), d.github.syncProject(p.id, gh)]);
    expect(events('commits')).toHaveLength(2);
  });
});

describe('verifyA6: changes while a sync awaits GitHub', () => {
  it('project deleted during sync: nothing throws', async () => {
    const { d, gh, p } = setup();
    gh.push(REPO, { date: at(1) });
    gh.on = { method: 'releases', hook: () => d.projects.delete(p.id, UI) };
    const run = await d.github.syncDue(gh);
    expect(run.skipped).toBeNull();
    expect(d.projects.list()).toHaveLength(0);
  });

  it('repo unlinked during sync: no events for a repo that is no longer linked', async () => {
    const { d, gh, events, row } = setup();
    gh.push(REPO, { date: at(1) });
    const id = row()!.id;
    gh.on = { method: 'releases', hook: () => d.projects.unlinkRepo(id, UI) };
    await d.github.syncDue(gh);
    expect(events('commits')).toHaveLength(0);
  });

  it('showCommits turned off during sync is respected', async () => {
    const { d, gh, events, row } = setup();
    gh.push(REPO, { date: at(1) });
    const id = row()!.id;
    gh.on = {
      method: 'releases',
      hook: () => d.projects.updateRepo(id, { showCommits: false }, UI),
    };
    await d.github.syncDue(gh);
    expect(row()?.showCommits).toBe(false);
    expect(events('commits')).toHaveLength(0);
  });

  it('Stop hook uploads a newer local copy during sync: the local copy wins', async () => {
    const { d, gh, p } = setup();
    gh.repos.get(REPO)!.files['DECISIONS.md'] = {
      text: '# pushed yesterday\n',
      commits: [
        { sha: 'd'.repeat(40), message: 'Docs', author: 'Invented Dev', date: at(1), url: 'u' },
      ],
    };
    d.hooks.sessionStart('s1', { remote: `git@github.com:${REPO}.git` });
    gh.on = {
      method: 'pathCommits',
      hook: () => d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# local, newer\n')),
    };
    await d.github.syncDue(gh);
    const r = d.projects.docs(p.id).repos[0];
    expect(r?.content).toBe('# local, newer\n');
    expect(r?.docsOrigin).toBe('hook');
  });

  it('docsPath changed during sync: the old path copy is not stored for the new path', async () => {
    const { d, gh, row } = setup();
    gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: '# old path\n', commits: [] };
    const id = row()!.id;
    gh.on = {
      method: 'pathCommits',
      hook: () => d.projects.updateRepo(id, { docsPath: 'docs/ADR.md' }, UI),
    };
    await d.github.syncDue(gh);
    expect(row()?.docsPath).toBe('docs/ADR.md');
    expect(row()?.docsContent).toBeNull();
    expect(row()?.docsGithubSha).toBeNull();
  });
});
