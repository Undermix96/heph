import crypto from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GitHubError } from '@heph/core';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClients } from './github/clients.js';
import { HttpGitHub } from './github/http.js';
import { makeApps } from './test/app.js';
import { type FakeCommit, startFakeGitHub } from './test/fake-github-server.js';

// Independent verification, phase 6 group B (D61, D62, D54). Invented data.
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const REPO = 'example/verify-b6';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof GitHubError ? e.code : `other:${(e as Error).name}`;
  }
};

/** A fetch answering every call with one canned response. */
function cannedFetch(status: number, headers: Record<string, string>, body = '{}') {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(status === 304 ? null : body, { status, headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function fakeWithRepo(nCommits = 150) {
  const gh = await startFakeGitHub();
  closers.push(gh.close);
  const commits: FakeCommit[] = Array.from({ length: nCommits }, (_, i) => ({
    sha: String(nCommits - i).padStart(40, 'b'),
    message: `Commit ${nCommits - i}`,
    author: 'Invented Dev',
    date: new Date(Date.UTC(2026, 10, 23) - i * 3_600_000).toISOString(),
  }));
  gh.state.repos.set(REPO, {
    defaultBranch: 'main',
    commits: { main: commits },
    releases: [],
    files: { 'DECISIONS.md': '# Decisions (invented)\n' },
  });
  return gh;
}

describe('verifyB6: rate limits and error mapping (real GitHub quirks)', () => {
  it('429 with retry-after is rate_limited with resetAt = now + retry-after', async () => {
    const { f } = cannedFetch(429, { 'retry-after': '60', 'x-ratelimit-remaining': '4000' });
    const port = new HttpGitHub({ token: 't', baseUrl: 'http://x', fetch: f, now: () => 1_000 });
    try {
      await port.repo(REPO);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubError);
      expect((e as GitHubError).code).toBe('rate_limited');
      expect((e as GitHubError).resetAt).toBe(61_000);
    }
  });

  it('403 secondary rate limit WITHOUT retry-after and quota left is rate_limited, not "repo not found"', async () => {
    // GitHub docs (secondary rate limits): the response may carry neither retry-after
    // nor remaining=0; the body says "secondary rate limit". Clients should wait >= 1 min.
    const { f } = cannedFetch(
      403,
      { 'x-ratelimit-remaining': '4321', 'content-type': 'application/json' },
      JSON.stringify({
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
        documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api',
      }),
    );
    const port = new HttpGitHub({ token: 't', baseUrl: 'http://x', fetch: f });
    expect(await code(port.repo(REPO))).toBe('rate_limited');
  });

  it('a rate-limit Retry-After that is not a number does not crash the sync', async () => {
    // Defensive: a proxy or a future API change sending an HTTP-date.
    const { f } = cannedFetch(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: 'invented-token' } });
    await t.uiReq('POST', '/api/projects', { json: { name: 'Verify RA', repos: [REPO] } });
    const clients = new GitHubClients(t.d, 'http://x', f);
    const run = await clients.syncDue().then(
      (r) => r,
      (e: Error) => ({ crashed: e.name }),
    );
    expect(run).not.toHaveProperty('crashed');
    expect(t.d.github.status().error).toBe('rate_limited');
  });

  it('a 200 with a non-JSON body (captive portal / proxy page) is a repo error, the server keeps going', async () => {
    const { f } = cannedFetch(200, { 'content-type': 'text/html' }, '<html>login</html>');
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: 'invented-token' } });
    await t.uiReq('POST', '/api/projects', { json: { name: 'Verify HTML', repos: [REPO] } });
    const clients = new GitHubClients(t.d, 'http://x', f);
    const run = await clients.syncDue();
    expect(run.repos[0]?.error).toBe('unavailable');
    expect(await clients.verify()).toEqual({ ok: false, error: 'unavailable' });
  });

  it('the token never appears in error messages', async () => {
    const token = 'ghp_invented_secret_value_123';
    for (const s of [401, 403, 404, 422, 500, 502]) {
      const { f } = cannedFetch(s, { 'x-ratelimit-remaining': '10' });
      const port = new HttpGitHub({ token, baseUrl: 'http://x', fetch: f });
      try {
        await port.repo(REPO);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain(token);
        expect(JSON.stringify(e)).not.toContain(token);
      }
    }
  });
});

describe('verifyB6: redirects (renamed / transferred repos)', () => {
  it('a 301 on /repos/old/name is followed with the token kept (same origin)', async () => {
    let authOnTarget: string | undefined;
    const srv = createServer((req, res) => {
      if (req.url === '/repos/example/old-name') {
        res.writeHead(301, { location: `http://${req.headers.host}/repositories/42` });
        return res.end(JSON.stringify({ message: 'Moved Permanently' }));
      }
      if (req.url === '/repositories/42') {
        authOnTarget = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ default_branch: 'main', html_url: 'https://github.com/example/new' }),
        );
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise<void>((r) => srv.close(() => r())));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const port = new HttpGitHub({ token: 'invented', baseUrl: url });
    expect(await port.repo('example/old-name')).toEqual({
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/example/new',
    });
    expect(authOnTarget).toBe('Bearer invented');
  });
});

describe('verifyB6: polling over time', () => {
  it('the ETag cache stays bounded across many polls of an active repo (no memory growth)', async () => {
    const gh = await fakeWithRepo(150);
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: gh.state.token } });
    await t.uiReq('POST', '/api/projects', { json: { name: 'Verify Poll', repos: [REPO] } });
    const clients = new GitHubClients(t.d, gh.url);
    await clients.syncDue();
    const sizes: number[] = [];
    for (let i = 0; i < 20; i++) {
      t.clock.now += 16 * 60_000; // past githubPollMinutes (15)
      const run = await clients.syncDue();
      expect(run.repos).toHaveLength(1);
      // biome-ignore lint/suspicious/noExplicitAny: inspect the private cache
      sizes.push((clients.port() as any).etags.size);
    }
    // Same repo, nothing new: the cache should not grow with each poll.
    expect(sizes.at(-1)).toBeLessThanOrEqual((sizes[0] ?? 0) + 2);
  });

  it('a repeat poll with nothing new uses conditional requests for the commit list', async () => {
    const gh = await fakeWithRepo(30);
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: gh.state.token } });
    await t.uiReq('POST', '/api/projects', { json: { name: 'Verify Cond', repos: [REPO] } });
    const clients = new GitHubClients(t.d, gh.url);
    await clients.syncDue();
    t.clock.now += 16 * 60_000;
    const before = gh.state.requests.length;
    await clients.syncDue();
    const commitCalls = gh.state.requests
      .slice(before)
      .filter((r) => r.path.includes('/commits?') && !r.path.includes('path='));
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(commitCalls.every((r) => r.status === 304)).toBe(true);
  });

  it('token rotated while polling: the next poll uses the new token and clears token_invalid', async () => {
    const gh = await fakeWithRepo(5);
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: 'expired-invented' } });
    await t.uiReq('POST', '/api/projects', { json: { name: 'Verify Rot', repos: [REPO] } });
    const clients = new GitHubClients(t.d, gh.url);
    await clients.syncDue();
    expect(t.d.github.status().error).toBe('token_invalid');
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: gh.state.token } });
    const run = await clients.syncDue(); // the repo was not marked polled: still due
    expect(run.repos[0]?.error).toBeNull();
    expect(t.d.github.status().error).toBeNull();
    expect(gh.state.requests.filter((r) => !r.auth).length).toBeGreaterThan(0);
  });

  it('an invalid token with no linked repos does not report a successful sync', async () => {
    const gh = await fakeWithRepo(5);
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: 'expired-invented' } });
    const p = (
      await t.uiReq('POST', '/api/projects', { json: { name: 'Verify NR', repos: [REPO] } })
    ).data;
    const clients = new GitHubClients(t.d, gh.url);
    await clients.syncDue();
    expect(t.d.github.status().error).toBe('token_invalid');
    // Unlink the only repo: the next tick has nothing to poll.
    const detail = (await t.uiReq('GET', `/api/projects/${p.id}`)).data;
    const del = await t.uiReq('DELETE', `/api/repos/${detail.repoDetails[0].id}`);
    expect(del.status).toBe(200);
    await clients.syncDue();
    expect(t.d.github.status().error).toBe('token_invalid');
  });

  it('many repos with mixed failures: each gets its own error, healthy ones still sync', async () => {
    const gh = await fakeWithRepo(5);
    gh.state.repos.set('example/empty-b6', {
      defaultBranch: 'main',
      commits: {},
      releases: [],
      files: {},
      empty: true,
    });
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: gh.state.token } });
    await t.uiReq('POST', '/api/projects', {
      json: { name: 'Verify Many', repos: ['example/missing-b6', 'example/empty-b6', REPO] },
    });
    const clients = new GitHubClients(t.d, gh.url);
    const run = await clients.syncDue();
    const by = Object.fromEntries(run.repos.map((r) => [r.repo, r.error]));
    expect(by['example/missing-b6']).toBe('not_found');
    expect(by['example/empty-b6']).toBeNull();
    expect(by[REPO]).toBeNull();
  });
});

describe('verifyB6: routes', () => {
  it('Sync now on an unknown project is a 404 JSON, not a crash', async () => {
    const gh = await fakeWithRepo(1);
    const t = makeApps();
    const token = await t.setup();
    const clients = new GitHubClients(t.d, gh.url);
    const { createAgentApp } = await import('./app.js');
    const pino = (await import('pino')).default;
    const agent = createAgentApp({
      domain: t.d,
      log: pino({ level: 'silent' }),
      webDir: null,
      github: clients,
    });
    const res = await agent.request('/api/projects/does-not-exist/github/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('Verify is UI-only: the agent token cannot call it', async () => {
    const t = makeApps();
    const token = await t.setup();
    const res = await t.agent.request('/api/github/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('status never contains the token', async () => {
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: 'ghp_invented_zzz' } });
    const s = await t.uiReq('GET', '/api/github/status');
    expect(JSON.stringify(s.data)).not.toContain('ghp_invented_zzz');
    expect(s.data.tokenSet).toBe(true);
  });
});

describe('verifyB6: docs origin through the real adapter (D63)', () => {
  async function setupDocs() {
    const gh = await fakeWithRepo(0);
    const model = gh.state.repos.get(REPO);
    if (!model) throw new Error('no repo');
    const t = makeApps();
    await t.setup();
    await t.uiReq('PATCH', '/api/settings', { json: { githubToken: gh.state.token } });
    const p = (
      await t.uiReq('POST', '/api/projects', {
        json: { name: 'Verify Docs', repos: [{ fullName: REPO, docsPath: 'DECISIONS.md' }] },
      })
    ).data;
    const clients = new GitHubClients(t.d, gh.url);
    const push = (text: string, at: number) => {
      model.files['DECISIONS.md'] = text;
      model.commits.main = [
        {
          sha: crypto.randomUUID().replace(/-/g, '').padEnd(40, 'c'),
          message: 'Docs: update decisions',
          author: 'Invented Dev',
          date: new Date(at).toISOString(),
          files: ['DECISIONS.md'],
        },
        ...(model.commits.main ?? []),
      ];
    };
    const repoView = async () =>
      (await t.uiReq('GET', `/api/projects/${p.id}/docs`)).data.repos[0] as {
        content: string;
        docsOrigin: string;
      };
    t.d.hooks.sessionStart('s-b6', { remote: `git@github.com:${REPO}.git` });
    return { t, clients, push, repoView };
  }

  it('pushed file replaces the cache; a later hook copy wins; a new push wins again', async () => {
    const { t, clients, push, repoView } = await setupDocs();
    push('# v1 (invented)\n', t.clock.now - 60_000);
    await clients.syncDue();
    expect(await repoView()).toMatchObject({ content: '# v1 (invented)\n', docsOrigin: 'github' });
    t.clock.now += 60_000;
    t.d.hooks.storeDocs('s-b6', 'DECISIONS.md', Buffer.from('# v1 + local edit\n'));
    t.clock.now += 16 * 60_000;
    await clients.syncDue();
    expect(await repoView()).toMatchObject({ content: '# v1 + local edit\n', docsOrigin: 'hook' });
    push('# v2 pushed\n', t.clock.now);
    t.clock.now += 16 * 60_000;
    await clients.syncDue();
    expect(await repoView()).toMatchObject({ content: '# v2 pushed\n', docsOrigin: 'github' });
  });

  it('commit+push, then the Stop hook uploads the same bytes, then the poll: origin is GitHub (it IS pushed)', async () => {
    // Normal Claude Code flow: the session commits and pushes, the Stop hook runs after,
    // the poll comes later. The cached copy equals GitHub's, so it must not say "not pushed yet".
    const { t, clients, push, repoView } = await setupDocs();
    push('# v1 (invented)\n', t.clock.now - 60 * 60_000);
    await clients.syncDue();
    const pushedAt = t.clock.now + 60_000;
    t.clock.now = pushedAt + 30_000;
    push('# v2 same bytes\n', pushedAt);
    t.d.hooks.storeDocs('s-b6', 'DECISIONS.md', Buffer.from('# v2 same bytes\n'));
    t.clock.now += 16 * 60_000;
    await clients.syncDue();
    expect(await repoView()).toMatchObject({ content: '# v2 same bytes\n', docsOrigin: 'github' });
  });
});
