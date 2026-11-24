import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { type Api, type FilePart, multipart, startApi } from '../test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const png = (width = 40, height = 20) =>
  sharp({ create: { width, height, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();

/** A 60×30 JPEG with EXIF orientation 6 (rotate 90° CW) and GPS data. */
const jpegWithExif = () =>
  sharp({ create: { width: 60, height: 30, channels: 3, background: '#0f0' } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '45/1 30/1 0/1' } },
    })
    .toBuffer();

/** Raw request to the UI port with the session cookie (binary-safe). */
const raw = (path: string) => t!.ui.request(path, { headers: { cookie: t!.getCookie() } });

const uiUpload = (ref: string | number, files: FilePart[], fields: Record<string, string> = {}) =>
  t!.uiReq('POST', `/api/projects/${ref}/files`, { body: multipart(files, fields) });

const agentUpload = (
  ref: string | number,
  files: FilePart[],
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) => t!.agentReq('POST', `/api/projects/${ref}/files`, { body: multipart(files, fields), headers });

describe('multipart upload', () => {
  it('uploads several files with a caption (201) and logs diary events', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await uiUpload(
      p.slug,
      [
        { name: 'red.png', data: await png(), type: 'image/png' },
        { name: 'notes.txt', data: 'hello world', type: 'text/plain' },
        { name: 'dir/../../evil.bin', data: new Uint8Array([1, 2, 3]) },
      ],
      { caption: '  Bench  ' },
    );
    expect(r.status).toBe(201);
    expect(r.data).toHaveLength(3);
    expect(r.data[0]).toMatchObject({
      projectId: p.id,
      phaseId: null,
      taskId: null,
      diaryEntryId: null,
      originalName: 'red.png',
      mime: 'image/png',
      width: 40,
      height: 20,
      hasThumbnail: true,
      caption: 'Bench',
      pinned: false,
      source: 'ui',
    });
    expect(r.data[1]).toMatchObject({
      originalName: 'notes.txt',
      mime: 'text/plain',
      size: 11,
      width: null,
      hasThumbnail: false,
      caption: 'Bench',
    });
    // Path components are stripped from names.
    expect(r.data[2].originalName).toBe('evil.bin');
    expect(r.data[2].mime).toBe('application/octet-stream');

    const list = await t.agentReq('GET', `/api/projects/${p.slug}/files`);
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(3);
    const events = await t.uiReq('GET', `/api/projects/${p.slug}/diary?type=event`);
    expect(
      events.data.filter((e: { eventKind: string }) => e.eventKind === 'file_uploaded'),
    ).toHaveLength(3);
  });

  it('records the agent and its session on token uploads', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await agentUpload(
      p.id,
      [{ name: 'log.txt', data: 'x' }],
      {},
      {
        'x-heph-session-id': 'sess-up',
      },
    );
    expect(r.status).toBe(201);
    expect(r.data[0]).toMatchObject({ source: 'claude_code', sessionId: 'sess-up' });
  });

  it('attaches to a task, phase or diary entry target and filters by target', async () => {
    t = await startApi();
    const p = await t.seed();
    const taskId = p.phases[0].tasks[1].id;
    const phaseId = p.phases[1].id;
    const note = await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: 'n' } });

    const onTask = await uiUpload(p.slug, [{ name: 't.txt', data: 't' }], {
      taskId: String(taskId),
    });
    expect(onTask.status).toBe(201);
    expect(onTask.data[0]).toMatchObject({ taskId, phaseId: null, diaryEntryId: null });
    const onPhase = await uiUpload(p.slug, [{ name: 'p.txt', data: 'p' }], {
      phaseId: String(phaseId),
    });
    expect(onPhase.data[0].phaseId).toBe(phaseId);
    const onEntry = await uiUpload(p.slug, [{ name: 'd.txt', data: 'd' }], {
      diaryEntryId: String(note.data.id),
    });
    expect(onEntry.data[0].diaryEntryId).toBe(note.data.id);
    const onProject = await uiUpload(p.slug, [{ name: 'x.txt', data: 'x' }], { taskId: '' });
    expect(onProject.data[0].taskId).toBeNull();

    const ids = async (q: string) =>
      (await t!.uiReq('GET', `/api/projects/${p.slug}/files?${q}`)).data.map(
        (f: { id: number }) => f.id,
      );
    expect(await ids(`target=task&targetId=${taskId}`)).toEqual([onTask.data[0].id]);
    expect(await ids(`target=phase&targetId=${phaseId}`)).toEqual([onPhase.data[0].id]);
    expect(await ids(`target=diary_entry&targetId=${note.data.id}`)).toEqual([onEntry.data[0].id]);
    expect(await ids('target=project')).toEqual([onProject.data[0].id]);

    // The diary entry shows its file.
    const entry = await t.uiReq('GET', `/api/diary/${note.data.id}`);
    expect(entry.data.files.map((f: { id: number }) => f.id)).toEqual([onEntry.data[0].id]);
  });

  it('rejects bad targets: two targets, foreign or unknown ids, non-integers', async () => {
    t = await startApi();
    const p = await t.seed();
    const other = await t.seed({ name: 'Other' });
    const file = [{ name: 'a.txt', data: 'a' }];

    const two = await uiUpload(p.slug, file, {
      taskId: String(p.phases[0].tasks[0].id),
      phaseId: String(p.phases[0].id),
    });
    expect(two.status).toBe(400);
    expect(two.data.error.code).toBe('validation');
    const foreign = await uiUpload(p.slug, file, { taskId: String(other.phases[0].tasks[0].id) });
    expect(foreign.status).toBe(400);
    expect((await uiUpload(p.slug, file, { taskId: '99999' })).status).toBe(404);
    expect((await uiUpload(p.slug, file, { phaseId: 'abc' })).status).toBe(400);
    expect((await uiUpload(p.slug, file, { diaryEntryId: '-1' })).status).toBe(400);
    expect((await uiUpload('nope', file)).status).toBe(404);
    // Nothing was stored.
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/files`)).data).toEqual([]);
  });

  it('rejects non-multipart bodies, missing files and empty files (400)', async () => {
    t = await startApi();
    const p = await t.seed();
    const json = await t.uiReq('POST', `/api/projects/${p.slug}/files`, { json: { file: 'x' } });
    expect(json.status).toBe(400);
    expect(json.data.error.code).toBe('validation');
    const noBody = await t.uiReq('POST', `/api/projects/${p.slug}/files`);
    expect(noBody.status).toBe(400);
    const onlyFields = await t.uiReq('POST', `/api/projects/${p.slug}/files`, {
      body: multipart([], { caption: 'nothing' }),
    });
    expect(onlyFields.status).toBe(400);
    const garbage = await t.uiReq('POST', `/api/projects/${p.slug}/files`, {
      body: 'not really multipart',
      headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
    });
    expect(garbage.status).toBe(400);
    const empty = await uiUpload(p.slug, [{ name: 'empty.txt', data: '' }]);
    expect(empty.status).toBe(400);
    // A fake image that cannot be decoded.
    const fake = await uiUpload(p.slug, [
      { name: 'x.png', data: Buffer.concat([(await png()).subarray(0, 40), Buffer.alloc(50)]) },
    ]);
    expect(fake.status).toBe(400);
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/files`)).data).toEqual([]);
  });

  it('answers 413 for a file over maxUploadMb', async () => {
    t = await startApi();
    const p = await t.seed();
    expect((await t.uiReq('PATCH', '/api/settings', { json: { maxUploadMb: 1 } })).status).toBe(
      200,
    );
    const big = new Uint8Array(1024 * 1024 + 200_000).fill(65);
    const r = await uiUpload(p.slug, [
      { name: 'small.txt', data: 'ok' },
      { name: 'big.txt', data: big },
    ]);
    expect(r.status).toBe(413);
    expect(r.data.error.code).toBe('too_large');
    // Nothing from the request was stored.
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/files`)).data).toEqual([]);
    // Just under the limit is fine.
    const ok = await uiUpload(p.slug, [
      { name: 'fits.txt', data: big.subarray(0, 1024 * 1024 - 1) },
    ]);
    expect(ok.status).toBe(201);
  });

  it('accepts a file of exactly maxUploadMb', async () => {
    t = await startApi();
    const p = await t.seed();
    await t.uiReq('PATCH', '/api/settings', { json: { maxUploadMb: 1 } });
    const exact = new Uint8Array(1024 * 1024).fill(65);
    expect((await uiUpload(p.slug, [{ name: 'exact.txt', data: exact }])).status).toBe(201);
  });

  it('keeps non-ASCII filenames intact', async () => {
    t = await startApi();
    const p = await t.seed();
    const up = await uiUpload(p.slug, [{ name: 'Résumé.txt', data: 'cv', type: 'text/plain' }]);
    expect(up.data[0].originalName).toBe('Résumé.txt');
    const res = await raw(`/api/files/${up.data[0].id}/content`);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('filename="R_sum_.txt"');
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('Résumé.txt')}`);
  });

  it('strips EXIF (GPS) from JPEGs and applies the orientation', async () => {
    t = await startApi();
    const p = await t.seed();
    const input = await jpegWithExif();
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif).toBeDefined();
    expect(inMeta.orientation).toBe(6);

    const r = await uiUpload(p.slug, [{ name: 'photo.jpg', data: input, type: 'image/jpeg' }]);
    expect(r.status).toBe(201);
    expect(r.data[0]).toMatchObject({ mime: 'image/jpeg', width: 30, height: 60 });

    const res = await raw(`/api/files/${r.data[0].id}/content`);
    expect(res.status).toBe(200);
    const out = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(meta.width).toBe(30);
    expect(meta.height).toBe(60);
    expect(out.includes(Buffer.from('GPS'))).toBe(false);
    expect(Number(res.headers.get('content-length'))).toBe(out.length);
    expect(r.data[0].size).toBe(out.length);

    const thumb = await raw(`/api/files/${r.data[0].id}/thumbnail`);
    expect(thumb.status).toBe(200);
    const tmeta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(tmeta.format).toBe('webp');
    expect(tmeta.exif).toBeUndefined();
    expect([tmeta.width, tmeta.height]).toEqual([30, 60]);
  });
});

describe('file content and metadata', () => {
  it('serves content with safe headers', async () => {
    t = await startApi();
    const p = await t.seed();
    const up = await uiUpload(p.slug, [
      { name: 'red.png', data: await png(), type: 'image/png' },
      { name: 'notes.txt', data: 'hello', type: 'text/plain' },
      { name: 'page.html', data: '<script>alert(1)</script>', type: 'text/html' },
    ]);
    const [img, txt, html] = up.data.map((f: { id: number }) => f.id);

    const common = (res: Response) => {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    };

    const i = await raw(`/api/files/${img}/content`);
    expect(i.status).toBe(200);
    expect(i.headers.get('content-type')).toBe('image/png');
    expect(i.headers.get('content-disposition')).toMatch(/^inline; filename="red\.png"/);
    common(i);

    const d = await raw(`/api/files/${img}/content?download`);
    expect(d.headers.get('content-disposition')).toMatch(/^attachment;/);
    common(d);

    const tx = await raw(`/api/files/${txt}/content`);
    expect(tx.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(tx.headers.get('content-disposition')).toMatch(/^attachment; filename="notes\.txt"/);
    expect(await tx.text()).toBe('hello');
    common(tx);

    const h = await raw(`/api/files/${html}/content`);
    expect(h.headers.get('content-disposition')).toMatch(/^attachment;/);
    common(h);

    // Also over the agent port with the token.
    const viaAgent = await t.agent.request(`/api/files/${txt}/content`, {
      headers: { authorization: `Bearer ${t.token}` },
    });
    expect(viaAgent.status).toBe(200);
    expect(await viaAgent.text()).toBe('hello');
  });

  it('thumbnails exist only for images (404 otherwise)', async () => {
    t = await startApi();
    const p = await t.seed();
    const up = await uiUpload(p.slug, [
      { name: 'big.png', data: await png(1200, 600), type: 'image/png' },
      { name: 'notes.txt', data: 'hello' },
    ]);
    const th = await raw(`/api/files/${up.data[0].id}/thumbnail`);
    expect(th.status).toBe(200);
    expect(th.headers.get('content-type')).toBe('image/webp');
    expect(th.headers.get('content-disposition')).toMatch(/^inline; filename="big\.webp"/);
    const meta = await sharp(Buffer.from(await th.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([480, 240]);

    const none = await raw(`/api/files/${up.data[1].id}/thumbnail`);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect((await raw('/api/files/9999/thumbnail')).status).toBe(404);
    expect((await raw('/api/files/9999/content')).status).toBe(404);
  });

  it('PATCH sets pinned and caption; ?pinned filters', async () => {
    t = await startApi();
    const p = await t.seed();
    const up = await uiUpload(p.slug, [
      { name: 'a.txt', data: 'a' },
      { name: 'b.txt', data: 'b' },
    ]);
    const [a, b] = up.data.map((f: { id: number }) => f.id);
    const r = await t.agentReq('PATCH', `/api/files/${a}`, {
      json: { pinned: true, caption: ' Key shot ' },
    });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ id: a, pinned: true, caption: 'Key shot' });
    const cleared = await t.agentReq('PATCH', `/api/files/${a}`, { json: { caption: '' } });
    expect(cleared.data).toMatchObject({ pinned: true, caption: null });

    const pinned = await t.uiReq('GET', `/api/projects/${p.slug}/files?pinned=true`);
    expect(pinned.data.map((f: { id: number }) => f.id)).toEqual([a]);
    const unpinned = await t.uiReq('GET', `/api/projects/${p.slug}/files?pinned=false`);
    expect(unpinned.data.map((f: { id: number }) => f.id)).toEqual([b]);
    expect((await t.uiReq('GET', `/api/files/${a}`)).data.caption).toBeNull();

    expect((await t.agentReq('PATCH', `/api/files/${a}`, { json: { pinned: 'yes' } })).status).toBe(
      400,
    );
    expect((await t.agentReq('PATCH', '/api/files/9999', { json: {} })).status).toBe(404);
  });

  it('rejects an unknown ?target with 400', async () => {
    t = await startApi();
    const p = await t.seed();
    const r = await t.uiReq('GET', `/api/projects/${p.slug}/files?target=bogus`);
    expect(r.status).toBe(400);
  });

  it('DELETE removes the file (204); then GET, content and delete are 404', async () => {
    t = await startApi();
    const p = await t.seed();
    const up = await uiUpload(p.slug, [{ name: 'red.png', data: await png(), type: 'image/png' }]);
    const id = up.data[0].id;
    const before = fs.readdirSync(path.join(t.filesDir, String(p.id))).filter((f) => f !== 'tmp');
    expect(before.length).toBeGreaterThan(0);
    // Used as a cover, deleting it clears the cover.
    const cover = await t.uiReq('PATCH', `/api/projects/${p.slug}`, { json: { coverFileId: id } });
    expect(cover.data.coverFileId).toBe(id);

    const del = await t.agentReq('DELETE', `/api/files/${id}`);
    expect(del.status).toBe(204);
    expect((await t.uiReq('GET', `/api/files/${id}`)).status).toBe(404);
    expect((await raw(`/api/files/${id}/content`)).status).toBe(404);
    expect((await raw(`/api/files/${id}/thumbnail`)).status).toBe(404);
    expect((await t.agentReq('DELETE', `/api/files/${id}`)).status).toBe(404);
    expect((await t.uiReq('GET', `/api/projects/${p.slug}`)).data.coverFileId).toBeNull();
    const storedFiles = (dir: string): string[] =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap((e) =>
              e.isDirectory() ? storedFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
            )
        : [];
    expect(storedFiles(path.join(t.filesDir, String(p.id)))).toEqual([]);
  });

  it('only images of the same project can be the cover', async () => {
    t = await startApi();
    const p = await t.seed();
    const other = await t.seed({ name: 'Other' });
    const up = await uiUpload(p.slug, [{ name: 'a.txt', data: 'a' }]);
    const img = await uiUpload(other.slug, [{ name: 'i.png', data: await png() }]);
    expect(
      (await t.uiReq('PATCH', `/api/projects/${p.slug}`, { json: { coverFileId: up.data[0].id } }))
        .status,
    ).toBe(400);
    expect(
      (
        await t.uiReq('PATCH', `/api/projects/${p.slug}`, {
          json: { coverFileId: img.data[0].id },
        })
      ).status,
    ).toBe(400);
  });

  it('keeps only the last N unpinned Claude uploads per target', async () => {
    t = await startApi();
    const p = await t.seed();
    await t.uiReq('PATCH', '/api/settings', { json: { screenshotRetentionPerTarget: 2 } });
    const uiFile = await uiUpload(p.slug, [{ name: 'mine.txt', data: 'm' }]);
    const first = await agentUpload(p.slug, [{ name: 's1.txt', data: '1' }]);
    await t.agentReq('PATCH', `/api/files/${first.data[0].id}`, { json: { pinned: true } });
    const ids: number[] = [];
    for (let i = 2; i <= 5; i++) {
      t.clock.advance(1000);
      ids.push((await agentUpload(p.slug, [{ name: `s${i}.txt`, data: String(i) }])).data[0].id);
    }
    const left = (await t.uiReq('GET', `/api/projects/${p.slug}/files`)).data.map(
      (f: { id: number }) => f.id,
    );
    expect(left.sort()).toEqual([uiFile.data[0].id, first.data[0].id, ids[2], ids[3]].sort());
    expect((await t.uiReq('GET', `/api/files/${ids[0]}`)).status).toBe(404);
  });

  it('deleting a project removes its files from disk', async () => {
    t = await startApi();
    const p = await t.seed();
    await uiUpload(p.slug, [{ name: 'a.txt', data: 'a' }]);
    expect(fs.existsSync(path.join(t.filesDir, String(p.id)))).toBe(true);
    expect((await t.uiReq('DELETE', `/api/projects/${p.slug}`)).status).toBe(204);
    expect(fs.existsSync(path.join(t.filesDir, String(p.id)))).toBe(false);
  });
});

describe('one-time upload URLs', () => {
  const postUpload = (path: string, files: FilePart[], fields: Record<string, string> = {}) =>
    t!.agent.request(path, { method: 'POST', body: multipart(files, fields) });

  it('issues a one-time URL on the agent port that attaches to the requested target', async () => {
    t = await startApi();
    const p = await t.seed();
    const taskId = p.phases[0].tasks[0].id;
    const req = await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`, {
      json: { target: { taskId }, caption: 'Failing test' },
      headers: { 'x-heph-session-id': 'sess-u' },
    });
    expect(req.status).toBe(201);
    expect(req.data.path).toMatch(/^\/upload\/[A-Za-z0-9_-]{20,}$/);
    expect(req.data.url).toBe(`http://localhost${req.data.path}`);
    expect(req.data.expiresAt).toBe(new Date(t.clock.now + 60 * 60_000).toISOString());

    // Not served on the UI port.
    const onUi = await t.ui.request(req.data.path, {
      method: 'POST',
      body: multipart([{ name: 'x.txt', data: 'x' }]),
    });
    expect(onUi.status).toBe(404);

    const up = await postUpload(req.data.path, [
      { name: 'shot.png', data: await png(), type: 'image/png' },
    ]);
    expect(up.status).toBe(201);
    expect(await up.json()).toMatchObject({
      projectId: p.id,
      taskId,
      caption: 'Failing test',
      source: 'claude_code',
      sessionId: 'sess-u',
      mime: 'image/png',
    });

    const again = await postUpload(req.data.path, [{ name: 'y.txt', data: 'y' }]);
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect((await postUpload('/upload/not-a-token', [{ name: 'z.txt', data: 'z' }])).status).toBe(
      404,
    );
  });

  it('a caption field in the upload overrides the requested caption', async () => {
    t = await startApi();
    const p = await t.seed();
    const req = await t.uiReq('POST', `/api/projects/${p.slug}/upload-requests`, {
      json: { caption: 'Default' },
    });
    expect(req.status).toBe(201);
    const up = await postUpload(req.data.path, [{ name: 'a.txt', data: 'a' }], {
      caption: 'Override',
    });
    expect(await up.json()).toMatchObject({ caption: 'Override', source: 'ui', taskId: null });
  });

  it('expires after one hour', async () => {
    t = await startApi();
    const p = await t.seed();
    const a = await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`, { json: {} });
    const b = await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`);
    expect(b.status).toBe(201);
    t.clock.advance(60 * 60_000 - 1);
    expect((await postUpload(a.data.path, [{ name: 'a.txt', data: 'a' }])).status).toBe(201);
    t.clock.advance(1);
    expect((await postUpload(b.data.path, [{ name: 'b.txt', data: 'b' }])).status).toBe(404);
  });

  it('validates the requested target and respects oversize limits', async () => {
    t = await startApi();
    const p = await t.seed();
    const other = await t.seed({ name: 'Other' });
    const two = await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`, {
      json: { target: { taskId: p.phases[0].tasks[0].id, phaseId: p.phases[0].id } },
    });
    expect(two.status).toBe(400);
    expect(two.data.error.code).toBe('validation');
    const foreign = await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`, {
      json: { target: { phaseId: other.phases[0].id } },
    });
    expect(foreign.status).toBe(400);
    expect(
      (
        await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`, {
          json: { target: { taskId: 99999 } },
        })
      ).status,
    ).toBe(404);
    expect((await t.agentReq('POST', '/api/projects/nope/upload-requests')).status).toBe(404);

    await t.uiReq('PATCH', '/api/settings', { json: { maxUploadMb: 1 } });
    const req = await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`);
    const big = await postUpload(req.data.path, [
      { name: 'big.bin', data: new Uint8Array(1024 * 1024 + 1) },
    ]);
    expect(big.status).toBe(413);
    const notMultipart = await t.agent.request(
      (await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`)).data.path,
      { method: 'POST', body: 'plain', headers: { 'content-type': 'text/plain' } },
    );
    expect(notMultipart.status).toBe(400);
    // Only one file per one-time URL.
    const multi = await postUpload(
      (await t.agentReq('POST', `/api/projects/${p.slug}/upload-requests`)).data.path,
      [
        { name: 'a.txt', data: 'a' },
        { name: 'b.txt', data: 'b' },
      ],
    );
    expect(multi.status).toBe(400);
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/files`)).data).toEqual([]);
  });
});
