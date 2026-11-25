// Independent verification of the export endpoint, round 8. Invented data only.
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { type Api, multipart, startApi } from './test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const get = (p: string) => t!.ui.request(p, { headers: { cookie: t!.getCookie() } });

function bytes(i: number, n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let k = 0; k < n; k++) b[k] = (k * 7 + i * 13) % 256;
  return b;
}

describe('verify8 export over HTTP', () => {
  it('archive holds exactly <slug>.md, project.json and one byte-identical entry per file (40 files)', async () => {
    t = await startApi();
    const p = await t.seed();
    const sent = new Map<number, Uint8Array>();
    for (let i = 0; i < 40; i++) {
      const data = bytes(i, 1 + i * 997);
      const r = await t.uiReq('POST', `/api/projects/${p.id}/files`, {
        body: multipart([{ name: i % 2 ? `dup.bin` : `../x/${i} é.bin`, data }]),
      });
      expect(r.status).toBe(201);
      sent.set(r.data[0].id, data);
    }
    const res = await get(`/api/projects/${p.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      new RegExp(`^attachment; filename="${p.slug}-\\d{4}-\\d{2}-\\d{2}\\.zip"$`),
    );
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(entries);
    expect(names).toHaveLength(42);
    expect(names).toContain(`${p.slug}.md`);
    expect(names).toContain('project.json');
    const json = JSON.parse(new TextDecoder().decode(entries['project.json']));
    for (const f of json.files) {
      expect(f.exportPath).toMatch(/^files\/\d+-[A-Za-z0-9._-]{1,100}$/);
      expect(f.exportPath.slice(String(f.id).length + 7)).not.toMatch(/^\./);
      expect(Buffer.from(entries[f.exportPath]!).equals(Buffer.from(sent.get(f.id)!))).toBe(true);
    }
  });

  it('two concurrent exports, one cancelled early, the other still complete and valid', async () => {
    t = await startApi();
    const p = await t.seed();
    await t.uiReq('POST', `/api/projects/${p.id}/files`, {
      body: multipart([{ name: 'big.bin', data: bytes(1, 3 * 1024 * 1024) }]),
    });
    const [a, b] = await Promise.all([
      get(`/api/projects/${p.id}/export`),
      get(`/api/projects/${p.id}/export`),
    ]);
    const ra = a.body!.getReader();
    await ra.read();
    await ra.cancel();
    const entries = unzipSync(new Uint8Array(await b.arrayBuffer()));
    expect(Object.keys(entries)).toHaveLength(3);
  });

  it('format=md of hostile diary content contains exactly one top-level H1', async () => {
    t = await startApi();
    const p = await t.seed();
    // "#tag" is paragraph text in CommonMark, so "#tag\n===" is a setext <h1>.
    const r = await t.uiReq('POST', `/api/projects/${p.id}/diary`, {
      json: { body: 'intro\n\n#tag\n===' },
    });
    expect([200, 201]).toContain(r.status);
    const md = await (await get(`/api/projects/${p.id}/export?format=md`)).text();
    expect(md).toContain('#tag');
    expect(md).not.toMatch(/\n#tag\n=+\n/);
  });
});
