// Independent verification of the export and docs endpoints (verify round 7). Invented data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '@heph/core';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipStream } from './http/zip.js';
import { type Api, multipart, startApi } from './test/api.js';

let t: Api | undefined;
const tmpDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  t?.cleanup();
  t = undefined;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpFile(bytes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-v7-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'big.bin');
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31) % 251;
  fs.writeFileSync(p, buf);
  return p;
}

const uiRaw = (p: string, headers: Record<string, string> = {}) =>
  t!.ui.request(p, { headers: { cookie: t!.getCookie(), ...headers } });
const bearer = (app: 'ui' | 'agent', p: string) =>
  (app === 'ui' ? t!.ui : t!.agent).request(p, {
    headers: { authorization: `Bearer ${t!.token}` },
  });

async function upload(ref: string, name: string, data: Uint8Array | string) {
  const r = await t!.uiReq('POST', `/api/projects/${encodeURIComponent(ref)}/files`, {
    body: multipart([{ name, data }]),
  });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data[0] as { id: number };
}

describe('verify7 auth matrix', () => {
  it('docs and export: bearer works on both ports, cookie only on the UI port', async () => {
    t = await startApi();
    const p = await t.seed();
    for (const route of ['docs', 'export', 'export?format=md']) {
      const url = `/api/projects/${p.id}/${route}`;
      expect((await bearer('ui', url)).status, `ui bearer ${route}`).toBe(200);
      expect((await bearer('agent', url)).status, `agent bearer ${route}`).toBe(200);
      expect((await uiRaw(url)).status, `ui cookie ${route}`).toBe(200);
      const cookieOnAgent = await t.agent.request(url, { headers: { cookie: t.getCookie() } });
      expect(cookieOnAgent.status, `agent cookie ${route}`).toBe(401);
      expect((await t.agent.request(url)).status, `agent none ${route}`).toBe(401);
      expect((await t.ui.request(url)).status, `ui none ${route}`).toBe(401);
      const badToken = await t.agent.request(url, {
        headers: { authorization: 'Bearer not-the-token' },
      });
      expect(badToken.status, `agent bad token ${route}`).toBe(401);
    }
  });

  it('format validation runs after auth (no 400 leak to anonymous callers)', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await t.ui.request(`/api/projects/${p.id}/export?format=pdf`);
    expect(r.status).toBe(401);
  });

  it('rejects format variants: empty, uppercase, repeated', async () => {
    t = await startApi();
    const p = await t.seed();
    for (const q of ['format=', 'format=ZIP', 'format=md%00', 'format=json']) {
      const r = await uiRaw(`/api/projects/${p.id}/export?${q}`);
      expect(r.status, q).toBe(400);
    }
  });
});

describe('verify7 project references', () => {
  it('works with id, slug and an encoded owner/name repo ref', async () => {
    t = await startApi();
    const p = await t.seed({ repos: ['acme/widget'] });
    for (const ref of [String(p.id), p.slug, encodeURIComponent('acme/widget')]) {
      const docs = await uiRaw(`/api/projects/${ref}/docs`);
      expect(docs.status, `docs ${ref}`).toBe(200);
      expect(((await docs.json()) as { projectId: number }).projectId).toBe(p.id);
      const ex = await uiRaw(`/api/projects/${ref}/export?format=md`);
      expect(ex.status, `export ${ref}`).toBe(200);
      expect(ex.headers.get('content-disposition')).toContain(`filename="${p.slug}-`);
    }
  });

  it('docs: repo view fields are all present, docsUpdatedAt ISO when synced', async () => {
    t = await startApi();
    const p = await t.seed({ repos: ['acme/widget'] });
    t.d.db
      .update(schema.projectRepos)
      .set({ docsContent: '# X', docsUpdatedAt: t.clock.now, docsOrigin: 'hook' })
      .where(eq(schema.projectRepos.projectId, p.id))
      .run();
    const r = await t.uiReq('GET', `/api/projects/${p.id}/docs`);
    const repo = r.data.repos[0];
    for (const k of [
      'id',
      'fullName',
      'owner',
      'name',
      'docsPath',
      'showCommits',
      'docsUpdatedAt',
      'docsOrigin',
      'content',
    ]) {
      expect(repo, k).toHaveProperty(k);
    }
    expect(repo.owner).toBe('acme');
    expect(repo.name).toBe('widget');
    expect(repo.docsUpdatedAt).toMatch(/Z$/);
    expect(repo.content).toBe('# X');
    expect(repo).not.toHaveProperty('docsContent');
  });

  it('unknown repo ref → 404', async () => {
    t = await startApi();
    await t.seed();
    const r = await uiRaw(`/api/projects/${encodeURIComponent('no/such')}/export`);
    expect(r.status).toBe(404);
  });
});

describe('verify7 archive content', () => {
  it('handles unicode, emoji, dot-only, slash-only, duplicate and long names', async () => {
    t = await startApi();
    const p = await t.seed();
    const names = [
      '😀 photo.png.txt',
      '日本語.txt',
      '....',
      '..\\..\\win.txt',
      'dup.txt',
      'dup.txt',
      `${'L'.repeat(240)}.txt`,
    ];
    const ids: number[] = [];
    for (const [i, n] of names.entries()) ids.push((await upload(p.slug, n, `content-${i}`)).id);
    const res = await uiRaw(`/api/projects/${p.slug}/export`);
    expect(res.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const fileEntries = Object.keys(entries).filter((n) => n.startsWith('files/'));
    expect(fileEntries).toHaveLength(names.length);
    for (const n of Object.keys(entries)) {
      expect(n).not.toMatch(/\\|\.\.|^\/|^[A-Za-z]:/);
      expect(n.split('/').length).toBeLessThanOrEqual(2);
    }
    for (const [i, id] of ids.entries()) {
      const name = fileEntries.find((n) => n.startsWith(`files/${id}-`));
      expect(name, `file ${id}`).toBeDefined();
      expect(new TextDecoder().decode(entries[name!])).toBe(`content-${i}`);
      expect(name!.slice(`files/${id}-`.length)).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/);
    }
  });

  it('project.json file entries point to existing archive entries, and Markdown links match', async () => {
    t = await startApi();
    const p = await t.seed();
    await upload(p.slug, 'a.txt', 'aaa');
    await upload(p.slug, 'b.txt', 'bbb');
    const entries = unzipSync(
      new Uint8Array(await (await uiRaw(`/api/projects/${p.id}/export`)).arrayBuffer()),
    );
    const json = JSON.parse(new TextDecoder().decode(entries['project.json']));
    const md = new TextDecoder().decode(entries[`${p.slug}.md`]);
    for (const f of json.files) {
      expect(entries[f.exportPath]).toBeDefined();
      expect(md).toContain(`](${f.exportPath})`);
    }
    // JSON must not leak storage paths on the server.
    expect(JSON.stringify(json)).not.toContain(t.filesDir);
    expect(JSON.stringify(json)).not.toMatch(/storagePath|absPath/);
  });

  it('markdown export has no zip; md body equals the zip .md entry', async () => {
    t = await startApi();
    const p = await t.seed({ description: 'Invented.' });
    const md = await (await uiRaw(`/api/projects/${p.id}/export?format=md`)).text();
    const entries = unzipSync(
      new Uint8Array(await (await uiRaw(`/api/projects/${p.id}/export`)).arrayBuffer()),
    );
    expect(new TextDecoder().decode(entries[`${p.slug}.md`])).toBe(md);
  });
});

describe('verify7 zipStream', () => {
  it('large file: byte-identical, and memory bounded (reads only ahead by a few chunks)', async () => {
    const big = tmpFile(12 * 1024 * 1024);
    const created: fs.ReadStream[] = [];
    const orig = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...a: Parameters<typeof orig>) => {
      const s = orig(...a);
      created.push(s);
      return s;
    }) as typeof orig);
    const reader = zipStream([{ name: 'big.bin', path: big }]).getReader();
    const chunks: Uint8Array[] = [];
    const first = await reader.read();
    if (first.value) chunks.push(first.value);
    await new Promise((r) => setTimeout(r, 200));
    expect(created).toHaveLength(1);
    // Without reading further the producer must stall well below the file size.
    expect(created[0]!.bytesRead).toBeLessThan(2 * 1024 * 1024);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    const out = unzipSync(all);
    expect(Buffer.from(out['big.bin']!).equals(fs.readFileSync(big))).toBe(true);
  });

  it('cancelling mid-file closes the file handle and raises no unhandled rejection', async () => {
    const big = tmpFile(8 * 1024 * 1024);
    const created: fs.ReadStream[] = [];
    const orig = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...a: Parameters<typeof orig>) => {
      const s = orig(...a);
      created.push(s);
      return s;
    }) as typeof orig);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const reader = zipStream([
        { name: 'a.md', data: new TextEncoder().encode('# hi') },
        { name: 'big.bin', path: big },
        { name: 'big2.bin', path: big },
      ]).getReader();
      for (let i = 0; i < 5; i++) await reader.read();
      await reader.cancel();
      await new Promise((r) => setTimeout(r, 300));
      expect(created).toHaveLength(1);
      expect(created[0]!.destroyed).toBe(true);
      expect(created[0]!.closed).toBe(true);
      // The file can be renamed/removed afterwards (no lingering Windows handle).
      fs.renameSync(big, `${big}.moved`);
      fs.rmSync(`${big}.moved`);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cancelling while stalled on backpressure between entries also stops', async () => {
    const big = tmpFile(256 * 1024);
    const created: fs.ReadStream[] = [];
    const orig = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...a: Parameters<typeof orig>) => {
      const s = orig(...a);
      created.push(s);
      return s;
    }) as typeof orig);
    const s = zipStream([
      { name: '1.bin', path: big },
      { name: '2.bin', path: big },
      { name: '3.bin', path: big },
    ]);
    const reader = s.getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 100));
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 200));
    expect(created.length).toBeLessThan(3);
    for (const c of created) expect(c.destroyed).toBe(true);
  });

  it('a file deleted before streaming errors the stream instead of crashing', async () => {
    const big = tmpFile(1024);
    fs.rmSync(big);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        new Response(zipStream([{ name: 'x', path: big }])).arrayBuffer(),
      ).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('empty file on disk is stored as an empty entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-v7-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'empty');
    fs.writeFileSync(p, '');
    const buf = new Uint8Array(
      await new Response(zipStream([{ name: 'e', path: p }])).arrayBuffer(),
    );
    expect(unzipSync(buf).e).toEqual(new Uint8Array(0));
  });

  it('HTTP: cancelling the export response body mid-file does not leave handles open', async () => {
    t = await startApi();
    const p = await t.seed();
    // Store a large file directly as an upload of the project (bypasses the upload cap).
    const f = await upload(p.slug, 'seed.bin', 'x');
    const abs = t.d.files.open(f.id).path;
    fs.writeFileSync(abs, Buffer.alloc(6 * 1024 * 1024, 7));
    const created: fs.ReadStream[] = [];
    const orig = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...a: Parameters<typeof orig>) => {
      const s = orig(...a);
      created.push(s);
      return s;
    }) as typeof orig);
    const res = await uiRaw(`/api/projects/${p.id}/export`);
    const reader = res.body!.getReader();
    for (let i = 0; i < 4; i++) await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 300));
    expect(created.every((c) => c.destroyed)).toBe(true);
  });
});

describe('verify7 real socket', () => {
  it('client aborting the download over a real socket does not crash and closes the file', async () => {
    const { serve } = await import('@hono/node-server');
    t = await startApi();
    const p = await t.seed();
    const f = await upload(p.slug, 'seed.bin', 'x');
    fs.writeFileSync(t.d.files.open(f.id).path, Buffer.alloc(32 * 1024 * 1024, 3));
    const created: fs.ReadStream[] = [];
    const orig = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...a: Parameters<typeof orig>) => {
      const s = orig(...a);
      created.push(s);
      return s;
    }) as typeof orig);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: t!.agent.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${p.id}/export`, {
        headers: { authorization: `Bearer ${t.token}` },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      let got = 0;
      while (got < 256 * 1024) {
        const { value, done } = await reader.read();
        if (done) break;
        got += value.length;
      }
      ac.abort();
      await new Promise((r) => setTimeout(r, 1000));
      expect(created).toHaveLength(1);
      expect(created[0]!.destroyed).toBe(true);
      expect(created[0]!.bytesRead).toBeLessThan(32 * 1024 * 1024);
      expect(unhandled).toEqual([]);
      // The server still answers.
      const again = await fetch(`http://127.0.0.1:${port}/api/projects/${p.id}/docs`, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(again.status).toBe(200);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
