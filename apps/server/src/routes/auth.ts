import type { Domain } from '@heph/core';
import { DomainError } from '@heph/core';
import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  authenticate,
  clearSessionCookie,
  requireUi,
  SESSION_COOKIE,
  sameOrigin,
  setSessionCookie,
} from '../http/auth.js';
import { type AppEnv, body } from '../http/common.js';

/** Most keys tracked at once; beyond this, expired then unblocked entries are evicted. */
const MAX_TRACKED_KEYS = 10_000;
/** Most login attempts waiting in one key's queue; more are refused at once. */
const MAX_QUEUED_PER_KEY = 50;

const tooMany = () => new DomainError('forbidden', 'Too many failed logins; try again later');

/**
 * Fixed-window limiter for failed logins, per client key.
 * Do not break: attempts of one key are evaluated strictly one after another
 * (run()), so concurrent requests cannot evaluate more than `max` wrong
 * passwords, and concurrent correct logins are not refused. Active blocks are
 * never evicted.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly queues = new Map<string, { tail: Promise<unknown>; size: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Runs one login attempt for `key` after the previous ones finished.
   * A DomainError `unauthorized` from `attempt` counts as a failure; success clears the key.
   */
  run<T>(key: string, attempt: () => Promise<T>): Promise<T> {
    if (this.isBlocked(key)) return Promise.reject(tooMany());
    const q = this.queues.get(key) ?? { tail: Promise.resolve(), size: 0 };
    if (q.size >= MAX_QUEUED_PER_KEY) return Promise.reject(tooMany());
    q.size++;
    this.queues.set(key, q);
    const result = q.tail.then(async () => {
      if (this.isBlocked(key)) throw tooMany();
      try {
        const value = await attempt();
        this.failures.delete(key);
        return value;
      } catch (e) {
        if (e instanceof DomainError && e.code === 'unauthorized') this.recordFailure(key);
        throw e;
      }
    });
    q.tail = result.catch(() => undefined);
    void q.tail.then(() => {
      if (--q.size === 0 && this.queues.get(key) === q) this.queues.delete(key);
    });
    return result;
  }

  isBlocked(key: string): boolean {
    const e = this.failures.get(key);
    return !!e && e.resetAt > this.now() && e.count >= this.max;
  }

  private recordFailure(key: string): void {
    const now = this.now();
    const e = this.failures.get(key);
    if (!e || e.resetAt <= now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count++;
    if (this.failures.size > MAX_TRACKED_KEYS) this.evict(now);
  }

  /** Drops expired entries, then unblocked ones (oldest first); never active blocks. */
  private evict(now: number): void {
    for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    for (const [k, v] of this.failures) {
      if (this.failures.size <= MAX_TRACKED_KEYS) break;
      if (v.count < this.max) this.failures.delete(k);
    }
  }
}

/**
 * Limiter key: the TCP peer address only. Do not use X-Forwarded-For: the client
 * controls it and could get a fresh bucket per request. Behind the tunnel all
 * logins share the tunnel's bucket, which is acceptable for a single-user app.
 */
function clientKey(remote: string | undefined): string {
  return remote || 'unknown';
}

const crossSiteGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!sameOrigin(c)) {
    return c.json({ error: { code: 'forbidden', message: 'Cross-origin request refused' } }, 403);
  }
  return next();
};

/**
 * Setup wizard, login/logout, account and API token routes (mounted at /api).
 * `/setup` only works before the first user exists.
 */
export function authRoutes(domain: Domain, limiter = new LoginLimiter()) {
  const r = new Hono<AppEnv>();

  r.get('/auth/status', (c) => {
    const user = domain.auth.validateSession(getCookie(c, SESSION_COOKIE));
    return c.json({ setupDone: domain.auth.isSetupDone(), user });
  });

  // Login and setup are reachable without a session: refuse cross-site requests
  // (e.g. another website locking the owner out with forged bad logins).
  r.use('/auth/login', crossSiteGuard);
  r.use('/setup', crossSiteGuard);

  r.post('/setup', async (c) => {
    const input = await body(c, { requireJson: true });
    const { user, apiToken } = await domain.auth.setup(input);
    // Log the new user in right away.
    const session = await domain.auth.login(
      { username: user.username, password: (input as { password: string }).password },
      c.req.header('user-agent'),
    );
    setSessionCookie(c, session.sessionToken, session.expiresAt);
    // The API token is shown once here and later in Settings.
    return c.json({ user, apiToken }, 201);
  });

  r.post('/auth/login', async (c) => {
    const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    const key = clientKey(remote);
    const input = await body(c, { requireJson: true });
    const session = await limiter.run(key, () =>
      domain.auth.login(input, c.req.header('user-agent')),
    );
    setSessionCookie(c, session.sessionToken, session.expiresAt);
    return c.json({ user: session.user });
  });

  r.post('/auth/logout', (c) => {
    domain.auth.logout(getCookie(c, SESSION_COOKIE));
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  const authed = r;
  const auth = authenticate(domain, { allowCookie: true });

  authed.get('/auth/me', auth, (c) => c.json({ user: c.get('user'), source: c.get('ctx').source }));

  authed.post('/auth/password', auth, requireUi, async (c) => {
    const user = c.get('user');
    if (!user) throw new DomainError('unauthorized', 'Authentication required');
    await domain.auth.changePassword(user.id, await body(c), c.get('sessionToken'));
    return c.json({ ok: true });
  });

  authed.get('/settings/api-token', auth, requireUi, (c) =>
    c.json({ apiToken: domain.auth.getApiToken() }),
  );

  authed.post('/settings/api-token/rotate', auth, requireUi, (c) =>
    c.json({ apiToken: domain.auth.rotateApiToken(c.get('ctx')) }),
  );

  authed.get('/settings', auth, (c) => {
    const s = domain.settings.get();
    // Never echo the GitHub token back; say whether one is set.
    return c.json({ ...s, githubToken: s.githubToken ? '***' : null });
  });

  authed.patch('/settings', auth, requireUi, async (c) => {
    const s = domain.settings.update(await body(c), c.get('ctx'));
    return c.json({ ...s, githubToken: s.githubToken ? '***' : null });
  });

  return r;
}
