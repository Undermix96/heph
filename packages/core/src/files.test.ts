import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { UPLOAD_TOKEN_TTL_MS } from './files.js';
import {
  CLAUDE,
  expectDomainError,
  expectDomainErrorAsync,
  seedProject,
  writeTemp,
} from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

// sharp's file cache keeps handles open, which blocks temp-dir cleanup on Windows.
sharp.cache(false);

let t: TestDomain;
afterEach(() => t?.cleanup());

function setup() {
  t = makeDomain();
  const p = seedProject(t.d);
  return { ...t, p };
}

/** A 40×20 JPEG with EXIF orientation 6 (rotate 90° CW) and a GPS position. */
async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: '#c33' } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: { Make: 'TestCam' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '45/1 30/1 0/1' },
      },
    })
    .toBuffer();
}

async function png(w = 8, h = 8): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#3c3' } })
    .png()
    .toBuffer();
}

describe('files: ingest', () => {
  it('re-encodes a JPEG: EXIF/GPS stripped, auto-rotated, thumbnail made', async () => {
    const { d, p } = setup();
    const input = await jpegWithExif();
    const inMeta = await sharp(input).metadata();
    expect(inMeta.orientation).toBe(6);
    expect(inMeta.exif).toBeDefined();

    const tmp = writeTemp(d, input);
    const f = await d.files.ingest(
      p.id,
      { tempPath: tmp, originalName: 'C:\\photos\\IMG_0001.JPG', caption: '  Front  ' },
      UI,
    );
    expect(f).toMatchObject({
      mime: 'image/jpeg',
      originalName: 'IMG_0001.JPG',
      caption: 'Front',
      width: 20,
      height: 40,
      hasThumbnail: true,
      source: 'ui',
      phaseId: null,
      taskId: null,
      diaryEntryId: null,
    });
    expect(fs.existsSync(tmp)).toBe(false);

    const stored = d.files.open(f.id);
    expect(stored.path.startsWith(t.filesDir)).toBe(true);
    const meta = await sharp(stored.path).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect(stored.size).toBe(fs.statSync(stored.path).size);

    const thumb = d.files.open(f.id, true);
    expect(thumb.mime).toBe('image/webp');
    expect(thumb.name).toBe('IMG_0001.webp');
    const tmeta = await sharp(thumb.path).metadata();
    expect(tmeta.format).toBe('webp');
    expect(tmeta.height).toBeGreaterThan(tmeta.width ?? 0);

    const ev = d.diary.list(p.id).find((e) => e.eventKind === 'file_uploaded');
    expect(ev?.data).toMatchObject({ fileId: f.id, mime: 'image/jpeg', target: 'project' });
  });

  it('stores a non-image as-is with the sniffed mime', async () => {
    const { d, p } = setup();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const f = await d.files.ingest(
      p.id,
      { tempPath: writeTemp(d, pdf), originalName: 'datasheet.bin', declaredMime: 'text/plain' },
      UI,
    );
    expect(f.mime).toBe('application/pdf');
    expect(f.hasThumbnail).toBe(false);
    expect(f.width).toBeNull();
    const o = d.files.open(f.id);
    expect(o.path.endsWith('.pdf')).toBe(true);
    expect(fs.readFileSync(o.path).equals(pdf)).toBe(true);
    expectDomainError(() => d.files.open(f.id, true), 'not_found');
  });

  it('falls back to the declared mime (normalized) when sniffing finds nothing', async () => {
    const { d, p } = setup();
    const f = await d.files.ingest(
      p.id,
      {
        tempPath: writeTemp(d, 'hello, world\n'),
        originalName: 'notes.TXT',
        declaredMime: 'Text/Plain; charset=utf-8',
      },
      UI,
    );
    expect(f.mime).toBe('text/plain');
    expect(d.files.open(f.id).path.endsWith('.txt')).toBe(true);
    const g = await d.files.ingest(
      p.id,
      { tempPath: writeTemp(d, 'x'), originalName: 'noext', declaredMime: 'garbage' },
      UI,
    );
    expect(g.mime).toBe('application/octet-stream');
  });

  it('rejects an empty file and removes the temp file', async () => {
    const { d, p } = setup();
    const tmp = writeTemp(d, '');
    await expectDomainErrorAsync(
      () => d.files.ingest(p.id, { tempPath: tmp, originalName: 'empty.txt' }, UI),
      'validation',
    );
    expect(fs.existsSync(tmp)).toBe(false);
    expect(d.files.list(p.id)).toHaveLength(0);
  });

  it('rejects files above maxUploadMb', async () => {
    const { d, p } = setup();
    d.settings.update({ maxUploadMb: 1 }, UI);
    const tmp = writeTemp(d, Buffer.alloc(1024 * 1024 + 1, 1));
    await expectDomainErrorAsync(
      () => d.files.ingest(p.id, { tempPath: tmp, originalName: 'big.bin' }, UI),
      'too_large',
    );
    expect(fs.existsSync(tmp)).toBe(false);
    const ok = writeTemp(d, Buffer.alloc(1024 * 1024, 1));
    await expect(
      d.files.ingest(p.id, { tempPath: ok, originalName: 'ok.bin' }, UI),
    ).resolves.toMatchObject({
      size: 1024 * 1024,
    });
  });

  it('rejects an undecodable image', async () => {
    const { d, p } = setup();
    const broken = Buffer.concat([(await png()).subarray(0, 40)]);
    await expectDomainErrorAsync(
      () => d.files.ingest(p.id, { tempPath: writeTemp(d, broken), originalName: 'x.png' }, UI),
      'validation',
    );
  });

  it('attaches to exactly one target of the same project', async () => {
    const { d, p } = setup();
    const taskId = p.phases[0]!.tasks[0]!.id;
    const phaseId = p.phases[0]!.id;
    await expectDomainErrorAsync(
      () =>
        d.files.ingest(
          p.id,
          { tempPath: writeTemp(d, 'a'), originalName: 'a.txt', target: { phaseId, taskId } },
          UI,
        ),
      'validation',
    );
    const other = seedProject(d, { name: 'Other' });
    await expectDomainErrorAsync(
      () =>
        d.files.ingest(
          p.id,
          {
            tempPath: writeTemp(d, 'a'),
            originalName: 'a.txt',
            target: { taskId: other.phases[0]!.tasks[0]!.id },
          },
          UI,
        ),
      'validation',
    );
    await expectDomainErrorAsync(
      () =>
        d.files.ingest(
          p.id,
          { tempPath: writeTemp(d, 'a'), originalName: 'a.txt', target: { taskId: 9999 } },
          UI,
        ),
      'not_found',
    );
    const f = await d.files.ingest(
      p.id,
      { tempPath: writeTemp(d, 'a'), originalName: 'a.txt', target: { taskId } },
      UI,
    );
    expect(f).toMatchObject({ taskId, phaseId: null, diaryEntryId: null });
    expect(d.files.list(p.id, { target: 'task', targetId: taskId }).map((x) => x.id)).toEqual([
      f.id,
    ]);
    expect(d.files.list(p.id, { target: 'project' })).toHaveLength(0);
  });

  it('removes the temp file when the target is rejected', async () => {
    const { d, p } = setup();
    const tmp = writeTemp(d, 'a');
    await d.files
      .ingest(
        p.id,
        {
          tempPath: tmp,
          originalName: 'a.txt',
          target: { phaseId: p.phases[0]!.id, taskId: p.phases[0]!.tasks[0]!.id },
        },
        UI,
      )
      .catch(() => undefined);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('is blocked for claude_code when write access is disabled', async () => {
    const { d, p } = setup();
    d.projects.update(p.id, { claudeWriteEnabled: false }, UI);
    await expectDomainErrorAsync(
      () => d.files.ingest(p.id, { tempPath: writeTemp(d, 'a'), originalName: 'a.txt' }, CLAUDE),
      'forbidden',
    );
  });
});

describe('files: retention, delete, detach', () => {
  async function upload(
    d: TestDomain['d'],
    projectId: number,
    name: string,
    ctx = CLAUDE,
    target = {},
  ) {
    t.clock.advance(1000);
    return d.files.ingest(
      projectId,
      { tempPath: writeTemp(d, await png()), originalName: name, target },
      ctx,
    );
  }

  it('keeps the last N unpinned claude_code files per target, never pinned ones', async () => {
    const { d, p } = setup();
    d.settings.update({ screenshotRetentionPerTarget: 2 }, UI);
    const taskId = p.phases[0]!.tasks[0]!.id;
    const pinned = await upload(d, p.id, 'pinned.png', CLAUDE, { taskId });
    d.files.update(pinned.id, { pinned: true }, UI);
    const byUser = await upload(d, p.id, 'user.png', UI, { taskId });
    const s1 = await upload(d, p.id, 's1.png', CLAUDE, { taskId });
    const s1Path = d.files.open(s1.id).path;
    const s1Thumb = d.files.open(s1.id, true).path;
    await upload(d, p.id, 's2.png', CLAUDE, { taskId });
    await upload(d, p.id, 's3.png', CLAUDE, { taskId });
    // Another target has its own budget.
    await upload(d, p.id, 'proj1.png');

    const names = d.files
      .list(p.id, { target: 'task', targetId: taskId })
      .map((f) => f.originalName)
      .sort();
    expect(names).toEqual(['pinned.png', 's2.png', 's3.png', 'user.png']);
    expect(d.files.get(byUser.id).id).toBe(byUser.id);
    expect(fs.existsSync(s1Path)).toBe(false);
    expect(fs.existsSync(s1Thumb)).toBe(false);
    expect(d.files.list(p.id, { target: 'project' }).map((f) => f.originalName)).toEqual([
      'proj1.png',
    ]);
    expect(d.files.list(p.id, { pinned: true }).map((f) => f.id)).toEqual([pinned.id]);
  });

  it('delete removes the row and the files on disk, and clears the cover', async () => {
    const { d, p } = setup();
    const f = await upload(d, p.id, 'cover.png', UI);
    d.projects.update(p.id, { coverFileId: f.id }, UI);
    expect(d.projects.get(p.id).coverFileId).toBe(f.id);
    const { path: abs } = d.files.open(f.id);
    const { path: thumb } = d.files.open(f.id, true);
    d.files.delete(f.id, UI);
    expect(fs.existsSync(abs)).toBe(false);
    expect(fs.existsSync(thumb)).toBe(false);
    expectDomainError(() => d.files.get(f.id), 'not_found');
    expect(d.projects.get(p.id).coverFileId).toBeNull();
  });

  it('cover must be an image of the same project', async () => {
    const { d, p } = setup();
    const txt = await d.files.ingest(
      p.id,
      { tempPath: writeTemp(d, 'hello'), originalName: 'a.txt', declaredMime: 'text/plain' },
      UI,
    );
    expectDomainError(() => d.projects.update(p.id, { coverFileId: txt.id }, UI), 'validation');
    const other = seedProject(d, { name: 'Other' });
    const img = await upload(d, other.id, 'x.png', UI);
    expectDomainError(() => d.projects.update(p.id, { coverFileId: img.id }, UI), 'validation');
  });

  it('deleting a task or a phase detaches its files to project level', async () => {
    const { d, p } = setup();
    const taskId = p.phases[0]!.tasks[0]!.id;
    const phaseId = p.phases[1]!.id;
    const onTask = await upload(d, p.id, 'task.png', UI, { taskId });
    const onPhase = await upload(d, p.id, 'phase.png', UI, { phaseId });
    const onPhaseTask = await upload(d, p.id, 'phase-task.png', UI, {
      taskId: p.phases[1]!.tasks[0]!.id,
    });
    d.roadmap.deleteTask(taskId, UI);
    expect(d.files.get(onTask.id)).toMatchObject({ taskId: null, phaseId: null });
    d.roadmap.deletePhase(phaseId, UI);
    expect(d.files.get(onPhase.id)).toMatchObject({ taskId: null, phaseId: null });
    expect(d.files.get(onPhaseTask.id)).toMatchObject({ taskId: null, phaseId: null });
    expect(fs.existsSync(d.files.open(onTask.id).path)).toBe(true);
    expect(d.files.list(p.id, { target: 'project' })).toHaveLength(3);
  });

  it('updates caption and pin', async () => {
    const { d, p } = setup();
    const f = await upload(d, p.id, 'a.png', UI);
    expect(d.files.update(f.id, { caption: '  hi ', pinned: true }, UI)).toMatchObject({
      caption: 'hi',
      pinned: true,
    });
    expect(d.files.update(f.id, { caption: '' }, UI).caption).toBeNull();
  });
});

describe('files: upload tokens', () => {
  it('are one-time and carry target, caption and context', () => {
    const { d, p } = setup();
    const taskId = p.phases[0]!.tasks[0]!.id;
    const { token, expiresAt } = d.files.createUploadToken(
      p.id,
      { target: { taskId }, caption: 'Screenshot' },
      CLAUDE,
    );
    expect(expiresAt).toBe(d.now() + UPLOAD_TOKEN_TTL_MS);
    const used = d.files.consumeUploadToken(token);
    expect(used).toEqual({
      projectId: p.id,
      target: { taskId },
      caption: 'Screenshot',
      ctx: { source: 'claude_code', sessionId: 'sess-1' },
    });
    expectDomainError(() => d.files.consumeUploadToken(token), 'not_found');
  });

  it('expire after the TTL', () => {
    const { d, p, clock } = setup();
    const a = d.files.createUploadToken(p.id, {}, CLAUDE);
    const b = d.files.createUploadToken(p.id, {}, CLAUDE);
    clock.advance(UPLOAD_TOKEN_TTL_MS - 1);
    expect(d.files.consumeUploadToken(a.token).target).toEqual({});
    clock.advance(1);
    expectDomainError(() => d.files.consumeUploadToken(b.token), 'not_found');
  });

  it('reject unknown tokens and invalid targets', () => {
    const { d, p } = setup();
    expectDomainError(() => d.files.consumeUploadToken('nope'), 'not_found');
    expectDomainError(
      () =>
        d.files.createUploadToken(
          p.id,
          { target: { phaseId: p.phases[0]!.id, taskId: p.phases[0]!.tasks[0]!.id } },
          CLAUDE,
        ),
      'validation',
    );
  });
});
