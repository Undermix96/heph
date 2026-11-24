/**
 * Second independent verification: login rate limiting over a real TCP socket
 * (header spoofing, concurrency), REST cursor validation, and MCP timestamp format.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { startApi } from './test/api.js';
import { makeApps, USER } from './test/app.js';
import { startMcp, useMcpCleanup } from './test/mcp.js';

useMcpCleanup();

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0).reverse()) c();
});

/** UI app (limiter: 5 failures per window) on a real ephemeral port. */
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
  const login = (password: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: USER.username, password }),
    }).then((r) => r.status);
  return { t, base, login };
}

describe('verify2: login rate limiting over a real socket', () => {
  it('rotating forwarding/identity headers does not give a fresh bucket', async () => {
    const { login } = await startUi();
    const codes: number[] = [];
    for (let i = 0; i < 15; i++) {
      codes.push(
        await login('wrong password!!', {
          'x-forwarded-for': `10.0.${i}.1`,
          'x-real-ip': `10.1.${i}.1`,
          'cf-connecting-ip': `10.2.${i}.1`,
          'true-client-ip': `10.3.${i}.1`,
          forwarded: `for=10.4.${i}.1`,
          'user-agent': `agent-${i}`,
          'x-forwarded-host': `h${i}.example`,
        }),
      );
    }
    expect(codes.slice(0, 5), String(codes)).toEqual([401, 401, 401, 401, 401]);
    expect(
      codes.slice(5).every((c) => c === 403),
      String(codes),
    ).toBe(true);
    // the correct password is refused too while the bucket is full
    expect(await login(USER.password, { 'x-forwarded-for': '192.168.99.99' })).toBe(403);
  });

  it('varying the username (case, whitespace) does not reset the bucket', async () => {
    const { base, login } = await startUi();
    for (let i = 0; i < 5; i++) await login('wrong password!!');
    for (const username of ['ADMIN', ' admin', 'nobody', 'admin ']) {
      const s = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'wrong password!!' }),
      }).then((r) => r.status);
      expect(s, username).toBe(403);
    }
  });

  it('concurrent bad logins are limited like sequential ones', async () => {
    const { login } = await startUi();
    const codes = await Promise.all(Array.from({ length: 40 }, () => login('wrong password!!')));
    const evaluated = codes.filter((c) => c === 401).length;
    expect(evaluated, String(codes)).toBeLessThanOrEqual(5);
  });
});

describe('verify2: REST diary cursor validation', () => {
  it('rejects malformed or non-UTC cursors with 400, never 500', async () => {
    const t = await startApi();
    closers.push(() => t.cleanup());
    const p = await t.seed();
    for (const before of [
      '2026-11-24T13:00:00+01:00',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '+010000-01-01T00:00:00.000Z',
      '-000001-01-01T00:00:00.000Z',
      '2026-11-24',
      'yesterday',
      '',
    ]) {
      const r = await t.uiReq(
        'GET',
        `/api/projects/${p.slug}/diary?before=${encodeURIComponent(before)}&beforeId=1`,
      );
      expect(r.status, `before=${before}`).toBe(400);
    }
  });

  it('accepts the extreme storable cursors', async () => {
    const t = await startApi();
    closers.push(() => t.cleanup());
    const p = await t.seed();
    const lo = await t.uiReq(
      'GET',
      `/api/projects/${p.slug}/diary?before=0000-01-01T00:00:00.000Z`,
    );
    expect(lo.status).toBe(200);
    expect(lo.data).toEqual([]);
    const hi = await t.uiReq(
      'GET',
      `/api/projects/${p.slug}/diary?before=9999-12-31T23:59:59.999Z`,
    );
    expect(hi.status).toBe(200);
    expect(hi.data.length).toBeGreaterThan(0);
    for (const e of hi.data) expect(e.occurredAt).toMatch(ISO_RE);
  });
});

describe('verify2: MCP timestamps', () => {
  /** Date/time-looking tokens in tool text (anything starting with YYYY-MM-DD). */
  const dateTokens = (text: string) =>
    [...text.matchAll(/\b\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+Z?)?/g)].map((m) => m[0]);

  it('every absolute timestamp in MCP tool output is full ISO 8601 (ms + Z)', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'Stamps',
      phases: [{ title: 'P', tasks: ['a', 'b'] }],
    });
    await m.ok('log_progress', { project: 'stamps', body: 'did a thing' });
    await m.ok('complete_task', { project: 'stamps', task: 'a' }).catch(() => undefined);
    const outputs = [
      await m.ok('get_briefing', { project: 'stamps' }),
      await m.ok('get_diary', { project: 'stamps' }),
      await m.ok('get_project', { project: 'stamps' }),
    ];
    const tokens = outputs.flatMap(dateTokens);
    expect(tokens.length).toBeGreaterThan(0);
    const bad = tokens.filter((x) => !ISO_RE.test(x));
    expect(bad).toEqual([]);
  });
});
