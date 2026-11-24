/**
 * Third independent verification of the login limiter (routes/auth.ts) over a
 * real TCP socket: sequential and concurrent attempts, reset on success, window
 * expiry, header independence, and malformed bodies.
 * The test app's limiter allows 5 failures per 60 s window on the test clock.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DomainError } from '@heph/core';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginLimiter } from './routes/auth.js';
import { makeApps, USER } from './test/app.js';

const MAX = 5;
const WINDOW = 60_000;
const WRONG = 'definitely wrong password';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0).reverse()) c();
});

async function startUi() {
  const t = makeApps();
  await t.setup();
  const server = serve({ fetch: t.ui.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => {
    server.closeAllConnections?.();
    server.close();
    t.cleanup();
  });
  const raw = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const login = (password: string, headers: Record<string, string> = {}) =>
    raw(JSON.stringify({ username: USER.username, password }), headers).then((r) => r.status);
  return { t, base, raw, login };
}

describe('verify3: sequential limiting', () => {
  it('exactly MAX failures are evaluated, then 403 even with the right password', async () => {
    const { login } = await startUi();
    const codes: number[] = [];
    for (let i = 0; i < MAX + 3; i++) codes.push(await login(WRONG));
    expect(codes).toEqual([401, 401, 401, 401, 401, 403, 403, 403]);
    expect(await login(USER.password)).toBe(403);
  });

  it('a correct login before the limit succeeds and resets the counter', async () => {
    const { login } = await startUi();
    for (let i = 0; i < MAX - 1; i++) expect(await login(WRONG)).toBe(401);
    expect(await login(USER.password)).toBe(200);
    // full budget again
    const codes: number[] = [];
    for (let i = 0; i < MAX + 1; i++) codes.push(await login(WRONG));
    expect(codes).toEqual([401, 401, 401, 401, 401, 403]);
  });

  it('the block lifts when the window expires, and a new window starts', async () => {
    const { t, login } = await startUi();
    for (let i = 0; i < MAX; i++) await login(WRONG);
    expect(await login(USER.password)).toBe(403);
    t.clock.advance(WINDOW - 1);
    expect(await login(USER.password)).toBe(403);
    t.clock.advance(1);
    // new window: MAX more failures, then blocked again
    const codes: number[] = [];
    for (let i = 0; i < MAX + 1; i++) codes.push(await login(WRONG));
    expect(codes).toEqual([401, 401, 401, 401, 401, 403]);
    t.clock.advance(WINDOW);
    expect(await login(USER.password)).toBe(200);
  });

  it('blocked attempts do not extend the window', async () => {
    const { t, login } = await startUi();
    for (let i = 0; i < MAX; i++) await login(WRONG);
    for (let i = 0; i < 20; i++) {
      t.clock.advance(2_000);
      expect(await login(WRONG)).toBe(403);
    }
    t.clock.advance(WINDOW - 40_000);
    expect(await login(USER.password)).toBe(200);
  });
});

describe('verify3: concurrent limiting', () => {
  it('100 parallel wrong logins evaluate at most MAX passwords', async () => {
    const { login } = await startUi();
    const codes = await Promise.all(Array.from({ length: 100 }, () => login(WRONG)));
    expect(codes.filter((c) => c === 401).length, String(codes)).toBe(MAX);
    // The rest are refused: 403 once blocked, or 429 beyond the per-key queue bound.
    expect(codes.filter((c) => c === 403 || c === 429).length).toBe(100 - MAX);
    expect(await login(USER.password)).toBe(403);
  });

  it('parallel wrong logins with rotating headers still share one bucket', async () => {
    const { login } = await startUi();
    const codes = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        login(WRONG, {
          'x-forwarded-for': `203.0.113.${i}`,
          'x-real-ip': `198.51.100.${i}`,
          forwarded: `for=192.0.2.${i}`,
          'user-agent': `ua-${i}`,
          connection: 'close',
        }),
      ),
    );
    expect(codes.filter((c) => c === 401).length, String(codes)).toBeLessThanOrEqual(MAX);
  });

  it('batches of parallel attempts after a partial budget stay within MAX in total', async () => {
    const { login } = await startUi();
    expect(await login(WRONG)).toBe(401);
    expect(await login(WRONG)).toBe(401);
    const codes = await Promise.all(Array.from({ length: 30 }, () => login(WRONG)));
    expect(codes.filter((c) => c === 401).length).toBe(MAX - 2);
  });

  it('parallel correct logins all succeed (no failure happened)', async () => {
    const { login } = await startUi();
    const codes = await Promise.all(Array.from({ length: 8 }, () => login(USER.password)));
    expect(codes, String(codes)).toEqual(Array(8).fill(200));
  });

  it('after parallel correct logins settle, the counter is reset', async () => {
    const { login } = await startUi();
    const codes = await Promise.all(Array.from({ length: 8 }, () => login(USER.password)));
    expect(codes, String(codes)).toEqual(Array(8).fill(200));
    // Counter is clean: a full budget of failures is available again.
    const after: number[] = [];
    for (let i = 0; i < MAX + 1; i++) after.push(await login(WRONG));
    expect(after).toEqual([401, 401, 401, 401, 401, 403]);
  });
});

describe('verify3: malformed bodies', () => {
  const malformed: [string, string, Record<string, string>?][] = [
    ['invalid JSON', '{"username":'],
    ['JSON array', '[]'],
    ['JSON string', '"admin"'],
    ['empty body', ''],
    ['missing password', JSON.stringify({ username: 'admin' })],
    ['wrong types', JSON.stringify({ username: 1, password: 2 })],
    [
      'text/plain',
      JSON.stringify({ username: 'admin', password: WRONG }),
      { 'content-type': 'text/plain' },
    ],
  ];

  it('each malformed body gets 400 (never 500 or 200)', async () => {
    const { t, raw } = await startUi();
    for (const [label, body, headers] of malformed) {
      t.clock.advance(WINDOW); // fresh window so each body is really evaluated
      const r = await raw(body, headers);
      expect(r.status, `${label}: ${r.text}`).toBe(400);
    }
  });

  it('malformed requests evaluate no password and do not lock the owner out', async () => {
    const { raw, login } = await startUi();
    const statuses: number[] = [];
    for (let i = 0; i < MAX * 4; i++) statuses.push((await raw('{"username":')).status);
    expect(
      statuses.every((s) => s === 400),
      String(statuses),
    ).toBe(true);
    expect(await login(USER.password)).toBe(200);
  });

  it('malformed requests interleaved with wrong passwords never reset the counter', async () => {
    const { raw, login } = await startUi();
    const logins: number[] = [];
    const malformed: number[] = [];
    for (let i = 0; i < 12; i++) {
      logins.push(await login(WRONG));
      malformed.push((await raw('not json')).status);
    }
    // Exactly MAX passwords were evaluated; malformed bodies are always 400.
    expect(logins).toEqual([...Array(MAX).fill(401), ...Array(12 - MAX).fill(403)]);
    expect(malformed.every((c) => c === 400)).toBe(true);
  });

  it('an unknown username costs budget like a wrong password', async () => {
    const { raw, login } = await startUi();
    for (let i = 0; i < MAX; i++) {
      expect((await raw(JSON.stringify({ username: `nobody${i}`, password: WRONG }))).status).toBe(
        401,
      );
    }
    expect(await login(USER.password)).toBe(403);
  });
});

describe('verify3: LoginLimiter unit', () => {
  const bad = () => Promise.reject(new DomainError('unauthorized', 'nope'));
  const ok = () => Promise.resolve('ok');

  it('fixed window per key, independent keys, success clears', async () => {
    let now = 1_000;
    const l = new LoginLimiter(3, 100, () => now);
    for (let i = 0; i < 3; i++) await expect(l.run('a', bad)).rejects.toThrow('nope');
    await expect(l.run('a', ok)).rejects.toThrow(/Too many/);
    await expect(l.run('b', ok)).resolves.toBe('ok');
    now += 99;
    expect(l.isBlocked('a')).toBe(true);
    now += 1;
    expect(l.isBlocked('a')).toBe(false);
    await expect(l.run('a', bad)).rejects.toThrow('nope');
    await expect(l.run('a', ok)).resolves.toBe('ok');
    for (let i = 0; i < 3; i++) await expect(l.run('a', bad)).rejects.toThrow('nope');
    expect(l.isBlocked('a')).toBe(true);
  });

  it('non-auth errors (e.g. validation) do not count as failures', async () => {
    const l = new LoginLimiter(2, 60_000, () => 0);
    const invalid = () => Promise.reject(new DomainError('validation', 'bad body'));
    for (let i = 0; i < 10; i++) await expect(l.run('k', invalid)).rejects.toThrow('bad body');
    expect(l.isBlocked('k')).toBe(false);
  });

  it('a blocked key survives more than 10 000 other keys (no global clear)', async () => {
    const l = new LoginLimiter(3, 60_000, () => 0);
    for (let i = 0; i < 3; i++) await expect(l.run('victim', bad)).rejects.toThrow();
    expect(l.isBlocked('victim')).toBe(true);
    for (let i = 0; i < 10_050; i++) await expect(l.run(`k${i}`, bad)).rejects.toThrow();
    expect(l.isBlocked('victim')).toBe(true);
  });
});
