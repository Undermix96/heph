/**
 * Fifth independent verification of the login limiter (routes/auth.ts LoginLimiter,
 * POST /auth/login), the rate_limited code (http/common.ts, core errors.ts).
 * The test app's limiter allows 5 failures per 60 s window on the test clock.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DomainError } from '@heph/core';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultLoginLimiter, LoginLimiter } from './routes/auth.js';
import { makeApps, USER } from './test/app.js';

const MAX = 5;
const WINDOW = 60_000;
const WRONG = 'definitely wrong password';
const CAP = 10_000;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0).reverse()) c();
  vi.restoreAllMocks();
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

/** Holds every domain login until release() (test-only patch of the domain instance). */
function gateLogins(t: ReturnType<typeof makeApps>) {
  const original = t.d.auth.login.bind(t.d.auth);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered = 0;
  t.d.auth.login = (async (...args: Parameters<typeof original>) => {
    entered++;
    await gate;
    return original(...args);
  }) as typeof t.d.auth.login;
  return {
    release,
    entered: () => entered,
    restore: () => {
      t.d.auth.login = original;
    },
  };
}

const bad = () => Promise.reject(new DomainError('unauthorized', 'nope'));
// biome-ignore lint/suspicious/noExplicitAny: inspecting private state
const internals = (l: LoginLimiter) => l as any;
const failures = (l: LoginLimiter) => internals(l).failures as Map<string, { count: number }>;
const tick = () => new Promise((r) => setTimeout(r, 0));

const invalidBodies: [string, string][] = [
  ['malformed JSON', '{"username":'],
  ['JSON array', JSON.stringify([USER.username, USER.password])],
  ['JSON null', 'null'],
  ['JSON string', '"admin"'],
  ['JSON number', '42'],
  ['empty body', ''],
  ['whitespace body', '   '],
  ['missing password', JSON.stringify({ username: USER.username })],
  ['missing username', JSON.stringify({ password: USER.password })],
  ['empty username', JSON.stringify({ username: '', password: USER.password })],
  ['empty password', JSON.stringify({ username: USER.username, password: '' })],
  ['username too long', JSON.stringify({ username: 'a'.repeat(65), password: WRONG })],
  ['password too long', JSON.stringify({ username: USER.username, password: 'x'.repeat(1025) })],
  ['non-string password', JSON.stringify({ username: USER.username, password: 123 })],
  ['object password', JSON.stringify({ username: USER.username, password: { $ne: '' } })],
  ['array username', JSON.stringify({ username: [USER.username], password: WRONG })],
];

describe('verify5: invalid bodies never reach the limiter (criterion 1)', () => {
  it('every invalid body is 400 with code validation, and limiter.run is never called', async () => {
    const { t, raw } = await startUi();
    const spy = vi.spyOn(t.limiter, 'run');
    for (const [label, b] of invalidBodies) {
      const r = await raw(b);
      expect(r.status, label).toBe(400);
      expect(JSON.parse(r.text).error.code, label).toBe('validation');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('while blocked: invalid bodies are 400 (not 403) and do not touch the limiter', async () => {
    const { t, raw, login } = await startUi();
    for (let i = 0; i < MAX; i++) expect(await login(WRONG)).toBe(401);
    expect(await login(USER.password)).toBe(403);
    const spy = vi.spyOn(t.limiter, 'run');
    for (const [label, b] of invalidBodies) expect((await raw(b)).status, label).toBe(400);
    // non-JSON content type too
    expect((await raw(JSON.stringify(USER), { 'content-type': 'text/plain' })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    // The block is untouched (not extended, not cleared).
    t.clock.advance(WINDOW - 1);
    expect(await login(USER.password)).toBe(403);
    t.clock.advance(1);
    expect(await login(USER.password)).toBe(200);
  });

  it('while the queue is full: invalid bodies are 400, not 429', async () => {
    const { t, raw, login } = await startUi();
    const g = gateLogins(t);
    const held = Array.from({ length: 50 }, () => login(USER.password));
    await vi.waitFor(() => expect(g.entered()).toBe(1), { timeout: 10_000 });
    // queue is now 50 deep (1 running + 49 waiting): a valid attempt is refused ...
    await vi.waitFor(
      async () => {
        expect(internals(t.limiter).queued).toBe(50);
      },
      { timeout: 10_000 },
    );
    expect(await login(USER.password)).toBe(429);
    // ... but invalid ones are still plain 400.
    for (const [label, b] of invalidBodies.slice(0, 6))
      expect((await raw(b)).status, label).toBe(400);
    g.release();
    const codes = await Promise.all(held);
    expect(codes.every((c) => c === 200)).toBe(true);
  }, 60_000);
});

describe('verify5: per-key budget (criterion 2)', () => {
  it('500 concurrent wrong attempts on one key evaluate the password exactly max times', async () => {
    const l = new LoginLimiter(3, 60_000, () => 0);
    let evaluated = 0;
    const attempt = async () => {
      evaluated++;
      await tick();
      throw new DomainError('unauthorized', 'nope');
    };
    const res = await Promise.allSettled(Array.from({ length: 500 }, () => l.run('k', attempt)));
    expect(evaluated).toBe(3);
    const codes = res.map((r) => (r.status === 'rejected' ? (r.reason as DomainError).code : 'ok'));
    expect(codes.filter((c) => c === 'unauthorized').length).toBe(3);
    // 50 were queued (3 evaluated, 47 forbidden); 450 overflowed the queue.
    expect(codes.filter((c) => c === 'forbidden').length).toBe(47);
    expect(codes.filter((c) => c === 'rate_limited').length).toBe(450);
  });

  it('real socket: concurrent rounds from one peer evaluate exactly MAX wrong passwords', async () => {
    const { t, login } = await startUi();
    const spy = vi.spyOn(t.d.auth, 'login');
    let wrong = 0;
    for (let round = 0; round < 4; round++) {
      const codes = await Promise.all(Array.from({ length: 40 }, () => login(WRONG)));
      wrong += codes.filter((c) => c === 401).length;
      expect(codes.every((c) => c === 401 || c === 403 || c === 429)).toBe(true);
    }
    expect(wrong).toBe(MAX);
    expect(spy).toHaveBeenCalledTimes(MAX);
    // Right password: 403 until the window ends, also concurrently.
    const during = await Promise.all(Array.from({ length: 10 }, () => login(USER.password)));
    expect(during).toEqual(Array(10).fill(403));
    t.clock.advance(WINDOW - 1);
    expect(await login(USER.password)).toBe(403);
    t.clock.advance(1);
    expect(await login(USER.password)).toBe(200);
  }, 60_000);

  it('a block set while attempts wait in line refuses the waiting correct logins with 403', async () => {
    const l = new LoginLimiter(2, 60_000, () => 0);
    const res = await Promise.allSettled([
      l.run('k', bad),
      l.run('k', bad),
      l.run('k', () => Promise.resolve('ok')),
    ]);
    expect(
      res.map((r) => (r.status === 'rejected' ? (r.reason as DomainError).code : 'ok')),
    ).toEqual(['unauthorized', 'unauthorized', 'forbidden']);
  });
});

describe('verify5: bounded queue answers 429 (criterion 3)', () => {
  it('unit: 50 wait, the rest get rate_limited; they record no failure; key works after', async () => {
    const l = new LoginLimiter(3, 60_000, () => 0);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowOk = async () => {
      await gate;
      return 'ok';
    };
    const all = Array.from({ length: 120 }, () => l.run('k', slowOk));
    const settled = Promise.allSettled(all);
    await tick();
    release();
    const res = await settled;
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const refused = res.filter((r) => r.status === 'rejected').map((r) => r.reason as DomainError);
    expect(ok).toBe(50);
    expect(refused.length).toBe(70);
    expect(refused.every((e) => e instanceof DomainError && e.code === 'rate_limited')).toBe(true);
    expect(failures(l).has('k')).toBe(false);
    await tick();
    expect(internals(l).queued).toBe(0);
    // full budget still available afterwards
    for (let i = 0; i < 3; i++)
      await expect(l.run('k', bad)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(l.run('k', bad)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('unit: overflow while wrong attempts are queued is rate_limited and counts nothing', async () => {
    const l = new LoginLimiter(5, 60_000, () => 0);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowBad = async () => {
      await gate;
      throw new DomainError('unauthorized', 'nope');
    };
    const first = Array.from({ length: 50 }, () => l.run('k', slowBad));
    const overflow = Array.from({ length: 30 }, () => l.run('k', slowBad));
    const o = await Promise.allSettled(overflow);
    expect(
      o.every((r) => r.status === 'rejected' && (r.reason as DomainError).code === 'rate_limited'),
    ).toBe(true);
    release();
    const f = await Promise.allSettled(first);
    const codes = f.map((r) => (r as PromiseRejectedResult).reason.code);
    expect(codes.filter((c) => c === 'unauthorized').length).toBe(5);
    expect(codes.filter((c) => c === 'forbidden').length).toBe(45);
    expect(failures(l).get('k')?.count).toBe(5);
  });

  it('real socket: overflow gets HTTP 429 with code rate_limited, never 403, then normal logins', async () => {
    const { t, login, raw } = await startUi();
    const g = gateLogins(t);
    const body = JSON.stringify(USER);
    const all = Array.from({ length: 60 }, () => raw(body));
    // The 10 overflow responses arrive while the other 50 are held.
    await vi.waitFor(() => expect(internals(t.limiter).queued).toBe(50), {
      timeout: 20_000,
    });
    g.release();
    const res = await Promise.all(all);
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length, String(statuses)).toBe(50);
    expect(statuses.filter((s) => s === 429).length, String(statuses)).toBe(10);
    expect(statuses).not.toContain(403);
    for (const r of res.filter((x) => x.status === 429)) {
      expect(JSON.parse(r.text).error.code).toBe('rate_limited');
    }
    g.restore();
    // No failures recorded: full budget, and correct login works.
    expect(await login(USER.password)).toBe(200);
    for (let i = 0; i < MAX - 1; i++) expect(await login(WRONG)).toBe(401);
    expect(await login(USER.password)).toBe(200);
  }, 60_000);
});

describe('verify5: eviction (criterion 4)', () => {
  const block = async (l: LoginLimiter, k: string, max: number) => {
    for (let i = 0; i < max; i++) await l.run(k, bad).catch(() => {});
  };

  it('the map never exceeds cap + 1 with 30 000 blocked keys', async () => {
    const l = new LoginLimiter(2, 60_000, () => 0);
    let peak = 0;
    for (let i = 0; i < 30_000; i++) {
      await block(l, `b${i}`, 2);
      peak = Math.max(peak, failures(l).size);
    }
    expect(peak).toBeLessThanOrEqual(CAP + 1);
  }, 60_000);

  it('cost per new failing key stays roughly constant with the map full of blocks', async () => {
    const l = new LoginLimiter(1, 60_000, () => 0);
    const time = async (from: number, n: number) => {
      const t0 = performance.now();
      for (let i = from; i < from + n; i++) await l.run(`k${i}`, bad).catch(() => {});
      return performance.now() - t0;
    };
    await time(0, CAP); // fill with blocks, no eviction yet
    const warm = await time(CAP, 5_000);
    const later = await time(CAP + 5_000, 20_000);
    // per-key cost of the later batch is not orders of magnitude above the first
    expect(later / 20_000).toBeLessThan((warm / 5_000) * 5 + 0.05);
    expect(failures(l).size).toBeLessThanOrEqual(CAP + 1);
  }, 60_000);

  it('order: expired, then unblocked, then oldest blocks', async () => {
    let now = 0;
    const l = new LoginLimiter(2, 1_000, () => now);
    for (let i = 0; i < 3_000; i++) await block(l, `exp${i}`, 1); // will expire
    now = 500;
    for (let i = 0; i < 5_000; i++) await block(l, `blk${i}`, 2); // blocks, resetAt 1500
    now = 1_200; // exp* expired (resetAt 1000), blocks still active
    for (let i = 0; i < 2_000; i++) await block(l, `unb${i}`, 1); // 10 000 entries
    expect(failures(l).size).toBe(CAP);
    await block(l, 'trigger', 1); // 10 001 -> evict
    const f = failures(l);
    expect([...f.keys()].some((k) => k.startsWith('exp'))).toBe(false);
    for (let i = 0; i < 5_000; i++) expect(l.isBlocked(`blk${i}`), `blk${i}`).toBe(true);
    expect(f.size).toBe(7_001); // 5000 blocks + 2000 unblocked + trigger: under target, no more removed
  });

  it('active blocks survive with exactly 10 000 keys and go oldest-first beyond', async () => {
    const l = new LoginLimiter(2, 60_000, () => 0);
    for (let i = 0; i < CAP; i++) await block(l, `b${i}`, 2);
    expect(failures(l).size).toBe(CAP);
    for (let i = 0; i < CAP; i++) expect(l.isBlocked(`b${i}`)).toBe(true);
    await block(l, 'new', 2);
    // 10 001 keys: the new (unblocked after 1 failure) entry goes first, then the oldest blocks.
    expect(l.isBlocked('b0')).toBe(false);
    expect(l.isBlocked(`b${CAP - 1}`)).toBe(true);
    expect(failures(l).size).toBeLessThanOrEqual(9_001);
  });

  it('a block renewed after expiry is not treated as the oldest block', async () => {
    let now = 0;
    const l = new LoginLimiter(2, 1_000, () => now);
    await block(l, 'renewed', 1); // first insertion, resetAt 1000
    now = 100;
    for (let i = 0; i < CAP - 1; i++) await block(l, `b${i}`, 2); // blocks until 1100
    now = 1_050; // 'renewed' expired; b* still blocked
    await block(l, 'renewed', 2); // new window, newest block, but keeps position 0
    await block(l, 'trigger', 1); // 10 001 -> evict 1 001 entries: trigger, then oldest blocks
    expect(l.isBlocked('renewed')).toBe(true);
  });

  // Without a global cap, evicting live unblocked entries past 10 000 keys resets
  // their counts (per-key accounting alone cannot be exact with bounded memory).
  // The production limiter therefore also caps failures across all clients (D46):
  // with 10 001+ addresses cycling, total evaluations per window stay <= globalMax.
  it('10 001 addresses cycling get at most the global cap of evaluations per window', async () => {
    const l = defaultLoginLimiter();
    const N = CAP + 1;
    let total = 0;
    for (let pass = 0; pass < 30; pass++) {
      for (let i = 0; i < N; i++) {
        await l
          .run(`a${i}`, async () => {
            total++;
            throw new DomainError('unauthorized', 'x');
          })
          .catch(() => {});
      }
    }
    expect(total).toBe(100);
    // Everyone is blocked for the rest of the window, also a fresh address.
    expect(l.isBlocked('fresh-address')).toBe(true);
  }, 60_000);

  it('control: with 10 000 addresses the same cycling is capped at 10 per key', async () => {
    const l = new LoginLimiter(10, 15 * 60_000, () => 0);
    let total = 0;
    for (let pass = 0; pass < 15; pass++) {
      for (let i = 0; i < CAP; i++) {
        await l
          .run(`a${i}`, async () => {
            total++;
            throw new DomainError('unauthorized', 'x');
          })
          .catch(() => {});
      }
    }
    expect(total).toBe(CAP * 10);
  }, 60_000);

  it('unblocking one specific victim needs ~9 000 other active blocks (not cheaper than addresses)', async () => {
    const l = new LoginLimiter(2, 60_000, () => 0);
    await block(l, 'victim', 2);
    // Unblocked filler cannot do it: they are evicted before any block.
    for (let i = 0; i < 20_000; i++) await block(l, `u${i}`, 1);
    expect(l.isBlocked('victim')).toBe(true);
    // 9 000 other blocks + enough filler to pass the cap evicts the oldest block.
    for (let i = 0; i < 9_000; i++) await block(l, `b${i}`, 2);
    for (let i = 0; i < 2_000 && l.isBlocked('victim'); i++) await block(l, `f${i}`, 1);
    expect(l.isBlocked('victim')).toBe(false);
  }, 60_000);
});
