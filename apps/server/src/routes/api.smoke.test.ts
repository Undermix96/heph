import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApps } from '../test/app.js';

let apps: ReturnType<typeof makeApps> | undefined;
afterEach(() => apps?.cleanup());

describe('REST smoke', () => {
  it('runs the main project flow over HTTP', async () => {
    apps = makeApps();
    const t = apps;
    const token = await t.setup();

    const created = await t.uiReq('POST', '/api/projects', {
      json: {
        name: 'Lampada',
        tags: ['diy'],
        phases: [{ title: 'Build', tasks: ['Saldare', 'Montare'] }],
      },
    });
    expect(created.status).toBe(201);
    const slug = created.data.slug as string;
    const taskId = created.data.phases[0].tasks[0].id as number;

    const done = await t.tokenReq(token, 'POST', `/api/tasks/${taskId}/complete`, {
      headers: { 'x-heph-session-id': 'sess-1' },
    });
    expect(done.data.nextTask.title).toBe('Montare');

    const gated = await t.tokenReq(token, 'POST', `/api/projects/${slug}/status`, {
      json: { status: 'abandoned' },
    });
    expect(gated.status).toBe(202);
    expect(
      (await t.tokenReq(token, 'POST', `/api/proposals/${gated.data.proposal.id}/approve`)).status,
    ).toBe(403);
    expect(
      (
        await t.uiReq('POST', `/api/proposals/${gated.data.proposal.id}/reject`, {
          json: { note: 'no' },
        })
      ).status,
    ).toBe(200);

    const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('caption', 'red');
    form.append('file', new Blob([png], { type: 'image/png' }), 'red.png');
    const up = await t.uiReq('POST', `/api/projects/${slug}/files`, { body: form });
    expect(up.status).toBe(201);
    expect(up.data[0]).toMatchObject({
      mime: 'image/png',
      width: 40,
      hasThumbnail: true,
      caption: 'red',
    });

    const content = await t.ui.request(`/api/files/${up.data[0].id}/thumbnail`, {
      headers: { cookie: t.getCookie() },
    });
    expect(content.headers.get('content-type')).toBe('image/webp');

    const req = await t.tokenReq(token, 'POST', `/api/projects/${slug}/upload-requests`, {
      json: { caption: 'shot' },
    });
    expect(req.data.path).toMatch(/^\/upload\//);
    const form2 = new FormData();
    form2.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    const agentUp = await t.agent.request(req.data.path, { method: 'POST', body: form2 });
    expect(agentUp.status).toBe(201);
    expect(((await agentUp.json()) as { source: string }).source).toBe('claude_code');
    const form3 = new FormData();
    form3.append('file', new Blob(['again']), 'again.txt');
    expect((await t.agent.request(req.data.path, { method: 'POST', body: form3 })).status).toBe(
      404,
    );

    const diary = await t.uiReq('GET', `/api/projects/${slug}/diary`);
    expect(diary.data.map((e: { eventKind: string }) => e.eventKind)).toContain('task_completed');
    const search = await t.uiReq('GET', '/api/search?q=sald');
    expect(search.data[0].kind).toBe('task');
    expect((await t.uiReq('GET', '/api/needs-attention')).data[0].slug).toBe(slug);
  });
});
