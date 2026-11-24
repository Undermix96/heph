/**
 * Sixth independent verification of the login limiter (routes/auth.ts LoginLimiter,
 * defaultLoginLimiter, POST /auth/login) against the PRODUCTION configuration
 * (createUiApp without an injected limiter: 10 per client, 100 global, 15 minutes).
 * Client keys are simulated through the node-server env (`incoming.socket.remoteAddress`),
 * exactly what the route reads; Date is faked so the production clock (Date.now) can move.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DomainError } from '@heph/core';
import { makeDomain } from '@heph/core/testing';
import { serve } from '@hono/node-server';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUiApp } from './app.js';
import { defaultLoginLimiter, LoginLimiter } from './routes/auth.js';
import { USER } from './test/app.js';

const PER_KEY = 10;
const GLOBAL = 100;
const WINDOW = 15 * 60_000;
const QUEUE = 50;
const WRONG = 'definitely wrong password';

const closers: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
});
afterEach(() => {
  for (const c of closers.splice(0).reverse()) c();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
// biome-ignore lint/suspicious/noExplicitAny: inspecting private state
const internals = (l: LoginLimiter) => l as any;

/** Production UI app (no limiter injected), set up, with an evaluation counter. */
async function prodApp() {
  const t = makeDomain();
  const ui = createUiApp({ domain: t.d, log: pino({ level: 'silent' }), webDir: null });
  closers.push(() => t.cleanup());
  const setup = await ui.request(
    '/api/setup',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(USER) },
    { incoming: { socket: { remoteAddress: '10.9.9.9' } } },
  );
  expect(setup.status).toBe(201);
  const original = t.d.auth.login.bind(t.d.auth);
  let evaluations = 0;
  let gate: Promise<void> | null = null;
  let failNext: unknown = null;
  t.d.auth.login = (async (...args: Parameters<typeof original>) => {
    if (gate) await gate;
    if (failNext !== null) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    evaluations++;
    return original(...args);
  }) as typeof t.d.auth.login;
  const raw = (b: string, ip: string, headers: Record<string, string> = {}) =>
    ui.request(
      '/api/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b },
      { incoming: { socket: { remoteAddress: ip } } },
    );
  const login = async (password: string, ip: string) => {
    const r = await raw(JSON.stringify({ username: USER.username, password }), ip);
    const text = await r.text();
    return { status: r.status, code: text ? (JSON.parse(text).error?.code as string) : undefined };
  };
  let release = () => {};
  return {
    t,
    ui,
    raw,
    login,
    evaluations: () => evaluations,
    hold() {
      gate = new Promise<void>((r) => {
        release = () => {
          gate = null;
          r();
        };
      });
    },
    release: () => release(),
    failNextWith(e: unknown) {
      failNext = e;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('verify6: production wiring (criterion 5)', () => {
  it('defaultLoginLimiter is 10 per key, 15 minutes, 100 global on Date.now', () => {
    const l = internals(defaultLoginLimiter());
    expect(l.max).toBe(PER_KEY);
    expect(l.windowMs).toBe(WINDOW);
    expect(l.globalMax).toBe(GLOBAL);
    expect(l.now).toBe(Date.now);
  });

  it('two production apps get independent limiters (a fresh one per createUiApp)', async () => {
    const a = await prodApp();
    for (let i = 0; i < PER_KEY; i++) expect((await a.login(WRONG, '1.1.1.1')).status).toBe(401);
    expect((await a.login(USER.password, '1.1.1.1')).status).toBe(403);
    const b = await prodApp();
    expect((await b.login(USER.password, '1.1.1.1')).status).toBe(200);
  });
});

describe('verify6: per-key limit in production (criteria 1, 2)', () => {
  it('10 wrong then 403 even for the right password; other keys unaffected; window end restores', async () => {
    const p = await prodApp();
    for (let i = 0; i < PER_KEY; i++) expect((await p.login(WRONG, '1.1.1.1')).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await p.login(WRONG, '1.1.1.1')).status).toBe(403);
    expect((await p.login(USER.password, '1.1.1.1')).status).toBe(403);
    expect(p.evaluations()).toBe(PER_KEY);
    expect((await p.login(USER.password, '2.2.2.2')).status).toBe(200);
    advance(WINDOW - 1);
    expect((await p.login(USER.password, '1.1.1.1')).status).toBe(403);
    advance(1);
    expect((await p.login(USER.password, '1.1.1.1')).status).toBe(200);
  }, 60_000);

  it('concurrent: 50 parallel wrong attempts from one key evaluate exactly 10', async () => {
    const p = await prodApp();
    p.hold();
    const all = Array.from({ length: QUEUE }, () => p.login(WRONG, '1.1.1.1'));
    await tick();
    p.release();
    const statuses = (await Promise.all(all)).map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(PER_KEY);
    expect(statuses.filter((s) => s === 403)).toHaveLength(QUEUE - PER_KEY);
    expect(p.evaluations()).toBe(PER_KEY);
  }, 60_000);
});

describe('verify6: global cap in production (criteria 1, 2)', () => {
  it('sequential: 100 keys x 1 failure, then every key (fresh too) gets 403 until the window ends', async () => {
    const p = await prodApp();
    for (let i = 0; i < GLOBAL; i++) expect((await p.login(WRONG, `10.0.0.${i}`)).status).toBe(401);
    expect(p.evaluations()).toBe(GLOBAL);
    for (let i = 0; i < 50; i++) {
      expect((await p.login(WRONG, `fd00::${i.toString(16)}`)).status).toBe(403);
    }
    expect((await p.login(USER.password, '192.168.1.1')).status).toBe(403);
    expect(p.evaluations()).toBe(GLOBAL);
    advance(WINDOW - 1);
    expect((await p.login(USER.password, '192.168.1.1')).status).toBe(403);
    advance(1);
    expect((await p.login(USER.password, '192.168.1.1')).status).toBe(200);
    // Keys that failed once in the old window are fine again too.
    expect((await p.login(USER.password, '10.0.0.0')).status).toBe(200);
  }, 120_000);

  it('global window is anchored at the first failure, not extended by blocked attempts', async () => {
    const p = await prodApp();
    expect((await p.login(WRONG, 'a')).status).toBe(401);
    advance(WINDOW / 2);
    for (let i = 1; i < GLOBAL; i++) expect((await p.login(WRONG, `k${i}`)).status).toBe(401);
    for (let i = 0; i < 20; i++) expect((await p.login(WRONG, `z${i}`)).status).toBe(403);
    advance(WINDOW / 2 - 1);
    expect((await p.login(USER.password, 'fresh')).status).toBe(403);
    advance(1);
    expect((await p.login(USER.password, 'fresh')).status).toBe(200);
  }, 120_000);

  it('concurrent bursts from thousands of distinct keys evaluate at most 100 per window', async () => {
    const p = await prodApp();
    let n = 0;
    const counts: Record<number, number> = {};
    for (let round = 0; round < 6; round++) {
      p.hold();
      const burst = Array.from({ length: 500 }, () =>
        p.login(WRONG, `2001:db8::${(n++).toString(16)}`),
      );
      await tick();
      p.release();
      for (const r of await Promise.all(burst)) counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    expect(p.evaluations()).toBe(GLOBAL);
    expect(counts[401]).toBe(GLOBAL);
    expect(Object.keys(counts).sort()).toEqual(['401', '403', '429']);
    expect((await p.login(USER.password, 'owner')).status).toBe(403);
    advance(WINDOW);
    expect((await p.login(USER.password, 'owner')).status).toBe(200);
  }, 120_000);

  it('a correct login does not reset the global count', async () => {
    const p = await prodApp();
    for (let i = 0; i < GLOBAL - 1; i++) expect((await p.login(WRONG, `k${i}`)).status).toBe(401);
    expect((await p.login(USER.password, 'k0')).status).toBe(200);
    expect((await p.login(WRONG, 'k0')).status).toBe(401);
    expect((await p.login(WRONG, 'k1')).status).toBe(403);
    expect(p.evaluations()).toBe(GLOBAL + 1); // 100 wrong + 1 right
  }, 120_000);
});

describe('verify6: > 10 000 keys with production limiter (criterion 1, unit)', () => {
  it('30 000 distinct keys over 300 windows: <= 100 failures per window, <= 10 per key, map bounded', async () => {
    const l = defaultLoginLimiter();
    const bad = () => Promise.reject(new DomainError('unauthorized', 'nope'));
    let key = 0;
    let maxSize = 0;
    for (let w = 0; w < 300; w++) {
      let evaluated = 0;
      const perKey = new Map<string, number>();
      const attempts: Promise<unknown>[] = [];
      // 150 new keys plus 20 tries from 5 recycled old keys (possibly evicted).
      const keys = [
        ...Array.from({ length: 150 }, () => `k${key++}`),
        ...Array.from({ length: 20 }, (_, i) => `k${(w * 7 + (i % 5)) % Math.max(1, key)}`),
      ];
      for (const k of keys) {
        attempts.push(
          l
            .run(k, () => {
              evaluated++;
              perKey.set(k, (perKey.get(k) ?? 0) + 1);
              return bad();
            })
            .catch(() => undefined),
        );
        if (attempts.length % 40 === 0) await Promise.all(attempts);
      }
      await Promise.all(attempts);
      expect(evaluated).toBeLessThanOrEqual(GLOBAL);
      for (const c of perKey.values()) expect(c).toBeLessThanOrEqual(PER_KEY);
      maxSize = Math.max(maxSize, internals(l).failures.size);
      advance(WINDOW);
    }
    expect(key).toBeGreaterThan(10_000 * 2);
    expect(maxSize).toBeLessThanOrEqual(10_001);
    expect(internals(l).queued).toBe(0);
  }, 120_000);
});

describe('verify6: bodies and queue (criterion 3)', () => {
  it('invalid bodies are 400 and never call run, also while globally blocked', async () => {
    const p = await prodApp();
    for (let i = 0; i < GLOBAL; i++) await p.login(WRONG, `k${i}`);
    // The production limiter is not exposed; spy on the prototype instead.
    const spy = vi.spyOn(LoginLimiter.prototype, 'run');
    for (const b of [
      '{',
      'null',
      '[]',
      '{"username":"admin"}',
      '{"username":"admin","password":""}',
    ]) {
      const r = await p.raw(b, 'x');
      expect(r.status, b).toBe(400);
    }
    expect((await p.raw(JSON.stringify(USER), 'x', { 'content-type': 'text/plain' })).status).toBe(
      400,
    );
    expect(spy).not.toHaveBeenCalled();
  }, 120_000);

  it('at most 50 wait; the rest are 429 rate_limited and count as nothing', async () => {
    const p = await prodApp();
    p.hold();
    const all = Array.from({ length: 120 }, (_, i) => p.login(WRONG, `q${i}`));
    await tick();
    p.release();
    const res = await Promise.all(all);
    const limited = res.filter((r) => r.status === 429);
    expect(limited).toHaveLength(120 - QUEUE);
    for (const r of limited) expect(r.code).toBe('rate_limited');
    expect(res.filter((r) => r.status === 401)).toHaveLength(QUEUE);
    expect(p.evaluations()).toBe(QUEUE);
    // 50 more failures allowed exactly: the 429s did not count globally.
    for (let i = 0; i < GLOBAL - QUEUE; i++)
      expect((await p.login(WRONG, `r${i}`)).status).toBe(401);
    expect((await p.login(WRONG, 'r-last')).status).toBe(403);
  }, 120_000);
});

describe('verify6: queue robustness (criterion 4)', () => {
  const nasty: [string, () => unknown][] = [
    ['Error', () => Promise.reject(new Error('boom'))],
    [
      'sync throw',
      () => {
        throw new TypeError('sync');
      },
    ],
    ['null', () => Promise.reject(null)],
    ['undefined', () => Promise.reject(undefined)],
    ['string', () => Promise.reject('str')],
    ['other DomainError', () => Promise.reject(new DomainError('validation', 'x'))],
    [
      'instanceof trap',
      () =>
        Promise.reject(
          new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error('trap');
              },
            },
          ),
        ),
    ],
    ['non-promise value', () => 42],
    [
      'thenable rejecting',
      // biome-ignore lint/suspicious/noThenProperty: deliberately a thenable
      () => ({ then: (_: unknown, rej: (e: unknown) => void) => rej(new Error('t')) }),
    ],
  ];

  it('no kind of error inside an attempt poisons the queue or counts as a failure', async () => {
    const l = defaultLoginLimiter();
    for (const [label, fn] of nasty) {
      const r = await l.run('k', fn as () => Promise<unknown>).then(
        () => 'ok',
        () => 'err',
      );
      expect(r, label).toBeTypeOf('string');
    }
    // Interleaved concurrently as well.
    await Promise.allSettled(nasty.map(([, fn]) => l.run('k', fn as () => Promise<unknown>)));
    expect(await l.run('k', async () => 'fine')).toBe('fine');
    await tick(); // the counter is released a few microtasks after settling
    expect(internals(l).queued).toBe(0);
    expect(internals(l).global.count).toBe(0);
  });

  it('HTTP: an unexpected domain error is a 500 and the next logins still work', async () => {
    const p = await prodApp();
    p.failNextWith(new Error('db down'));
    expect((await p.login(USER.password, 'a')).status).toBe(500);
    p.failNextWith(Object.assign(new Error('weird'), { status: 999 }));
    expect((await p.login(USER.password, 'a')).status).toBe(500);
    expect((await p.login(USER.password, 'a')).status).toBe(200);
  }, 60_000);

  it('burst of 5 000 concurrent HTTP attempts: all answered, queue drains, later logins work', async () => {
    const p = await prodApp();
    p.hold();
    const all = Array.from({ length: 5000 }, (_, i) =>
      p.login(i % 2 ? WRONG : USER.password, `b${i}`),
    );
    await tick();
    p.release();
    const res = await Promise.all(all);
    expect(res).toHaveLength(5000);
    expect(res.filter((r) => r.status === 429)).toHaveLength(5000 - QUEUE);
    expect(p.evaluations()).toBe(QUEUE);
    expect((await p.login(USER.password, 'after')).status).toBe(200);
  }, 120_000);

  it('real socket: 150 concurrent requests are all answered and the owner logs in afterwards', async () => {
    const p = await prodApp();
    const server = serve({ fetch: p.ui.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
    await new Promise<void>((r) => server.once('listening', () => r()));
    closers.push(() => {
      server.closeAllConnections?.();
      server.close();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (password: string) =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USER.username, password }),
      }).then(async (r) => {
        await r.text();
        return r.status;
      });
    const statuses = await Promise.all(Array.from({ length: 150 }, () => post(WRONG)));
    expect(new Set(statuses)).toEqual(new Set(statuses.filter((s) => [401, 403, 429].includes(s))));
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(PER_KEY);
    expect(p.evaluations()).toBeLessThanOrEqual(PER_KEY);
    expect(await post(USER.password)).toBe(403); // one peer, blocked
    advance(WINDOW);
    expect(await post(USER.password)).toBe(200);
  }, 120_000);
});
