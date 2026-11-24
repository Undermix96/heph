import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Mcp, seedProject, startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();
afterEach(() => {
  vi.unstubAllEnvs();
});

const HOUR = 60 * 60 * 1000;

/** Calls request_upload and extracts the one-time URL and curl command. */
async function requestUpload(m: Mcp, args: Record<string, unknown>) {
  const text = await m.ok('request_upload', args);
  const url = /^(http\S+\/upload\/\S+)$/m.exec(text)?.[1];
  const curl = /^curl .*$/m.exec(text)?.[0];
  if (!url || !curl) throw new Error(`unexpected request_upload text: ${text}`);
  return { text, url, curl };
}

async function upload(url: string, name: string, data: Uint8Array | string, type: string) {
  const form = new FormData();
  const bytes = typeof data === 'string' ? data : new Uint8Array(data);
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: test convenience
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text };
}

const png = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 20 } },
  })
    .png()
    .toBuffer();

describe('request_upload', () => {
  it('returns a one-time URL on the server origin and a curl command', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { text, url, curl } = await requestUpload(m, { project: s.id });
    expect(new URL(url).origin).toBe(m.base);
    expect(new URL(url).pathname).toMatch(/^\/upload\/[A-Za-z0-9_-]{16,}$/);
    expect(curl).toBe(`curl -sS -F "file=@<path-to-file>" ${url}`);
    expect(text).toMatch(/expires \d{4}-\d{2}-\d{2}T/);
    const expires = new Date(/expires (\S+)\):/.exec(text)![1]!).getTime();
    expect(expires).toBe(m.t.clock.now + HOUR);
    expect(text).toContain('log_progress file_ids');
  });

  it('uses HEPH_PUBLIC_AGENT_URL when it is set', async () => {
    vi.stubEnv('HEPH_PUBLIC_AGENT_URL', 'http://heph.lan:8081');
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, { project: s.id });
    expect(url.startsWith('http://heph.lan:8081/upload/')).toBe(true);
  });

  it('a multipart POST to the URL stores the file attributed to claude_code and the session', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, {
      project: s.id,
      task_id: s.tasks.case.id,
      caption: 'Case render',
      session_id: 'up-session-1',
    });
    const r = await upload(url, 'render.png', await png(64, 32), 'image/png');
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      projectId: s.id,
      taskId: s.tasks.case.id,
      originalName: 'render.png',
      caption: 'Case render',
      source: 'claude_code',
      sessionId: 'up-session-1',
      width: 64,
      height: 32,
    });
    const stored = m.d.files.get(r.json.id);
    expect(stored.source).toBe('claude_code');
    expect(stored.sessionId).toBe('up-session-1');
    expect(m.d.files.list(s.id).map((f) => f.id)).toContain(r.json.id);

    // The uploaded file can be attached to a diary entry.
    const log = await m.ok('log_progress', {
      project: s.id,
      body: 'Rendered the case',
      file_ids: [r.json.id],
      session_id: 'up-session-1',
    });
    expect(log).toContain('1 file(s)');
    expect(m.d.files.get(r.json.id).diaryEntryId).not.toBeNull();
    expect(await m.ok('get_project', { project: s.id })).toContain('Files: 1');
  });

  it('the URL works once and expires after an hour', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, { project: s.id });
    expect((await upload(url, 'a.txt', 'one', 'text/plain')).status).toBe(201);
    const again = await upload(url, 'b.txt', 'two', 'text/plain');
    expect(again.status).toBe(404);
    expect(m.d.files.list(s.id)).toHaveLength(1);

    const late = await requestUpload(m, { project: s.id });
    m.t.clock.advance(HOUR + 1);
    expect((await upload(late.url, 'c.txt', 'three', 'text/plain')).status).toBe(404);
    expect(m.d.files.list(s.id)).toHaveLength(1);
  });

  it('a forged token is refused', async () => {
    const m = await startMcp();
    const r = await upload(`${m.base}/upload/not-a-real-token`, 'x.txt', 'x', 'text/plain');
    expect(r.status).toBe(404);
  });

  it('an invalid target is a tool error', async () => {
    const m = await startMcp();
    const a = await seedProject(m, { name: 'Alpha' });
    const b = await seedProject(m, { name: 'Beta' });
    expect(
      (await m.call('request_upload', { project: a.id, task_id: b.tasks.bom.id })).isError,
    ).toBe(true);
    expect((await m.call('request_upload', { project: a.id, phase_id: 9999 })).isError).toBe(true);
    expect(
      (
        await m.call('request_upload', {
          project: a.id,
          phase_id: a.design.id,
          task_id: a.tasks.bom.id,
        })
      ).isError,
    ).toBe(true);
    expect((await m.call('request_upload', { project: 'ghost' })).text).toContain('not_found');
  });
});

describe('get_file', () => {
  it('returns a downscaled WebP image block plus a metadata text block for a PNG', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, { project: s.id, caption: 'Wide shot' });
    const up = await upload(url, 'wide.png', await png(2000, 1000), 'image/png');
    expect(up.status).toBe(201);

    const r = await m.call('get_file', { file_id: up.json.id });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(2);
    const [meta, image] = r.content as [
      { type: 'text'; text: string },
      { type: 'image'; data: string; mimeType: string },
    ];
    expect(meta.type).toBe('text');
    expect(meta.text).toContain(`File #${up.json.id} "wide.png"`);
    expect(meta.text).toContain('2000×1000');
    expect(meta.text).toContain('by claude_code');
    expect(meta.text).toContain('caption: Wide shot');
    expect(image.type).toBe('image');
    expect(image.mimeType).toBe('image/webp');
    const buf = Buffer.from(image.data, 'base64');
    const info = await sharp(buf).metadata();
    expect(info.format).toBe('webp');
    expect(Math.max(info.width!, info.height!)).toBeLessThanOrEqual(1568);
    expect(info.width).toBe(1568);
    expect(info.height).toBe(784);
  });

  it('does not enlarge small images', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, { project: s.id });
    const up = await upload(url, 'small.png', await png(100, 50), 'image/png');
    const r = await m.call('get_file', { file_id: up.json.id });
    const image = r.content[1] as { data: string };
    const info = await sharp(Buffer.from(image.data, 'base64')).metadata();
    expect([info.width, info.height]).toEqual([100, 50]);
  });

  it('returns the text of a small Markdown file', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, { project: s.id });
    const md = '# Test plan\n\n- Weld **two** strips\n- Measure résistance ✓\n';
    const up = await upload(url, 'plan.md', md, 'text/markdown');
    expect(up.status).toBe(201);
    const r = await m.call('get_file', { file_id: up.json.id });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect((r.content[0] as { text: string }).text).toContain('"plan.md"');
    expect(r.content[1]).toEqual({ type: 'text', text: md });
  });

  it('says "No preview" for a binary file', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, { project: s.id });
    const bytes = new Uint8Array(512).map((_, i) => (i * 37 + 11) % 256);
    const up = await upload(url, 'firmware.bin', bytes, 'application/octet-stream');
    expect(up.status).toBe(201);
    const r = await m.call('get_file', { file_id: up.json.id });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    expect(r.text).toContain(`File #${up.json.id} "firmware.bin"`);
    expect(r.text).toContain('No preview: binary file.');
  });

  it('unknown file id is a not_found tool error', async () => {
    const m = await startMcp();
    const r = await m.call('get_file', { file_id: 4242 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error (not_found)');
  });

  it('works on a project with Claude write access disabled (read only)', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const { url } = await requestUpload(m, { project: s.id });
    const up = await upload(url, 'n.txt', 'hello', 'text/plain');
    m.d.projects.update(s.id, { claudeWriteEnabled: false }, { source: 'ui' });
    const r = await m.call('get_file', { file_id: up.json.id });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('hello');
  });
});
