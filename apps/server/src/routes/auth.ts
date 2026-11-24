import type { Domain } from '@heph/core';
import { DomainError } from '@heph/core';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  authenticate,
  clearSessionCookie,
  requireUi,
  SESSION_COOKIE,
  setSessionCookie,
} from '../http/auth.js';
import { type AppEnv, body } from '../http/common.js';

/** Fixed-window limiter for failed logins, per client address. */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): void {
    const e = this.failures.get(key);
    if (e && e.resetAt > this.now() && e.count >= this.max) {
      throw new DomainError('forbidden', 'Too many failed logins; try again later');
    }
  }

  fail(key: string): void {
    const now = this.now();
    const e = this.failures.get(key);
    if (!e || e.resetAt <= now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count++;
    if (this.failures.size > 10_000) this.failures.clear();
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

function clientKey(
  c: { req: { header(n: string): string | undefined } },
  remote: string | undefined,
): string {
  // Behind cloudflared the peer is the tunnel; use the forwarded client address when present.
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || remote || 'unknown';
}

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

  r.post('/setup', async (c) => {
    const input = await body(c);
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
    const key = clientKey(c, remote);
    limiter.check(key);
    try {
      const session = await domain.auth.login(await body(c), c.req.header('user-agent'));
      limiter.reset(key);
      setSessionCookie(c, session.sessionToken, session.expiresAt);
      return c.json({ user: session.user });
    } catch (e) {
      if (e instanceof DomainError && e.code === 'unauthorized') limiter.fail(key);
      throw e;
    }
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
