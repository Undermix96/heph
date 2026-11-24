/**
 * Independent verification of D39 at the REST and MCP boundaries: every
 * timestamp the API returns is a UTC ISO string, and diary paging by ISO cursor
 * returns each entry exactly once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type Api, multipart, startApi } from './test/api.js';
import { startMcp, useMcpCleanup } from './test/mcp.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = 86_400_000;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let t: Api | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});
useMcpCleanup();

/** Collects `path: value` for every key that looks like a timestamp. */
function timestampFields(
  v: unknown,
  path = '$',
  out: [string, unknown][] = [],
): [string, unknown][] {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) timestampFields(x, `${path}[${i}]`, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (/(At|Since)$/.test(k)) out.push([`${path}.${k}`, x]);
      timestampFields(x, `${path}.${k}`, out);
    }
  }
  return out;
}

function expectIsoFields(label: string, data: unknown) {
  const fields = timestampFields(data);
  for (const [p, v] of fields) {
    if (v === null) continue;
    expect(typeof v === 'string' && ISO_RE.test(v), `${label} ${p} = ${JSON.stringify(v)}`).toBe(
      true,
    );
  }
  return fields.length;
}

async function populated() {
  t = await startApi();
  const p = await t.seed({ tags: ['x'], repos: ['octo/demo'] });
  const task = p.phases[0].tasks[0];
  await t.uiReq('POST', `/api/tasks/${task.id}/complete`);
  await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: 'note' } });
  await t.uiReq('POST', `/api/projects/${p.slug}/materials`, { json: { name: 'Screw' } });
  await t.uiReq('POST', `/api/projects/${p.slug}/files`, {
    body: multipart([{ name: 'a.png', data: PNG, type: 'image/png' }]),
  });
  const del = await t.agentReq('DELETE', `/api/tasks/${p.phases[1].tasks[0].id}`);
  if (del.status === 202)
    await t.uiReq('POST', `/api/proposals/${del.data.proposal.id}/reject`, { json: {} });
  await t.agentReq('DELETE', `/api/tasks/${p.phases[1].tasks[1].id}`);
  t.insertLiveSession(p.id, 'sess-live', true);
  return p;
}

describe('verify: REST timestamps are ISO strings', () => {
  it('every *At / *Since field in read and write responses', async () => {
    const p = await populated();
    const api = t!;
    let n = 0;
    const gets = [
      '/api/projects',
      `/api/projects/${p.slug}`,
      `/api/projects/${p.slug}/phases`,
      `/api/projects/${p.slug}/diary`,
      '/api/diary',
      `/api/projects/${p.slug}/materials`,
      `/api/projects/${p.slug}/files`,
      `/api/projects/${p.slug}/proposals`,
      '/api/proposals',
      '/api/needs-attention',
      `/api/tasks/${p.phases[0].tasks[0].id}`,
    ];
    for (const g of gets) {
      const r = await api.uiReq('GET', g);
      if (r.status === 404) continue;
      expect(r.status, g).toBe(200);
      n += expectIsoFields(g, r.data);
    }
    const created = await api.createProject({ name: 'Other' });
    n += expectIsoFields('create', created);
    const patched = await api.uiReq('PATCH', `/api/projects/${created.slug}`, {
      json: { description: 'd' },
    });
    n += expectIsoFields('patch', patched.data);
    expect(n).toBeGreaterThan(40);
    const detail = (await api.uiReq('GET', `/api/projects/${p.slug}`)).data;
    expect(detail.liveSessions[0].testingSince).toMatch(ISO_RE);
    expect(detail.liveSessions[0].lastHeartbeatAt).toMatch(ISO_RE);
  });

  it('upload-requests returns expiresAt as an ISO string', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`, { json: {} });
    expect(r.status).toBe(201);
    expect(r.data.expiresAt).toMatch(ISO_RE);
  });

  it('/health reports a version on both ports', async () => {
    t = await startApi();
    for (const app of [t.ui, t.agent]) {
      const r = await app.request('/health');
      const body = (await r.json()) as { version: string };
      expect(body.version).toBe(process.env.HEPH_VERSION || 'dev');
    }
  });
});

describe('verify: REST diary pagination by ISO cursor', () => {
  it('pages every entry exactly once, newest first, across ties and a month boundary', async () => {
    t = await startApi();
    const p = await t.seed();
    const times = [
      // inside the 30-day login window; month boundary + ties
      Date.UTC(2026, 11, 1),
      Date.UTC(2026, 10, 30, 23, 59, 59, 999),
      Date.UTC(2026, 11, 1),
      Date.UTC(2026, 11, 1),
      Date.UTC(2026, 10, 25),
      Date.UTC(2026, 11, 1, 0, 0, 0, 1),
    ];
    for (const ms of times) {
      t.clock.now = ms;
      await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: `at ${ms}` } });
    }
    const all = (await t.uiReq('GET', `/api/projects/${p.slug}/diary?limit=500`)).data as {
      id: number;
      occurredAt: string;
    }[];
    const seen: typeof all = [];
    let qs = '';
    for (let i = 0; i < 100; i++) {
      const r = await t.uiReq('GET', `/api/projects/${p.slug}/diary?limit=2${qs}`);
      expect(r.status).toBe(200);
      if (r.data.length === 0) break;
      seen.push(...r.data);
      const last = r.data.at(-1);
      qs = `&before=${encodeURIComponent(last.occurredAt)}&beforeId=${last.id}`;
    }
    expect(seen.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(new Set(seen.map((e) => e.id)).size).toBe(all.length);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i - 1]!.occurredAt >= seen[i]!.occurredAt).toBe(true);
    }
  });

  it('rejects a legacy numeric before cursor with 400', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await t.uiReq('GET', `/api/projects/${p.slug}/diary?before=${Date.now()}&beforeId=5`);
    expect(r.status).toBe(400);
  });

  it('activity thresholds over REST: 7 and 30 days', async () => {
    t = await startApi();
    const p = await t.seed();
    const start = t.clock.now;
    const state = async () => (await t!.uiReq('GET', `/api/projects/${p.slug}`)).data.activityState;
    t.clock.now = start + 7 * DAY - 1;
    expect(await state()).toBe('recently_active');
    t.clock.now = start + 7 * DAY;
    expect(await state()).toBe('idle');
    t.clock.now = start + 30 * DAY;
    expect(await state()).toBe('idle');
    t.clock.now = start + 30 * DAY + 1;
    expect(await state()).toBe('inactive');
  });

  it('login session expires after 30 days without use and slides on use', async () => {
    t = await startApi();
    const start = t.clock.now;
    t.clock.now = start + 29 * DAY;
    expect((await t.uiReq('GET', '/api/auth/me')).status).toBe(200); // slides
    t.clock.now = start + 58 * DAY;
    expect((await t.uiReq('GET', '/api/auth/me')).status).toBe(200);
    t.clock.now = start + 88 * DAY + 1;
    expect((await t.uiReq('GET', '/api/auth/me')).status).toBe(401);
  });
});

describe('verify: MCP timestamps', () => {
  it('get_diary pages with the printed ISO cursor and sees every entry once', async () => {
    const m = await startMcp();
    const text = await m.ok('create_project', {
      name: 'Paged',
      phases: [{ title: 'P', tasks: ['a'] }],
    });
    const id = Number(/#(\d+)/.exec(text)?.[1]);
    for (let i = 0; i < 7; i++) {
      m.t.clock.now = Date.UTC(2026, 11, 31, 23, 59, 59, 998) + (i % 3); // ties across the year boundary
      await m.ok('log_progress', { project: id, body: `entry ${i}` });
    }
    const all = m.d.diary.list(id, { limit: 500 }).map((e) => e.id);
    const seen: number[] = [];
    let args: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const out = await m.ok('get_diary', { project: id, limit: 2, ...args });
      if (out === 'No diary entries.') break;
      for (const line of out.split('\n')) {
        const mm = / #(\d+): /.exec(line);
        if (line.startsWith('- ') && mm) seen.push(Number(mm[1]));
      }
      const more = /before=(\S+), before_id=(\d+)\./.exec(out);
      if (!more) break;
      expect(more[1]).toMatch(ISO_RE);
      args = { before: more[1], before_id: Number(more[2]) };
    }
    expect(seen).toEqual(all);
  });

  it('get_diary rejects a numeric before', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'X' });
    const r = await m.call('get_diary', { project: 'x', before: Date.now() });
    expect(r.isError).toBe(true);
  });

  it('server version is HEPH_VERSION or dev', async () => {
    const m = await startMcp();
    expect(m.client.getServerVersion()?.version).toBe(process.env.HEPH_VERSION || 'dev');
  });

  it('request_upload prints an ISO expiry one hour ahead', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'X' });
    const out = await m.ok('request_upload', { project: 'x' });
    const exp = /expires (\S+)\)/.exec(out)?.[1];
    expect(exp).toMatch(ISO_RE);
    expect(Date.parse(exp!)).toBe(m.t.clock.now + 3_600_000);
  });
});
