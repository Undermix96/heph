import type { Domain } from '@heph/core';
import { DomainError, iso } from '@heph/core';
import { LoginInput } from '@heph/schema';
import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { publicAgentUrl } from '../config.js';
import {
  authenticate,
  clearSessionCookie,
  requireUi,
  SESSION_COOKIE,
  sameOrigin,
  setSessionCookie,
} from '../http/auth.js';
import { type AppEnv, body } from '../http/common.js';

/** Most keys tracked at once; beyond this, expired, then unblocked, then oldest entries go. */
const MAX_TRACKED_KEYS = 10_000;
/** Most login attempts waiting at once (all clients); more are refused with 429. */
const MAX_QUEUED = 50;

const tooMany = () => new DomainError('forbidden', 'Too many failed logins; try again later');
const busy = () =>
  new DomainError('rate_limited', 'Too many login attempts in progress; try again in a moment');

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter for failed logins: `max` per client key and `globalMax`
 * across all clients (single-user app: the global cap bounds password guessing
 * no matter how many addresses an attacker has, also when per-key entries are
 * evicted to bound memory).
 * Do not break: attempts are evaluated strictly one after another (one queue for
 * all clients; logins are rare), so concurrency cannot exceed either limit, and
 * concurrent correct logins are not refused (up to the queue bound: 429).
 */
export class LoginLimiter {
  private readonly failures = new Map<string, Window>();
  private global: Window = { count: 0, resetAt: 0 };
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
    /** Failures per window across all clients; the app sets it (D46), off by default. */
    private readonly globalMax = Number.POSITIVE_INFINITY,
  ) {}

  /**
   * Runs one login attempt after the previous ones finished. A DomainError
   * `unauthorized` from `attempt` counts as a failure; success clears the key.
   */
  run<T>(key: string, attempt: () => Promise<T>): Promise<T> {
    if (this.isBlocked(key)) return Promise.reject(tooMany());
    // Bounded queue (memory): excess concurrent attempts get 429, not a "failed logins" 403.
    if (this.queued >= MAX_QUEUED) return Promise.reject(busy());
    this.queued++;
    const result = this.tail.then(async () => {
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
    this.tail = result.catch(() => undefined);
    void this.tail.then(() => {
      this.queued--;
    });
    return result;
  }

  /** True when the key, or every client (global cap), is blocked right now. */
  isBlocked(key: string): boolean {
    const now = this.now();
    if (this.global.resetAt > now && this.global.count >= this.globalMax) return true;
    const e = this.failures.get(key);
    return !!e && e.resetAt > now && e.count >= this.max;
  }

  private recordFailure(key: string): void {
    const now = this.now();
    if (this.global.resetAt <= now) this.global = { count: 0, resetAt: now + this.windowMs };
    this.global.count++;
    const e = this.failures.get(key);
    if (!e || e.resetAt <= now) {
      // Re-insert so a renewed window counts as the newest entry for eviction.
      this.failures.delete(key);
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    } else e.count++;
    if (this.failures.size > MAX_TRACKED_KEYS) this.evict(now);
  }

  /**
   * Shrinks the map to 90% of the cap, so the O(n) sweep runs at most once per
   * ~1000 new keys: expired entries first, then unblocked ones, then the oldest.
   * Evicting a key can reset its count, but never lifts the global cap.
   */
  private evict(now: number): void {
    const target = Math.floor(MAX_TRACKED_KEYS * 0.9);
    for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    for (const [k, v] of this.failures) {
      if (this.failures.size <= target) return;
      if (v.count < this.max) this.failures.delete(k);
    }
    for (const k of this.failures.keys()) {
      if (this.failures.size <= target) return;
      this.failures.delete(k);
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
/** Production limits: 10 failures per client and 100 overall per 15-minute window. */
export const defaultLoginLimiter = () => new LoginLimiter(10, 15 * 60_000, Date.now, 100);

export function authRoutes(domain: Domain, limiter = defaultLoginLimiter()) {
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
    // Validate the shape first: an invalid login is a 400 and never reaches the limiter.
    const parsed = LoginInput.safeParse(await body(c, { requireJson: true }));
    if (!parsed.success) throw new DomainError('validation', 'Expected { username, password }');
    const input = parsed.data;
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

  // "Connect Claude Code" page (§4, D60): what to paste into the plugin's configuration.
  authed.get('/settings/connect', auth, requireUi, (c) => {
    const last = domain.settings.lastAgentCallAt();
    return c.json({
      agentUrl: publicAgentUrl(),
      lastAgentCallAt: last === null ? null : iso(last),
    });
  });

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
