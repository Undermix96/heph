import { schema } from '@heph/core';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { zipStream } from '../http/zip.js';
import { type Api, multipart, startApi } from '../test/api.js';
import { fitsZip32 } from './api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const uiRaw = (path: string) => t!.ui.request(path, { headers: { cookie: t!.getCookie() } });
const agentRaw = (path: string) =>
  t!.agent.request(path, { headers: { authorization: `Bearer ${t!.token}` } });

async function upload(ref: string, name: string, data: Uint8Array | string) {
  const r = await t!.uiReq('POST', `/api/projects/${ref}/files`, {
    body: multipart([{ name, data }]),
  });
  expect(r.status).toBe(201);
  return r.data[0] as { id: number };
}

describe('GET /api/projects/:ref/docs', () => {
  it('returns internal docs and repo entries', async () => {
    t = await startApi();
    const p = await t.seed({ repos: ['acme/widget'] });
    const r = await t.uiReq('GET', `/api/projects/${p.slug}/docs`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      projectId: p.id,
      source: 'repo',
      internal: '',
      repos: [{ fullName: 'acme/widget', docsPath: 'DECISIONS.md', content: null }],
    });
  });

  it('is available to the agent token and 404s for unknown projects', async () => {
    t = await startApi();
    const p = await t.seed();
    expect((await t.agentReq('GET', `/api/projects/${p.id}/docs`)).status).toBe(200);
    expect((await t.uiReq('GET', '/api/projects/nope/docs')).status).toBe(404);
  });

  it('requires authentication', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await t.uiReq('GET', `/api/projects/${p.id}/docs`, { withCookie: false });
    expect(r.status).toBe(401);
  });
});

describe('GET /api/projects/:ref/export', () => {
  it('streams a zip with the Markdown, project.json and the exact file bytes', async () => {
    t = await startApi();
    const p = await t.seed();
    const bytes = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
    const f = await upload(p.slug, 'data.bin', bytes);
    await upload(p.slug, '../../escape.txt', 'hi');

    const res = await uiRaw(`/api/projects/${p.slug}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(
      new RegExp(`^attachment; filename="${p.slug}-\\d{4}-\\d{2}-\\d{2}\\.zip"$`),
    );
    expect(res.headers.get('cache-control')).toBe('no-store');

    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(entries).sort();
    expect(names).toContain(`${p.slug}.md`);
    expect(names).toContain('project.json');
    expect(names.every((n) => !n.includes('..') && !n.startsWith('/'))).toBe(true);
    expect(entries[`files/${f.id}-data.bin`]).toEqual(bytes);

    const json = JSON.parse(new TextDecoder().decode(entries['project.json']));
    expect(json).toMatchObject({ format: 'heph-project-export', version: 1 });
    expect(json.project.id).toBe(p.id);
    expect(json.files).toHaveLength(2);
    for (const file of json.files) expect(names).toContain(file.exportPath);

    const md = new TextDecoder().decode(entries[`${p.slug}.md`]);
    expect(md).toContain('# Spot Welder');
    expect(md).toContain(`(files/${f.id}-data.bin)`);
  });

  it('returns the Markdown alone with format=md, also on the agent port', async () => {
    t = await startApi();
    const p = await t.seed();
    const res = await agentRaw(`/api/projects/${p.id}/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/\.md"$/);
    expect(await res.text()).toContain('## Roadmap');
  });

  it('rejects an unknown format (400) and an unknown project (404)', async () => {
    t = await startApi();
    const p = await t.seed();
    expect((await t.uiReq('GET', `/api/projects/${p.id}/export?format=pdf`)).status).toBe(400);
    expect((await t.uiReq('GET', '/api/projects/nope/export')).status).toBe(404);
  });

  it('requires authentication', async () => {
    t = await startApi();
    const p = await t.seed();
    const res = await t.ui.request(`/api/projects/${p.id}/export`);
    expect(res.status).toBe(401);
  });
});

describe('zipStream', () => {
  it('produces a valid archive with no entries', async () => {
    const buf = new Uint8Array(await new Response(zipStream([])).arrayBuffer());
    expect(Object.keys(unzipSync(buf))).toEqual([]);
  });

  it('stops reading when the consumer cancels', async () => {
    const reader = zipStream([{ name: 'a.txt', data: new Uint8Array(1000) }]).getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});

describe('zip size limit (no Zip64, D53)', () => {
  it('fitsZip32 accepts below 4 GiB and 65 535 entries, rejects at or above', () => {
    expect(fitsZip32(1000, 3)).toBe(true);
    expect(fitsZip32(0xffffffff - 2 * 1024 * 1024, 10)).toBe(true);
    expect(fitsZip32(0xffffffff, 10)).toBe(false);
    expect(fitsZip32(1000, 0xffff)).toBe(false);
  });

  it('answers 413 before streaming when the files exceed the limit; md still works', async () => {
    t = await startApi();
    const p = await t.seed();
    const f = await upload(p.slug, 'big.bin', 'x');
    t.d.db
      .update(schema.files)
      .set({ size: 5 * 1024 ** 3 })
      .where(eq(schema.files.id, f.id))
      .run();
    const zip = await t.uiReq('GET', `/api/projects/${p.id}/export`);
    expect(zip.status).toBe(413);
    expect((await uiRaw(`/api/projects/${p.id}/export?format=md`)).status).toBe(200);
  });
});
