import { GitHubError, gitBlobSha } from '@heph/core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApps } from '../test/app.js';
import { type FakeCommit, startFakeGitHub } from '../test/fake-github-server.js';
import { GitHubClients } from './clients.js';
import { HttpGitHub } from './http.js';

// Adapter (D61) against a local fake shaped like the real API. Invented data.
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const REPO = 'example/spot-welder';

async function fake() {
  const gh = await startFakeGitHub();
  closers.push(gh.close);
  const commits: FakeCommit[] = Array.from({ length: 250 }, (_, i) => ({
    sha: String(250 - i).padStart(40, 'a'),
    message: `Commit ${250 - i}\n\nbody text`,
    author: 'Invented Dev',
    date: new Date(Date.UTC(2026, 10, 20) - i * 3_600_000).toISOString(),
    files: i % 50 === 0 ? ['docs/decisioni è.md'] : [],
  }));
  gh.state.repos.set(REPO, {
    defaultBranch: 'main',
    commits: { main: commits },
    releases: [
      {
        id: 7,
        tag_name: 'v1.0',
        name: null,
        draft: false,
        prerelease: false,
        published_at: '2026-11-01T10:00:00Z',
      },
    ],
    files: {
      'docs/decisioni è.md': '# Decisioni\r\n',
      'DECISIONS.md': Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0a]),
    },
  });
  const port = new HttpGitHub({ token: gh.state.token, baseUrl: gh.url });
  return { gh, port };
}

describe('HttpGitHub', () => {
  it('repo, paginated commits with stop and max, releases', async () => {
    const { port, gh } = await fake();
    expect(await port.repo(REPO)).toEqual({
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/example/spot-welder',
    });
    const all = await port.commits(REPO, {
      branch: 'main',
      since: '2000-01-01T00:00:00Z',
      stopAt: null,
      max: 2000,
    });
    expect(all.commits).toHaveLength(250); // three pages of 100
    expect(all.commits[0]).toMatchObject({ message: 'Commit 250', author: 'Invented Dev' });
    const stop = await port.commits(REPO, {
      branch: 'main',
      since: '2000-01-01T00:00:00Z',
      stopAt: all.commits[120]!.sha,
      max: 2000,
    });
    expect(stop).toMatchObject({ reachedStop: true, truncated: false });
    expect(stop.commits).toHaveLength(120);
    const capped = await port.commits(REPO, {
      branch: 'main',
      since: '2000-01-01T00:00:00Z',
      stopAt: null,
      max: 10,
    });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.commits).toHaveLength(10);
    expect(await port.releases(REPO, 100)).toEqual([
      {
        id: '7',
        tag: 'v1.0',
        name: 'v1.0',
        draft: false,
        prerelease: false,
        url: 'https://github.com/example/spot-welder/releases/tag/v1.0',
        publishedAt: '2026-11-01T10:00:00Z',
      },
    ]);
    expect(gh.state.requests.every((r) => r.auth)).toBe(true);
  });

  it('contents: raw bytes, blob SHA computed locally, encoded paths, 404 → null', async () => {
    const { port } = await fake();
    const f = await port.content(REPO, 'docs/decisioni è.md');
    expect(f?.bytes.toString()).toBe('# Decisioni\r\n');
    expect(f?.sha).toBe(gitBlobSha(Buffer.from('# Decisioni\r\n')));
    const bom = await port.content(REPO, 'DECISIONS.md');
    expect(bom?.bytes[0]).toBe(0xef);
    expect(await port.content(REPO, 'MISSING.md')).toBeNull();
    const touched = await port.pathCommits(REPO, 'docs/decisioni è.md', 5);
    expect(touched).toHaveLength(5);
  });

  it('conditional requests: the second identical call is a 304 served from cache', async () => {
    const { port, gh } = await fake();
    const a = await port.releases(REPO, 10);
    const b = await port.releases(REPO, 10);
    expect(b).toEqual(a);
    expect(gh.state.requests.map((r) => r.status)).toEqual([200, 304]);
  });

  it('maps failures to GitHubError codes', async () => {
    const { port, gh } = await fake();
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        return e instanceof GitHubError ? e.code : 'other';
      }
    };
    expect(await code(port.repo('example/nope'))).toBe('not_found');
    gh.state.forceStatus = 500;
    expect(await code(port.repo(REPO))).toBe('unavailable');
    gh.state.forceStatus = 403; // rate limit (remaining 0)
    expect(await code(port.repo(REPO))).toBe('rate_limited');
    gh.state.forceStatus = 401;
    expect(await code(port.repo(REPO))).toBe('unauthorized');
    gh.state.forceStatus = null;
    const wrong = new HttpGitHub({ token: 'wrong', baseUrl: gh.url });
    expect(await code(wrong.repo(REPO))).toBe('unauthorized');
    const down = new HttpGitHub({ token: 'x', baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000 });
    expect(await code(down.repo(REPO))).toBe('unavailable');
  });

  it('an empty repository has no commits', async () => {
    const { port, gh } = await fake();
    gh.state.repos.set('example/empty', {
      defaultBranch: 'main',
      commits: {},
      releases: [],
      files: {},
      empty: true,
    });
    expect(
      await port.commits('example/empty', {
        branch: 'main',
        since: '2000-01-01T00:00:00Z',
        stopAt: null,
        max: 10,
      }),
    ).toEqual({
      commits: [],
      reachedStop: false,
      truncated: false,
    });
  });

  it('whoami counts readable repositories', async () => {
    const { port, gh } = await fake();
    gh.state.repos.set('example/other', {
      defaultBranch: 'main',
      commits: {},
      releases: [],
      files: {},
    });
    expect(await port.whoami()).toEqual({ login: 'invented-user', repoCount: 2 });
  });
});

describe('GitHub REST routes and the poller (D61, D62)', () => {
  it('no token: status says so, sync and verify do not call GitHub', async () => {
    const { gh } = await fake();
    const t = makeApps();
    await t.setup();
    const clients = new GitHubClients(t.d, gh.url);
    expect(clients.port()).toBeNull();
    expect(await clients.syncDue()).toEqual({ skipped: 'no_token', repos: [] });
    expect(await clients.verify()).toEqual({ ok: false, error: 'no_token' });
    expect(gh.state.requests).toHaveLength(0);
  });

  it('end to end: token set, project linked, poll imports the year, Sync now and status', async () => {
    const { gh } = await fake();
    const t = makeApps();
    const token = await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: gh.state.token } });
    const p = (
      await t.uiReq('POST', '/api/projects', { json: { name: 'Spot Welder', repos: [REPO] } })
    ).data;
    const clients = new GitHubClients(t.d, gh.url);
    // The routes use the same clients as the server's poller.
    const { createAgentApp } = await import('../app.js');
    const pino = (await import('pino')).default;
    const agent = createAgentApp({
      domain: t.d,
      log: pino({ level: 'silent' }),
      webDir: null,
      github: clients,
    });

    const run = await clients.syncDue();
    expect(run.repos[0]?.error).toBeNull();
    const diary = await t.uiReq('GET', `/api/projects/${p.id}/diary?limit=500`);
    const commitEvents = diary.data.filter((e: { eventKind: string }) => e.eventKind === 'commits');
    expect(commitEvents.length).toBeGreaterThan(5); // 250 commits one per hour = ~11 days
    expect(commitEvents.every((e: { source: string }) => e.source === 'github')).toBe(true);

    const res = await agent.request(`/api/projects/${p.id}/github/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: null, status: { error: null } });

    const status = await t.uiReq('GET', '/api/github/status');
    expect(status.data).toMatchObject({ tokenSet: true, pollMinutes: 15, error: null });
    expect(status.data.lastSyncAt).not.toBeNull();
    expect(JSON.stringify(status.data)).not.toContain(gh.state.token);
    expect(await clients.verify()).toEqual({ ok: true, login: 'invented-user', repoCount: 1 });

    // Token removed from Settings: no more calls.
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: null } });
    const before = gh.state.requests.length;
    expect((await clients.syncDue()).skipped).toBe('no_token');
    expect(gh.state.requests.length).toBe(before);
  });

  it('a rotated token is picked up without a restart', async () => {
    const { gh } = await fake();
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: 'old-token' } });
    const clients = new GitHubClients(t.d, gh.url);
    expect(await clients.verify()).toEqual({ ok: false, error: 'unauthorized' });
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: gh.state.token } });
    expect((await clients.verify()).ok).toBe(true);
  });
});
