import { describe, expect, it } from 'vitest';
import { makeApps, USER } from '../test/app.js';
import { LoginLimiter } from './auth.js';

describe('setup wizard and login', () => {
  it('reports setup status and allows setup exactly once', async () => {
    const t = makeApps();
    expect((await t.uiReq('GET', '/api/auth/status')).data).toEqual({
      setupDone: false,
      user: null,
    });

    const r = await t.uiReq('POST', '/api/setup', { json: USER });
    expect(r.status).toBe(201);
    expect(r.data.apiToken).toMatch(/^heph_/);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect((await t.uiReq('GET', '/api/auth/status')).data.user.username).toBe('admin');

    const again = await t.uiReq('POST', '/api/setup', {
      json: { username: 'x', password: 'another-pass' },
    });
    expect(again.status).toBe(409);
  });

  it('validates setup input', async () => {
    const t = makeApps();
    const r = await t.uiReq('POST', '/api/setup', { json: { username: 'a', password: 'short' } });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('validation');
  });

  it('logs in and out with a session cookie', async () => {
    const t = makeApps();
    await t.setup();
    t.clearCookie();
    expect((await t.uiReq('GET', '/api/auth/me')).status).toBe(401);
    const bad = await t.uiReq('POST', '/api/auth/login', { json: { ...USER, password: 'nope' } });
    expect(bad.status).toBe(401);
    expect((await t.uiReq('POST', '/api/auth/login', { json: USER })).status).toBe(200);
    expect((await t.uiReq('GET', '/api/auth/me')).data).toMatchObject({
      user: { username: 'admin' },
      source: 'ui',
    });
    await t.uiReq('POST', '/api/auth/logout');
    expect((await t.uiReq('GET', '/api/auth/me')).status).toBe(401);
  });

  it('marks the cookie Secure only behind HTTPS', async () => {
    const t = makeApps();
    await t.setup();
    const plain = await t.uiReq('POST', '/api/auth/login', { json: USER });
    expect(plain.headers.get('set-cookie')).not.toMatch(/Secure/);
    const tls = await t.uiReq('POST', '/api/auth/login', {
      json: USER,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(tls.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('rate-limits repeated failed logins', async () => {
    const t = makeApps();
    await t.setup();
    for (let i = 0; i < 5; i++) {
      await t.uiReq('POST', '/api/auth/login', { json: { ...USER, password: 'bad-password' } });
    }
    expect((await t.uiReq('POST', '/api/auth/login', { json: USER })).status).toBe(403);
    t.clock.advance(61_000);
    expect((await t.uiReq('POST', '/api/auth/login', { json: USER })).status).toBe(200);
  });

  it('changes the password', async () => {
    const t = makeApps();
    await t.setup();
    const bad = await t.uiReq('POST', '/api/auth/password', {
      json: { currentPassword: 'wrong', newPassword: 'new-password-1' },
    });
    expect(bad.status).toBe(401);
    const ok = await t.uiReq('POST', '/api/auth/password', {
      json: { currentPassword: USER.password, newPassword: 'new-password-1' },
    });
    expect(ok.status).toBe(200);
    expect((await t.uiReq('GET', '/api/auth/me')).status).toBe(200);
    t.clearCookie();
    const relogin = await t.uiReq('POST', '/api/auth/login', {
      json: { ...USER, password: 'new-password-1' },
    });
    expect(relogin.status).toBe(200);
  });

  it('refuses cross-origin unsafe requests with a cookie', async () => {
    const t = makeApps();
    await t.setup();
    const r = await t.uiReq('PATCH', '/api/settings', {
      json: { contentLanguage: 'en' },
      headers: { origin: 'https://evil.example', host: 'heph.local' },
    });
    expect(r.status).toBe(403);
  });
});

describe('API token', () => {
  it('authenticates bearer requests and rotates', async () => {
    const t = makeApps();
    const token = await t.setup();
    expect((await t.tokenReq(token, 'GET', '/api/auth/me', {}, 'ui')).data.source).toBe(
      'claude_code',
    );
    expect((await t.tokenReq('heph_wrong', 'GET', '/api/settings', {}, 'ui')).status).toBe(401);

    expect((await t.uiReq('GET', '/api/settings/api-token')).data.apiToken).toBe(token);
    // Only the UI may see or rotate the token.
    expect((await t.tokenReq(token, 'GET', '/api/settings/api-token', {}, 'ui')).status).toBe(403);

    const rotated = await t.uiReq('POST', '/api/settings/api-token/rotate');
    expect(rotated.data.apiToken).not.toBe(token);
    expect((await t.tokenReq(token, 'GET', '/api/settings', {}, 'ui')).status).toBe(401);
  });

  it('agent port ignores cookies', async () => {
    const t = makeApps();
    await t.setup();
    const r = await t.agent.request('/api/projects', { headers: { cookie: t.getCookie() } });
    expect(r.status).toBe(401);
  });

  it('settings never echo the GitHub token', async () => {
    const t = makeApps();
    await t.setup();
    const r = await t.uiReq('PATCH', '/api/settings', {
      json: { githubToken: 'github_pat_secret' },
    });
    expect(r.status).toBe(200);
    expect(r.data.githubToken).toBe('***');
  });
});

describe('cross-site login protection', () => {
  it('refuses login and setup from another origin and non-JSON bodies', async () => {
    const t = makeApps();
    const foreign = { origin: 'https://evil.example', host: 'heph.local' };
    expect((await t.uiReq('POST', '/api/setup', { json: USER, headers: foreign })).status).toBe(
      403,
    );
    await t.setup();
    t.clearCookie();
    expect(
      (await t.uiReq('POST', '/api/auth/login', { json: USER, headers: foreign })).status,
    ).toBe(403);
    const plain = await t.ui.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(USER),
    });
    expect(plain.status).toBe(400);
    // Neither attempt counted against the owner.
    expect((await t.uiReq('POST', '/api/auth/login', { json: USER })).status).toBe(200);
  });
});

describe('LoginLimiter eviction', () => {
  it('stays fast with tens of thousands of blocked keys and keeps recent blocks', async () => {
    const { DomainError } = await import('@heph/core');
    const l = new LoginLimiter(1, 60_000, () => 0);
    const bad = () => Promise.reject(new DomainError('unauthorized', 'nope'));
    const started = Date.now();
    for (let i = 0; i < 30_000; i++) await l.run(`k${i}`, bad).catch(() => undefined);
    // Amortized eviction: the old quadratic scan took tens of seconds here.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(l.isBlocked('k29999')).toBe(true);
    expect(l.isBlocked('k0')).toBe(false);
  }, 30_000);
});
