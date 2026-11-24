import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { expectDomainErrorAsync, seedProject, writeTemp } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

// sharp's file cache keeps handles open, which blocks temp-dir cleanup on Windows.
sharp.cache(false);

let t: TestDomain;
let projectId: number;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  projectId = p.id;
  return { ...t, p };
}

function image(w: number, h: number, format: 'jpeg' | 'png' | 'gif'): Promise<Buffer> {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: '#36c' } });
  return (format === 'jpeg' ? img.jpeg() : format === 'png' ? img.png() : img.gif()).toBuffer();
}

async function upload(
  bytes: Buffer | string,
  originalName: string,
  declaredMime: string | null = null,
) {
  const tmp = writeTemp(t.d, bytes);
  return t.d.files.ingest(projectId, { tempPath: tmp, originalName, declaredMime }, UI);
}

describe('files.preview: images', () => {
  it('downscales a large JPEG to fit 1568 px and returns WebP', async () => {
    setup();
    const f = await upload(await image(3000, 2000, 'jpeg'), 'big.jpg');
    expect(f.mime).toBe('image/jpeg');
    const pv = await t.d.files.preview(f.id);
    expect(pv.kind).toBe('image');
    if (pv.kind !== 'image') return;
    expect(pv.mime).toBe('image/webp');
    const meta = await sharp(pv.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1568);
    expect(meta.height).toBeLessThanOrEqual(1568);
    expect(Math.abs((meta.height ?? 0) - Math.round((2000 * 1568) / 3000))).toBeLessThanOrEqual(1);
  });

  it('downscales a tall PNG by its height', async () => {
    setup();
    const f = await upload(await image(800, 2400, 'png'), 'tall.png');
    expect(f.mime).toBe('image/png');
    const pv = await t.d.files.preview(f.id);
    if (pv.kind !== 'image') throw new Error(`expected an image, got ${pv.kind}`);
    expect(pv.mime).toBe('image/webp');
    const meta = await sharp(pv.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.height).toBe(1568);
    expect(meta.width).toBeLessThanOrEqual(1568);
  });

  it('honours a custom maxEdge', async () => {
    setup();
    const f = await upload(await image(1000, 500, 'png'), 'wide.png');
    const pv = await t.d.files.preview(f.id, 200);
    if (pv.kind !== 'image') throw new Error('expected an image');
    const meta = await sharp(pv.data).metadata();
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  it('does not enlarge a small image', async () => {
    setup();
    const f = await upload(await image(120, 60, 'png'), 'small.png');
    const pv = await t.d.files.preview(f.id);
    if (pv.kind !== 'image') throw new Error('expected an image');
    expect(pv.mime).toBe('image/webp');
    const meta = await sharp(pv.data).metadata();
    expect([meta.width, meta.height]).toEqual([120, 60]);
  });

  it('an image exactly at the limit keeps its size', async () => {
    setup();
    const f = await upload(await image(1568, 10, 'jpeg'), 'edge.jpg');
    const pv = await t.d.files.preview(f.id);
    if (pv.kind !== 'image') throw new Error('expected an image');
    const meta = await sharp(pv.data).metadata();
    expect([meta.width, meta.height]).toEqual([1568, 10]);
  });

  it('a GIF is previewed as a WebP image', async () => {
    setup();
    const f = await upload(await image(40, 30, 'gif'), 'anim.gif');
    expect(f.mime).toBe('image/gif');
    const pv = await t.d.files.preview(f.id);
    if (pv.kind !== 'image') throw new Error('expected an image');
    expect(pv.mime).toBe('image/webp');
    const meta = await sharp(pv.data).metadata();
    expect([meta.width, meta.height]).toEqual([40, 30]);
  });
});

describe('files.preview: text and others', () => {
  it('returns a Markdown file as text (even without a declared type)', async () => {
    setup();
    const body = '# Notes\n\nCiao àèì — ok\n';
    const f = await upload(body, 'notes.md');
    expect(await t.d.files.preview(f.id)).toEqual({ kind: 'text', text: body });
  });

  it('returns a text/plain file as text', async () => {
    setup();
    const f = await upload('line 1\nline 2', 'log', 'text/plain');
    expect(f.mime).toBe('text/plain');
    expect(await t.d.files.preview(f.id)).toEqual({ kind: 'text', text: 'line 1\nline 2' });
  });

  it('returns JSON as text', async () => {
    setup();
    const f = await upload('{"a":1}', 'data', 'application/json');
    expect(await t.d.files.preview(f.id)).toEqual({ kind: 'text', text: '{"a":1}' });
  });

  it('text of exactly 100 KB is returned, over 100 KB is none', async () => {
    setup();
    const exact = await upload('a'.repeat(100 * 1024), 'exact.txt', 'text/plain');
    const pv = await t.d.files.preview(exact.id);
    expect(pv.kind).toBe('text');
    const big = await upload('a'.repeat(100 * 1024 + 1), 'big.md');
    const pv2 = await t.d.files.preview(big.id);
    expect(pv2.kind).toBe('none');
    if (pv2.kind === 'none') expect(pv2.reason).toContain('100 KB');
  });

  it('a binary file gives none', async () => {
    setup();
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 7 + 3) % 256));
    const f = await upload(bytes, 'blob.bin', 'application/octet-stream');
    const pv = await t.d.files.preview(f.id);
    expect(pv).toEqual({ kind: 'none', reason: 'binary file' });
  });

  it('a file missing on disk gives none', async () => {
    setup();
    const img = await upload(await image(50, 50, 'png'), 'gone.png');
    const txt = await upload('hello', 'gone.txt', 'text/plain');
    for (const f of [img, txt]) {
      fs.rmSync(t.d.files.open(f.id).path);
      expect(await t.d.files.preview(f.id)).toEqual({
        kind: 'none',
        reason: 'content missing on disk',
      });
    }
  });

  it('an unknown file id is not_found', async () => {
    setup();
    await expectDomainErrorAsync(() => t.d.files.preview(9999), 'not_found');
  });
});
