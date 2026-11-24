/**
 * Fourth independent verification of the login limiter and cross-site guard
 * (routes/auth.ts, http/auth.ts sameOrigin, http/common.ts body()).
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
  const raw = (body: string, headers: Record<string, string> = {}, path = '/api/auth/login') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const login = (password: string, headers: Record<string, string> = {}) =>
    raw(JSON.stringify({ username: USER.username, password }), headers).then((r) => r.status);
  return { t, base, raw, login };
}

/** In-process request with a chosen TCP peer address (as @hono/node-server passes it). */
function fromPeer(t: ReturnType<typeof makeApps>, ip: string, body: unknown, headers = {}) {
  return Promise.resolve(
    t.ui.fetch(
      new Request('http://heph.local/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      { incoming: { socket: { remoteAddress: ip } } },
    ),
  ).then((r) => r.status);
}

describe('verify4: per-peer keys (criterion 1)', () => {
  it('different peer addresses have independent budgets; headers do not matter', async () => {
    const t = makeApps();
    await t.setup();
    const bad = { username: USER.username, password: WRONG };
    for (let i = 0; i < MAX; i++) expect(await fromPeer(t, '10.0.0.1', bad)).toBe(401);
    expect(await fromPeer(t, '10.0.0.1', USER)).toBe(403);
    // Spoofed client-IP headers from the blocked peer do not help.
    expect(
      await fromPeer(t, '10.0.0.1', USER, {
        'x-forwarded-for': '10.9.9.9',
        'x-real-ip': '1.1.1.1',
      }),
    ).toBe(403);
    // Another peer is unaffected, even if it claims to be the blocked one.
    expect(await fromPeer(t, '10.0.0.2', USER, { 'x-forwarded-for': '10.0.0.1' })).toBe(200);
  });

  it('window starts at the first failure, not the last', async () => {
    const { t, login } = await startUi();
    expect(await login(WRONG)).toBe(401);
    t.clock.advance(WINDOW - 10);
    for (let i = 0; i < MAX - 1; i++) expect(await login(WRONG)).toBe(401);
    expect(await login(USER.password)).toBe(403);
    t.clock.advance(10); // first failure + WINDOW
    expect(await login(USER.password)).toBe(200);
  });

  it('mixed concurrent wrong/correct: wrong evaluations between resets never exceed MAX', async () => {
    const { login } = await startUi();
    // 40 wrong then 1 correct, all fired at once: queue order is arrival order, so
    // at most MAX wrong ones are evaluated before the block; the correct one is 403.
    const pending = Array.from({ length: 40 }, () => login(WRONG));
    pending.push(login(USER.password));
    const codes = await Promise.all(pending);
    expect(codes.filter((c) => c === 401).length, String(codes)).toBeLessThanOrEqual(MAX);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(1);
  });

  it('three concurrent rounds from one peer stay within MAX in total', async () => {
    const { login } = await startUi();
    let wrong = 0;
    for (let round = 0; round < 3; round++) {
      const codes = await Promise.all(Array.from({ length: 20 }, () => login(WRONG)));
      wrong += codes.filter((c) => c === 401).length;
    }
    expect(wrong).toBe(MAX);
  });
});

describe('verify4: correct logins (criterion 2)', () => {
  it('a correct login after MAX-1 concurrent failures still succeeds and resets', async () => {
    const { login } = await startUi();
    const codes = await Promise.all(Array.from({ length: MAX - 1 }, () => login(WRONG)));
    expect(codes).toEqual(Array(MAX - 1).fill(401));
    expect(await login(USER.password)).toBe(200);
    const after = await Promise.all(Array.from({ length: 10 }, () => login(WRONG)));
    expect(after.filter((c) => c === 401).length).toBe(MAX);
  });

  // The per-key queue is bounded (memory): attempts beyond it get 429 "in
  // progress", never the misleading 403 "failed logins"; the rest succeed.
  it('60 parallel correct logins: the queue bound answers 429, never 403', async () => {
    const { login } = await startUi();
    const codes = await Promise.all(Array.from({ length: 60 }, () => login(USER.password)));
    expect(codes.filter((c) => c === 200).length, String(codes)).toBeGreaterThanOrEqual(50);
    expect(
      codes.every((c) => c === 200 || c === 429),
      String(codes),
    ).toBe(true);
    expect(await login(USER.password)).toBe(200);
  }, 60_000);
});

describe('verify4: malformed requests (criterion 3)', () => {
  const structurallyInvalid: [string, unknown][] = [
    ['missing password', { username: 'admin' }],
    ['wrong types', { username: 1, password: 2 }],
    ['empty object', {}],
  ];

  it('content types that merely look like JSON are rejected or harmless', async () => {
    const { raw, login } = await startUi();
    const body = JSON.stringify({ username: USER.username, password: WRONG });
    for (const ct of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain;charset=UTF-8',
      'text/json',
    ]) {
      expect((await raw(body, { 'content-type': ct })).status, ct).toBe(400);
    }
    expect(await login(USER.password)).toBe(200);
  });

  it('structurally invalid logins get 400 even while the key is blocked', async () => {
    const { raw, login } = await startUi();
    for (let i = 0; i < MAX; i++) await login(WRONG);
    for (const [label, b] of structurallyInvalid) {
      expect((await raw(JSON.stringify(b))).status, label).toBe(400);
    }
  });

  it('structurally invalid logins get 400 and never count (not blocked)', async () => {
    const { raw, login } = await startUi();
    for (let i = 0; i < 4; i++) {
      for (const [label, b] of structurallyInvalid) {
        expect((await raw(JSON.stringify(b))).status, label).toBe(400);
      }
    }
    const codes: number[] = [];
    for (let i = 0; i < MAX + 1; i++) codes.push(await login(WRONG));
    expect(codes).toEqual([401, 401, 401, 401, 401, 403]);
  });

  it('200 concurrent malformed bodies do not block a parallel correct login', async () => {
    const { raw, login } = await startUi();
    const junk = Array.from({ length: 200 }, (_, i) =>
      raw(i % 2 ? '{"username":' : JSON.stringify({ username: 'admin' })).then((r) => r.status),
    );
    const ok = login(USER.password);
    const codes = await Promise.all(junk);
    expect(codes.every((c) => c === 400)).toBe(true);
    expect(await ok).toBe(200);
  });
});

describe('verify4: resource bounds and queue health (criterion 4)', () => {
  const bad = () => Promise.reject(new DomainError('unauthorized', 'nope'));
  const ok = () => Promise.resolve('ok');
  // biome-ignore lint/suspicious/noExplicitAny: inspecting private state
  const internals = (l: LoginLimiter) => l as any;

  it('a burst of 5000 concurrent attempts on one key settles fully and leaves no queue', async () => {
    const l = new LoginLimiter(3, 60_000, () => 0);
    const results = await Promise.allSettled(Array.from({ length: 5000 }, () => l.run('k', bad)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(internals(l).queued).toBe(0);
    expect(internals(l).failures.get('k').count).toBe(3);
  });

  it('queues of thousands of keys are cleaned up after they settle', async () => {
    const l = new LoginLimiter(3, 60_000, () => 0);
    await Promise.allSettled(
      Array.from({ length: 5000 }, (_, i) => l.run(`k${i % 2500}`, i % 3 ? bad : ok)),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(internals(l).queued).toBe(0);
  });

  it('failure map stays bounded with 30 000 unblocked keys', async () => {
    const l = new LoginLimiter(3, 60_000, () => 0);
    for (let i = 0; i < 30_000; i++) await l.run(`k${i}`, bad).catch(() => {});
    expect(internals(l).failures.size).toBeLessThanOrEqual(10_001);
  });

  it('expired entries are evicted first, before unblocked live ones', async () => {
    let now = 0;
    const l = new LoginLimiter(2, 100, () => now);
    for (let i = 0; i < 5000; i++) await l.run(`old${i}`, bad).catch(() => {});
    now = 200;
    for (let i = 0; i < 2; i++) await l.run('victim', bad).catch(() => {});
    for (let i = 0; i < 5001; i++) await l.run(`new${i}`, bad).catch(() => {});
    const f = internals(l).failures as Map<string, unknown>;
    expect(l.isBlocked('victim')).toBe(true);
    expect(f.has('old0')).toBe(false);
    expect(f.has('new0')).toBe(true);
  });

  it('a block survives a flood of other blocked and unblocked keys', async () => {
    const l = new LoginLimiter(2, 60_000, () => 0);
    for (let i = 0; i < 2; i++) await l.run('victim', bad).catch(() => {});
    for (let i = 0; i < 6000; i++) {
      await l.run(`b${i}`, bad).catch(() => {});
      await l.run(`b${i}`, bad).catch(() => {});
    }
    for (let i = 0; i < 6000; i++) await l.run(`u${i}`, bad).catch(() => {});
    expect(l.isBlocked('victim')).toBe(true);
  });

  it('non-auth errors (sync throw, async throw, non-Error rejection) do not poison the queue', async () => {
    const l = new LoginLimiter(3, 60_000, () => 0);
    const syncThrow = () => {
      throw new Error('boom');
    };
    const asyncThrow = async () => {
      throw new TypeError('kaboom');
    };
    const weird = async () => Promise.reject('string reason');
    const all = await Promise.allSettled([
      l.run('k', syncThrow as () => Promise<never>),
      l.run('k', asyncThrow),
      l.run('k', weird),
      l.run('k', ok),
    ]);
    expect(all.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'fulfilled']);
    expect(l.isBlocked('k')).toBe(false);
    for (let i = 0; i < 3; i++) await expect(l.run('k', bad)).rejects.toThrow('nope');
    expect(l.isBlocked('k')).toBe(true);
  });

  it('attempts are strictly serialized, also across keys (one global queue, D46)', async () => {
    const l = new LoginLimiter(100, 60_000, () => 0);
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return 'ok';
    };
    await Promise.all(Array.from({ length: 20 }, () => l.run('k', slow)));
    expect(peak).toBe(1);
    peak = 0;
    await Promise.all(Array.from({ length: 20 }, (_, i) => l.run(`k${i}`, slow)));
    // One queue for all clients keeps the global cap exact under concurrency.
    expect(peak).toBe(1);
  });

  it('later requests are still answered after a refused burst (real socket)', async () => {
    const { t, login } = await startUi();
    // 3 rounds of 100 (a single burst of 300 overflows the Windows listen backlog).
    let wrong = 0;
    for (let round = 0; round < 3; round++) {
      const codes = await Promise.all(Array.from({ length: 100 }, () => login(WRONG)));
      wrong += codes.filter((c) => c === 401).length;
    }
    expect(wrong).toBe(MAX);
    expect(await login(USER.password)).toBe(403);
    t.clock.advance(WINDOW);
    expect(await login(USER.password)).toBe(200);
  }, 60_000);
});

describe('verify4: cross-site guard (criterion 5)', () => {
  it('refuses foreign, null, malformed and port-mismatched origins on login and setup', async () => {
    const t = makeApps();
    const host = 'heph.local:8080';
    const bad = [
      'https://evil.example',
      'null',
      'not a url',
      'http://heph.local:9999',
      'http://heph.local',
      'http://heph.local:8080.evil.example',
    ];
    for (const origin of bad) {
      const r = await t.uiReq('POST', '/api/setup', { json: USER, headers: { origin, host } });
      expect(r.status, origin).toBe(403);
    }
    await t.setup();
    t.clearCookie();
    for (const origin of bad) {
      const r = await t.uiReq('POST', '/api/auth/login', { json: USER, headers: { origin, host } });
      expect(r.status, origin).toBe(403);
    }
    // None of those counted.
    for (let i = 0; i < 4; i++) {
      await t.uiReq('POST', '/api/auth/login', { json: { ...USER, password: WRONG } });
    }
    expect((await t.uiReq('POST', '/api/auth/login', { json: USER })).status).toBe(200);
  });

  it('cross-site wrong logins cannot lock the owner out (real socket)', async () => {
    const { login, base } = await startUi();
    const codes = await Promise.all(
      Array.from({ length: 50 }, () => login(WRONG, { origin: 'https://evil.example' })),
    );
    expect(codes.every((c) => c === 403)).toBe(true);
    expect(await login(USER.password, { origin: base })).toBe(200);
  });

  it('same-origin and Origin-less requests work; setup too', async () => {
    const t = makeApps();
    const r = await t.uiReq('POST', '/api/setup', {
      json: USER,
      headers: { host: 'heph.local', origin: 'http://heph.local' },
    });
    expect(r.status).toBe(201);
    t.clearCookie();
    expect(
      (
        await t.uiReq('POST', '/api/auth/login', {
          json: USER,
          headers: { host: 'heph.local', origin: 'http://heph.local' },
        })
      ).status,
    ).toBe(200);
    expect((await t.uiReq('POST', '/api/auth/login', { json: USER })).status).toBe(200);
  });

  it('honours X-Forwarded-Host exactly like the cookie-write guard', async () => {
    const t = makeApps();
    const proxied = { host: 'heph:8080', 'x-forwarded-host': 'heph.example.com' };
    const r = await t.uiReq('POST', '/api/setup', {
      json: USER,
      headers: { ...proxied, origin: 'https://heph.example.com' },
    });
    expect(r.status).toBe(201);
    // Cookie write with the same headers is accepted by the general guard.
    const w = await t.uiReq('POST', '/api/auth/logout', {
      headers: { ...proxied, origin: 'https://heph.example.com' },
    });
    expect(w.status).toBeLessThan(400);
    t.clearCookie();
    expect(
      (
        await t.uiReq('POST', '/api/auth/login', {
          json: USER,
          headers: { ...proxied, origin: 'https://heph.example.com' },
        })
      ).status,
    ).toBe(200);
    // Origin matching the inner Host but not the forwarded host is refused.
    expect(
      (
        await t.uiReq('POST', '/api/auth/login', {
          json: USER,
          headers: { ...proxied, origin: 'http://heph:8080' },
        })
      ).status,
    ).toBe(403);
  });

  it('non-JSON setup is 400 and does not create the user', async () => {
    const t = makeApps();
    const r = await t.ui.request('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify(USER),
    });
    expect(r.status).toBe(400);
    expect((await t.uiReq('GET', '/api/auth/status')).data.setupDone).toBe(false);
  });

  it('GET on login is not a bypass (no password is evaluated)', async () => {
    const t = makeApps();
    await t.setup();
    t.clearCookie();
    const r = await t.uiReq('GET', '/api/auth/login', {
      headers: { origin: 'https://evil.example' },
    });
    expect(r.status).not.toBe(200);
  });
});
