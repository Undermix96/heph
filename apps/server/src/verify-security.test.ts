/** Independent checks of claims made in SECURITY.md. */
import { afterEach, describe, expect, it } from 'vitest';
import { makeApps, USER } from './test/app.js';

let t: ReturnType<typeof makeApps> | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const bad = { username: USER.username, password: 'wrong password!!' };

describe('verify: SECURITY.md claims', () => {
  it('failed logins from one address are rate-limited', async () => {
    t = makeApps();
    await t.setup();
    t.clearCookie();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await t.uiReq('POST', '/api/auth/login', { json: bad })).status);
    }
    expect(
      codes.slice(5).every((s) => s !== 401),
      String(codes),
    ).toBe(true);
  });

  // BUG (security claim): the limiter key is the first X-Forwarded-For value
  // (apps/server/src/routes/auth.ts clientKey), which the client controls; a
  // fresh spoofed value per request gets a fresh bucket, so "rate-limited per
  // client address" (SECURITY.md) can be bypassed. Cloudflare appends to an
  // existing X-Forwarded-For rather than replacing it.
  it('rotating a spoofed X-Forwarded-For does not bypass the limiter', async () => {
    t = makeApps();
    await t.setup();
    t.clearCookie();
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await t.uiReq('POST', '/api/auth/login', {
        json: bad,
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      codes.push(r.status);
    }
    expect(
      codes.slice(5).every((s) => s !== 401),
      String(codes),
    ).toBe(true);
  });

  it('session cookie is HttpOnly, SameSite=Lax, Secure only behind https', async () => {
    t = makeApps();
    await t.setup();
    t.clearCookie();
    const plain = await t.ui.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(USER),
    });
    const c1 = plain.headers.get('set-cookie') ?? '';
    expect(c1).toMatch(/HttpOnly/i);
    expect(c1).toMatch(/SameSite=Lax/i);
    expect(c1).not.toMatch(/Secure/i);
    const https = await t.ui.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify(USER),
    });
    expect(https.headers.get('set-cookie') ?? '').toMatch(/Secure/i);
  });

  it('cross-origin cookie writes are refused', async () => {
    t = makeApps();
    await t.setup();
    const r = await t.uiReq('POST', '/api/projects', {
      json: { name: 'X' },
      headers: { origin: 'https://evil.example', host: 'localhost' },
    });
    expect(r.status).toBe(403);
  });

  it('settings never return the GitHub token', async () => {
    t = makeApps();
    await t.setup();
    t.d.settings.update({ githubToken: 'not-a-real-token-value-xyz' }, { source: 'ui' });
    const r = await t.uiReq('GET', '/api/settings');
    expect(JSON.stringify(r.data)).not.toContain('not-a-real-token');
  });
});
