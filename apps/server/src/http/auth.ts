import type { Domain } from '@heph/core';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './common.js';

export const SESSION_COOKIE = 'heph_session';

/** Bearer token from the Authorization header. */
export function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

/**
 * True when the request reached us over HTTPS: directly, or through a proxy
 * that set the standard X-Forwarded-Proto header (e.g. cloudflared).
 * No Cloudflare Access header is inspected.
 */
export function isHttps(c: Context): boolean {
  const xfp = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return xfp === 'https' || new URL(c.req.url).protocol === 'https:';
}

export function setSessionCookie(c: Context, token: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps(c),
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
}

/**
 * Resolves the caller.
 * - `allowCookie`: the web UI's session cookie (source `ui`).
 * - Bearer API token: source `claude_code`; `X-Heph-Session-Id` carries the
 *   Claude Code session id, `X-Heph-Confirmed: true` marks a user-confirmed
 *   destructive operation.
 * Unauthenticated requests get 401.
 */
export function authenticate(
  domain: Domain,
  opts: { allowCookie: boolean },
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('domain', domain);
    const token = bearer(c);
    if (token) {
      if (!domain.auth.verifyApiToken(token)) {
        return c.json({ error: { code: 'unauthorized', message: 'Invalid API token' } }, 401);
      }
      c.set('user', domain.auth.getUser());
      c.set('sessionToken', null);
      c.set('ctx', {
        source: 'claude_code',
        sessionId: c.req.header('x-heph-session-id')?.slice(0, 200) || null,
        confirmed: c.req.header('x-heph-confirmed')?.toLowerCase() === 'true',
      });
      return next();
    }
    if (opts.allowCookie) {
      const cookie = getCookie(c, SESSION_COOKIE) ?? null;
      const user = domain.auth.validateSession(cookie);
      if (user) {
        if (!sameOrigin(c)) {
          return c.json(
            { error: { code: 'forbidden', message: 'Cross-origin request refused' } },
            403,
          );
        }
        c.set('user', user);
        c.set('sessionToken', cookie);
        c.set('ctx', { source: 'ui' });
        return next();
      }
    }
    return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
  };
}

/** Only cookie-authenticated (UI) callers. */
export const requireUi: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('ctx').source !== 'ui') {
    return c.json({ error: { code: 'forbidden', message: 'Only available from the web UI' } }, 403);
  }
  return next();
};

/**
 * CSRF defence for cookie auth: unsafe methods must come from the same origin
 * when the browser sends an Origin header. SameSite=Lax covers the rest.
 */
export function sameOrigin(c: Context): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return true;
  const origin = c.req.header('origin');
  if (!origin) return true;
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
