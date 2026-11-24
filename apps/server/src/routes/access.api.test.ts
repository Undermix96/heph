import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Every REST API route, with placeholder ids. */
const ROUTES: [string, string][] = [
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['GET', '/api/projects/p'],
  ['PATCH', '/api/projects/p'],
  ['DELETE', '/api/projects/p'],
  ['POST', '/api/projects/p/status'],
  ['POST', '/api/projects/p/test-outcome'],
  ['GET', '/api/projects/p/next-task'],
  ['PUT', '/api/projects/p/next-task'],
  ['POST', '/api/projects/p/repos'],
  ['PATCH', '/api/repos/1'],
  ['DELETE', '/api/repos/1'],
  ['GET', '/api/tags'],
  ['GET', '/api/projects/p/phases'],
  ['POST', '/api/projects/p/phases'],
  ['PATCH', '/api/phases/1'],
  ['POST', '/api/phases/1/move'],
  ['DELETE', '/api/phases/1'],
  ['POST', '/api/phases/1/tasks'],
  ['GET', '/api/tasks/1'],
  ['PATCH', '/api/tasks/1'],
  ['POST', '/api/tasks/1/move'],
  ['POST', '/api/tasks/1/complete'],
  ['POST', '/api/tasks/1/reopen'],
  ['DELETE', '/api/tasks/1'],
  ['GET', '/api/diary'],
  ['GET', '/api/diary/sessions/s'],
  ['GET', '/api/diary/1'],
  ['GET', '/api/projects/p/diary'],
  ['POST', '/api/projects/p/diary'],
  ['GET', '/api/projects/p/materials'],
  ['POST', '/api/projects/p/materials'],
  ['PATCH', '/api/materials/1'],
  ['DELETE', '/api/materials/1'],
  ['GET', '/api/projects/p/files'],
  ['POST', '/api/projects/p/files'],
  ['POST', '/api/projects/p/upload-requests'],
  ['GET', '/api/files/1'],
  ['GET', '/api/files/1/content'],
  ['GET', '/api/files/1/thumbnail'],
  ['PATCH', '/api/files/1'],
  ['DELETE', '/api/files/1'],
  ['GET', '/api/proposals'],
  ['GET', '/api/projects/p/proposals'],
  ['GET', '/api/proposals/1'],
  ['POST', '/api/proposals/1/approve'],
  ['POST', '/api/proposals/1/reject'],
  ['GET', '/api/needs-attention'],
  ['GET', '/api/search?q=x'],
  ['GET', '/api/settings'],
  ['PATCH', '/api/settings'],
];

describe('API authentication', () => {
  it('rejects every route without credentials on both ports', async () => {
    t = await startApi();
    t.clearCookie();
    for (const [method, path] of ROUTES) {
      for (const app of [t.ui, t.agent]) {
        const res = await app.request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
      }
    }
  });

  it('rejects an invalid bearer token on both ports', async () => {
    t = await startApi();
    for (const app of ['ui', 'agent'] as const) {
      const r = await t.tokenReq('heph_wrong', 'GET', '/api/projects', {}, app);
      expect(r.status).toBe(401);
      expect(r.data.error.code).toBe('unauthorized');
    }
  });

  it('an invalid bearer token is not rescued by a valid cookie', async () => {
    t = await startApi();
    const r = await t.uiReq('GET', '/api/projects', {
      headers: { authorization: 'Bearer heph_wrong' },
    });
    expect(r.status).toBe(401);
  });

  it('the agent port ignores the session cookie but accepts the bearer token', async () => {
    t = await startApi();
    const res = await t.agent.request('/api/projects', { headers: { cookie: t.getCookie() } });
    expect(res.status).toBe(401);
    const ok = await t.agentReq('GET', '/api/projects');
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual([]);
  });

  it('the UI port accepts both the cookie and the bearer token', async () => {
    t = await startApi();
    expect((await t.uiReq('GET', '/api/projects')).status).toBe(200);
    expect((await t.agentReq('GET', '/api/projects', {}, 'ui')).status).toBe(200);
    const me = await t.agentReq('GET', '/api/auth/me', {}, 'ui');
    expect(me.data.source).toBe('claude_code');
  });

  it('logging out invalidates the cookie for API calls', async () => {
    t = await startApi();
    const cookie = t.getCookie();
    await t.uiReq('POST', '/api/auth/logout');
    const res = await t.ui.request('/api/projects', { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it('refuses cross-origin cookie writes but allows same-origin ones', async () => {
    t = await startApi();
    const evil = await t.uiReq('POST', '/api/projects', {
      json: { name: 'X' },
      headers: { origin: 'https://evil.example', host: 'heph.example' },
    });
    expect(evil.status).toBe(403);
    expect(evil.data.error.code).toBe('forbidden');
    const same = await t.uiReq('POST', '/api/projects', {
      json: { name: 'X' },
      headers: { origin: 'https://heph.example', host: 'heph.example' },
    });
    expect(same.status).toBe(201);
    // Reads are never origin-checked; bearer writes are not either.
    expect(
      (await t.uiReq('GET', '/api/projects', { headers: { origin: 'https://evil.example' } }))
        .status,
    ).toBe(200);
    expect(
      (
        await t.agentReq(
          'POST',
          '/api/projects',
          { json: { name: 'Y' }, headers: { origin: 'https://evil.example' } },
          'ui',
        )
      ).status,
    ).toBe(201);
  });

  it('a rotated token stops working', async () => {
    t = await startApi();
    const old = t.token;
    const rot = await t.uiReq('POST', '/api/settings/api-token/rotate');
    expect(rot.status).toBe(200);
    expect((await t.tokenReq(old, 'GET', '/api/projects')).status).toBe(401);
    expect((await t.tokenReq(rot.data.apiToken, 'GET', '/api/projects')).status).toBe(200);
  });

  it('unknown API paths are JSON 404 on both ports', async () => {
    t = await startApi();
    const a = await t.uiReq('GET', '/api/nope');
    expect(a.status).toBe(404);
    expect(a.data.error.code).toBe('not_found');
    const b = await t.agentReq('GET', '/api/nope');
    expect(b.status).toBe(404);
    expect(b.data.error.code).toBe('not_found');
  });
});

describe('UI-only routes', () => {
  it('refuses the token with 403 on DELETE project, proposal decisions and settings', async () => {
    t = await startApi();
    const p = await t.seed();
    const prop = await t.agentReq('POST', `/api/projects/${p.slug}/status`, {
      json: { status: 'abandoned' },
    });
    expect(prop.status).toBe(202);
    const id = prop.data.proposal.id;
    for (const app of ['ui', 'agent'] as const) {
      const del = await t.agentReq('DELETE', `/api/projects/${p.slug}`, {}, app);
      expect(del.status).toBe(403);
      expect(del.data.error.code).toBe('forbidden');
      // Even when the agent claims user confirmation.
      const delConfirmed = await t.agentReq(
        'DELETE',
        `/api/projects/${p.slug}`,
        { headers: { 'x-heph-confirmed': 'true' } },
        app,
      );
      expect(delConfirmed.status).toBe(403);
      expect((await t.agentReq('POST', `/api/proposals/${id}/approve`, {}, app)).status).toBe(403);
      expect((await t.agentReq('POST', `/api/proposals/${id}/reject`, {}, app)).status).toBe(403);
      // Settings live on the UI port only; the agent port has no such route.
      expect(
        (await t.agentReq('PATCH', '/api/settings', { json: { maxUploadMb: 1 } }, app)).status,
      ).toBe(app === 'ui' ? 403 : 404);
    }
    // Nothing changed.
    expect((await t.uiReq('GET', `/api/projects/${p.slug}`)).status).toBe(200);
    expect((await t.uiReq('GET', `/api/proposals/${id}`)).data.state).toBe('pending');
    expect((await t.uiReq('GET', '/api/settings')).data.maxUploadMb).toBe(100);
  });

  it('settings are readable with the token, never echoing the GitHub token', async () => {
    t = await startApi();
    const patched = await t.uiReq('PATCH', '/api/settings', {
      json: { githubToken: 'ghp_secret', currency: 'usd' },
    });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ githubToken: '***', currency: 'USD' });
    const r = await t.agentReq('GET', '/api/settings', {}, 'ui');
    expect(r.status).toBe(200);
    expect(r.data.githubToken).toBe('***');
    expect(JSON.stringify(r.data)).not.toContain('ghp_secret');
  });

  it('validates settings patches', async () => {
    t = await startApi();
    const r = await t.uiReq('PATCH', '/api/settings', {
      json: { recentlyActiveDays: 40, inactiveDays: 30 },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('validation');
    const r2 = await t.uiReq('PATCH', '/api/settings', { json: { recentlyActiveDays: 31 } });
    expect(r2.status).toBe(400);
    expect((await t.uiReq('PATCH', '/api/settings', { json: { maxUploadMb: 0 } })).status).toBe(
      400,
    );
  });
});

describe('request parsing', () => {
  it('answers 400 validation to a malformed JSON body', async () => {
    t = await startApi();
    const p = await t.seed();
    for (const [method, path] of [
      ['POST', '/api/projects'],
      ['PATCH', `/api/projects/${p.slug}`],
      ['POST', `/api/projects/${p.slug}/diary`],
      ['POST', `/api/projects/${p.slug}/status`],
    ] as const) {
      const r = await t.uiReq(method, path, {
        body: '{"name": ',
        headers: { 'content-type': 'application/json' },
      });
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(r.data.error.code).toBe('validation');
      const a = await t.agentReq(method, path, {
        body: '{oops}',
        headers: { 'content-type': 'application/json' },
      });
      expect(a.status, `agent ${method} ${path}`).toBe(400);
    }
  });

  it('treats an empty body as {} and validates it', async () => {
    t = await startApi();
    const r = await t.uiReq('POST', '/api/projects');
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('validation');
    expect(r.data.error.details).toBeInstanceOf(Array);
  });

  it('rejects non-numeric ids with 400 and unknown ids with 404', async () => {
    t = await startApi();
    for (const path of ['/api/tasks/abc', '/api/files/1.5', '/api/diary/-1', '/api/proposals/x']) {
      const r = await t.uiReq('GET', path);
      expect(r.status, path).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
    for (const path of [
      '/api/tasks/999',
      '/api/files/999',
      '/api/diary/999',
      '/api/proposals/999',
      '/api/projects/999',
      '/api/projects/nope',
    ]) {
      const r = await t.uiReq('GET', path);
      expect(r.status, path).toBe(404);
      expect(r.data.error.code).toBe('not_found');
    }
  });

  it('answers 400 to a JSON null body on PUT next-task', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await t.uiReq('PUT', `/api/projects/${p.slug}/next-task`, { json: null });
    expect(r.status).toBe(400);
  });

  it('answers 400 (or applies) on DELETE task with a JSON null body', async () => {
    t = await startApi();
    const p = await t.seed();
    const taskId = p.phases[0].tasks[0].id;
    const r = await t.uiReq('DELETE', `/api/tasks/${taskId}`, {
      body: 'null',
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBeLessThan(500);
  });
});
