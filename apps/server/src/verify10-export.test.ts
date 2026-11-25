// Independent verification of the export endpoint, round 10. Invented data only.
// Focus: the Zip64 refusal at its exact boundary with DB-set file sizes (criterion 2).
import { schema } from '@heph/core';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { fitsZip32 } from './routes/api.js';
import { type Api, multipart, startApi } from './test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const get = (p: string) => t!.ui.request(p, { headers: { cookie: t!.getCookie() } });
// Revised by the author on 2026-11-25 (D53): the margin is 1 MiB plus 1 KiB per entry;
// these tests export 3 entries (Markdown, project.json, one file).
const LIMIT = 0xffffffff - 1024 * 1024 - 3 * 1024; // refused at or above

async function projectWithFile() {
  t = await startApi();
  const p = await t.seed();
  const r = await t.uiReq('POST', `/api/projects/${p.id}/files`, {
    body: multipart([{ name: 'a.bin', data: new Uint8Array([1, 2, 3]) }]),
  });
  expect(r.status).toBe(201);
  return { p, fileId: r.data[0].id as number };
}

const setSize = (id: number, size: number) =>
  t!.d.db.update(schema.files).set({ size }).where(eq(schema.files.id, id)).run();

/** Markdown + JSON bytes of the export, computed the way the route encodes them. */
function overhead(projectId: number): number {
  const x = t!.d.export.build(projectId);
  const enc = new TextEncoder();
  return enc.encode(x.markdown).length + enc.encode(`${JSON.stringify(x.json, null, 2)}\n`).length;
}

/** Sets the file size so that the total content is exactly `total` bytes. */
function setTotal(projectId: number, fileId: number, total: number) {
  setSize(fileId, 4_000_000_000); // same digit count as the target size
  const o = overhead(projectId);
  setSize(fileId, total - o);
  expect(overhead(projectId) + (total - o)).toBe(total);
}

describe('verify10 Zip64 boundary', () => {
  it('fitsZip32: content and entry limits are exclusive at the documented values', () => {
    expect(fitsZip32(LIMIT - 1, 3)).toBe(true);
    expect(fitsZip32(LIMIT, 3)).toBe(false);
    expect(fitsZip32(0, 65_534)).toBe(true);
    expect(fitsZip32(0, 65_535)).toBe(false);
  });

  it('total content one byte below the limit is streamed (200)', async () => {
    const { p, fileId } = await projectWithFile();
    setTotal(p.id, fileId, LIMIT - 1);
    const res = await get(`/api/projects/${p.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    // The real file has 3 bytes: the archive is still valid.
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries)).toHaveLength(3);
  });

  it('total content exactly at the limit is refused with 413 before any zip byte', async () => {
    const { p, fileId } = await projectWithFile();
    setTotal(p.id, fileId, LIMIT);
    const res = await get(`/api/projects/${p.id}/export`);
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type') ?? '').toMatch(/json/);
    expect(res.headers.get('content-disposition')).toBeNull();
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body[0] === 0x50 && body[1] === 0x4b).toBe(false); // no "PK" zip signature
    const md = await get(`/api/projects/${p.id}/export?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  it('several files whose sizes only together exceed the limit are refused', async () => {
    const { p, fileId } = await projectWithFile();
    const r = await t!.uiReq('POST', `/api/projects/${p.id}/files`, {
      body: multipart([{ name: 'b.bin', data: new Uint8Array([4]) }]),
    });
    setSize(fileId, 2 ** 31);
    setSize(r.data[0].id, 2 ** 31);
    expect((await get(`/api/projects/${p.id}/export`)).status).toBe(413);
  });

  it('a huge file missing on disk is not counted (not exported)', async () => {
    const { p, fileId } = await projectWithFile();
    setSize(fileId, 2 ** 40);
    const fs = await import('node:fs');
    fs.rmSync(t!.d.files.open(fileId).path);
    const res = await get(`/api/projects/${p.id}/export`);
    expect(res.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(['project.json', `${p.slug}.md`].sort());
  });

  it('?format=xyz is 400, unknown project 404, no cookie 401', async () => {
    const { p } = await projectWithFile();
    expect((await get(`/api/projects/${p.id}/export?format=xyz`)).status).toBe(400);
    expect((await get('/api/projects/no-such-project/export')).status).toBe(404);
    expect((await t!.ui.request(`/api/projects/${p.id}/export`)).status).toBe(401);
  });
});
