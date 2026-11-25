// Independent verification of the export endpoint, round 9. Invented data only.
// Focus: the zip is structurally valid (CRC-32 and sizes in the central directory match
// the bytes), and the Markdown invariant holds over HTTP.
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { type Api, multipart, startApi } from './test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const get = (p: string) => t!.ui.request(p, { headers: { cookie: t!.getCookie() } });

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface CentralEntry {
  name: string;
  crc: number;
  compressed: number;
  size: number;
  method: number;
  localOffset: number;
}

/** Reads the central directory by hand (fflate's unzip does not check CRCs). */
function central(zip: Uint8Array): CentralEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(off, true)).toBe(0x02014b50);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    out.push({
      method: dv.getUint16(off + 10, true),
      crc: dv.getUint32(off + 16, true),
      compressed: dv.getUint32(off + 20, true),
      size: dv.getUint32(off + 24, true),
      localOffset: dv.getUint32(off + 42, true),
      name: new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen)),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('verify9 export zip structure', () => {
  it('central directory CRC-32, sizes and local header offsets match every entry', async () => {
    t = await startApi();
    const p = await t.seed({ description: '# Intro\n\nInvented description.' });
    const files: [string, Uint8Array][] = [
      ['small.txt', new TextEncoder().encode('hello')],
      ['big.bin', new Uint8Array(1_500_000).map((_, i) => (i * 31 + 7) % 251)],
    ];
    for (const [name, data] of files) {
      const r = await t.uiReq('POST', `/api/projects/${p.id}/files`, {
        body: multipart([{ name, data }]),
      });
      expect(r.status).toBe(201);
    }
    const res = await get(`/api/projects/${p.id}/export`);
    expect(res.status).toBe(200);
    const zip = new Uint8Array(await res.arrayBuffer());
    const entries = unzipSync(zip);
    const cd = central(zip);
    expect(cd.map((e) => e.name).sort()).toEqual(Object.keys(entries).sort());
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (const e of cd) {
      const data = entries[e.name]!;
      expect(e.size, e.name).toBe(data.length);
      expect(e.crc, e.name).toBe(crc32(data));
      expect(dv.getUint32(e.localOffset, true), e.name).toBe(0x04034b50);
      // Uploads stored (0), Markdown and JSON deflated (8).
      expect(e.method, e.name).toBe(e.name.startsWith('files/') ? 0 : 8);
    }
  });
});

describe('verify9 export Markdown over HTTP', () => {
  it('task notes with CR line endings in raw HTML do not add a top-level heading', async () => {
    t = await startApi();
    const p = await t.seed();
    const taskId = p.phases[0].tasks[0].id;
    const r = await t.uiReq('PATCH', `/api/tasks/${taskId}`, {
      json: { notes: '<div>\r# Evil\r</div>' },
    });
    expect(r.status).toBe(200);
    const md = await (await get(`/api/projects/${p.id}/export?format=md`)).text();
    // In CommonMark a bare CR ends a line, so "# Evil" would start at column 0.
    expect(md.split(/\r\n|\r|\n/).filter((l) => /^#\s/.test(l))).toEqual(['# Spot Welder']);
  });
});
