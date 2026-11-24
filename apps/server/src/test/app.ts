import { makeDomain } from '@heph/core/testing';
import pino from 'pino';
import { createAgentApp, createUiApp } from '../app.js';
import { LoginLimiter } from '../routes/auth.js';

export const USER = { username: 'admin', password: 'correct horse battery' };

type ReqOpts = {
  json?: unknown;
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  withCookie?: boolean;
};

/** UI and agent apps over a fresh in-memory domain, plus small request helpers. */
export function makeApps() {
  const t = makeDomain();
  const log = pino({ level: 'silent' });
  const limiter = new LoginLimiter(5, 60_000, () => t.clock.now);
  const ui = createUiApp({ domain: t.d, log, webDir: null, limiter });
  const agent = createAgentApp({ domain: t.d, log, webDir: null });
  let cookie = '';

  const call = async (app: typeof ui, method: string, path: string, opts: ReqOpts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.json !== undefined) headers['content-type'] = 'application/json';
    if (opts.withCookie !== false && cookie && app === ui) headers.cookie = cookie;
    const res = await app.request(path, {
      method,
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie?.startsWith('heph_session=')) {
      const value = setCookie.split(';')[0] as string;
      cookie = value === 'heph_session=' ? '' : value;
    }
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test convenience
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, data, headers: res.headers };
  };

  /** Runs setup and leaves the UI client logged in; returns the API token. */
  const setup = async () => {
    const r = await call(ui, 'POST', '/api/setup', { json: USER });
    if (r.status !== 201) throw new Error(`setup failed: ${JSON.stringify(r.data)}`);
    return r.data.apiToken as string;
  };

  return {
    ...t,
    ui,
    agent,
    limiter,
    setup,
    clearCookie: () => {
      cookie = '';
    },
    getCookie: () => cookie,
    /** Cookie-authenticated request to the UI port. */
    uiReq: (method: string, path: string, opts?: ReqOpts) => call(ui, method, path, opts),
    /** Bearer-authenticated request to the given port (default: agent). */
    tokenReq: (
      token: string,
      method: string,
      path: string,
      opts: ReqOpts = {},
      app: 'ui' | 'agent' = 'agent',
    ) =>
      call(app === 'ui' ? ui : agent, method, path, {
        ...opts,
        withCookie: false,
        headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
      }),
  };
}
