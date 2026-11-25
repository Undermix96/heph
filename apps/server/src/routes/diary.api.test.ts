import { afterEach, describe, expect, it } from 'vitest';
import { type Api, multipart, startApi } from '../test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

type Entry = {
  id: number;
  body: string;
  type: string;
  source: string;
  occurredAt: number;
  files: unknown[];
};
const bodies = (r: { data: Entry[] }) => r.data.map((e) => e.body);

describe('diary notes', () => {
  it('UI notes are type note; token notes with a session id are type session', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'Diary' });

    const ui = await t.uiReq('POST', `/api/projects/${p.slug}/diary`, {
      json: { body: '  Bought **parts**  ' },
    });
    expect(ui.status).toBe(201);
    expect(ui.data).toMatchObject({
      projectId: p.id,
      type: 'note',
      eventKind: null,
      body: 'Bought **parts**',
      source: 'ui',
      sessionId: null,
      files: [],
    });

    const session = await t.agentReq('POST', `/api/projects/${p.id}/diary`, {
      json: { body: 'Refactored the driver' },
      headers: { 'x-heph-session-id': 'sess-abc' },
    });
    expect(session.status).toBe(201);
    expect(session.data).toMatchObject({
      type: 'session',
      source: 'claude_code',
      sessionId: 'sess-abc',
    });

    const noSession = await t.agentReq('POST', `/api/projects/${p.id}/diary`, {
      json: { body: 'No session' },
    });
    expect(noSession.data).toMatchObject({ type: 'note', source: 'claude_code', sessionId: null });

    // A session header on the UI cookie path is ignored.
    const uiWithHeader = await t.uiReq('POST', `/api/projects/${p.id}/diary`, {
      json: { body: 'UI again' },
      headers: { 'x-heph-session-id': 'spoof' },
    });
    expect(uiWithHeader.data).toMatchObject({ type: 'note', source: 'ui', sessionId: null });

    // Overlong session ids are truncated to 200 characters.
    const long = await t.agentReq('POST', `/api/projects/${p.id}/diary`, {
      json: { body: 'Long id' },
      headers: { 'x-heph-session-id': 'x'.repeat(500) },
    });
    expect(long.data.sessionId).toHaveLength(200);

    const get = await t.agentReq('GET', `/api/diary/${session.data.id}`);
    expect(get.status).toBe(200);
    expect(get.data).toEqual(session.data);
  });

  it('validates notes', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'Diary' });
    for (const json of [
      {},
      { body: '' },
      { body: '   \n ' },
      { body: 3 },
      { body: 'x', fileIds: [0] },
    ]) {
      const r = await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
    const unknownFile = await t.uiReq('POST', `/api/projects/${p.slug}/diary`, {
      json: { body: 'x', fileIds: [12345] },
    });
    expect(unknownFile.status).toBe(400);
    expect(
      (await t.uiReq('POST', '/api/projects/nope/diary', { json: { body: 'x' } })).status,
    ).toBe(404);
  });

  it('attaches existing files of the same project, not of another one', async () => {
    t = await startApi();
    const a = await t.createProject({ name: 'A' });
    const b = await t.createProject({ name: 'B' });
    const upA = await t.uiReq('POST', `/api/projects/${a.slug}/files`, {
      body: multipart([{ name: 'a.txt', data: 'aaa', type: 'text/plain' }]),
    });
    const upB = await t.uiReq('POST', `/api/projects/${b.slug}/files`, {
      body: multipart([{ name: 'b.txt', data: 'bbb', type: 'text/plain' }]),
    });
    const note = await t.uiReq('POST', `/api/projects/${a.slug}/diary`, {
      json: { body: 'With file', fileIds: [upA.data[0].id] },
    });
    expect(note.status).toBe(201);
    expect(note.data.files).toHaveLength(1);
    expect(note.data.files[0]).toMatchObject({ id: upA.data[0].id, diaryEntryId: note.data.id });

    const foreign = await t.uiReq('POST', `/api/projects/${a.slug}/diary`, {
      json: { body: 'Foreign', fileIds: [upB.data[0].id] },
    });
    expect(foreign.status).toBe(400);
    // The failed note was not stored.
    const list = await t.uiReq('GET', `/api/projects/${a.slug}/diary?type=note`);
    expect(bodies(list)).toEqual(['With file']);
  });
});

describe('diary listing', () => {
  it('lists newest first and paginates with ?before and ?limit', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'Paged' });
    for (let i = 1; i <= 7; i++) {
      t.clock.advance(1000);
      await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: `n${i}` } });
    }
    const page1 = await t.agentReq('GET', `/api/projects/${p.slug}/diary?type=note&limit=3`);
    expect(page1.status).toBe(200);
    expect(bodies(page1)).toEqual(['n7', 'n6', 'n5']);
    const last1 = page1.data[2].occurredAt;
    const page2 = await t.agentReq(
      'GET',
      `/api/projects/${p.slug}/diary?type=note&limit=3&before=${last1}`,
    );
    expect(bodies(page2)).toEqual(['n4', 'n3', 'n2']);
    const page3 = await t.agentReq(
      'GET',
      `/api/projects/${p.slug}/diary?type=note&limit=3&before=${page2.data[2].occurredAt}`,
    );
    expect(bodies(page3)).toEqual(['n1']);

    // Default limit is 50; the project_created event is included without a type filter.
    const all = await t.agentReq('GET', `/api/projects/${p.slug}/diary`);
    expect(all.data).toHaveLength(8);
    expect(all.data[7].eventKind).toBe('project_created');

    for (const q of ['limit=0', 'limit=501', 'limit=abc', 'before=xyz', 'type=foo', 'source=bob']) {
      const r = await t.agentReq('GET', `/api/projects/${p.slug}/diary?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
  });

  it('does not lose entries that share a timestamp across a page boundary', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'Same ms' });
    t.clock.advance(1000);
    for (const body of ['a', 'b', 'c']) {
      await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body } });
    }
    const page1 = await t.uiReq('GET', `/api/projects/${p.slug}/diary?type=note&limit=2`);
    expect(bodies(page1)).toEqual(['c', 'b']);
    const page2 = await t.uiReq(
      'GET',
      `/api/projects/${p.slug}/diary?type=note&limit=2&before=${page1.data[1].occurredAt}&beforeId=${page1.data[1].id}`,
    );
    expect(bodies(page2)).toEqual(['a']);
  });

  it('filters by ?source, ?type and ?withFiles=true', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'Filters' });
    await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: 'ui note' } });
    await t.agentReq('POST', `/api/projects/${p.slug}/diary`, {
      json: { body: 'agent session' },
      headers: { 'x-heph-session-id': 's1' },
    });
    const up = await t.uiReq('POST', `/api/projects/${p.slug}/files`, {
      body: multipart([{ name: 'x.txt', data: 'x', type: 'text/plain' }]),
    });
    await t.uiReq('POST', `/api/projects/${p.slug}/diary`, {
      json: { body: 'with file', fileIds: [up.data[0].id] },
    });

    const bySource = await t.uiReq('GET', `/api/projects/${p.slug}/diary?source=claude_code`);
    expect(bodies(bySource)).toEqual(['agent session']);
    const sessions = await t.uiReq('GET', `/api/projects/${p.slug}/diary?type=session`);
    expect(bodies(sessions)).toEqual(['agent session']);
    const events = await t.uiReq('GET', `/api/projects/${p.slug}/diary?type=event`);
    expect(events.data.map((e: { eventKind: string }) => e.eventKind).sort()).toEqual([
      'file_uploaded',
      'project_created',
    ]);
    const withFiles = await t.uiReq('GET', `/api/projects/${p.slug}/diary?withFiles=true`);
    expect(bodies(withFiles)).toEqual(['with file']);
    expect(withFiles.data[0].files).toHaveLength(1);
    const combined = await t.uiReq('GET', `/api/projects/${p.slug}/diary?source=ui&type=note`);
    expect(bodies(combined)).toEqual(['with file', 'ui note']);
  });

  it('?withFiles=false does not restrict to entries with files', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'F' });
    await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: 'plain' } });
    const r = await t.uiReq('GET', `/api/projects/${p.slug}/diary?type=note&withFiles=false`);
    expect(bodies(r)).toEqual(['plain']);
  });

  it('GET /diary spans all projects; /diary/sessions/:id returns one session oldest first', async () => {
    t = await startApi();
    const a = await t.createProject({ name: 'A' });
    const b = await t.createProject({ name: 'B' });
    t.clock.advance(1000);
    await t.agentReq('POST', `/api/projects/${a.slug}/diary`, {
      json: { body: 'first in A' },
      headers: { 'x-heph-session-id': 'shared-sess' },
    });
    t.clock.advance(1000);
    await t.agentReq('POST', `/api/projects/${b.slug}/diary`, {
      json: { body: 'then in B' },
      headers: { 'x-heph-session-id': 'shared-sess' },
    });
    t.clock.advance(1000);
    await t.agentReq('POST', `/api/projects/${b.slug}/diary`, {
      json: { body: 'other session' },
      headers: { 'x-heph-session-id': 'other' },
    });
    // Task completion in a session is part of the session too.
    t.clock.advance(1000);
    const c = await t.createProject({ name: 'C', phases: [{ title: 'P', tasks: ['T'] }] });
    await t.agentReq('POST', `/api/tasks/${c.phases[0].tasks[0].id}/complete`, {
      headers: { 'x-heph-session-id': 'shared-sess' },
    });

    const all = await t.agentReq('GET', '/api/diary?type=session');
    expect(all.status).toBe(200);
    expect(bodies(all)).toEqual(['other session', 'then in B', 'first in A']);
    const projects = new Set(
      (await t.agentReq('GET', '/api/diary')).data.map((e: { projectId: number }) => e.projectId),
    );
    expect(projects).toEqual(new Set([a.id, b.id, c.id]));
    expect(bodies(await t.agentReq('GET', '/api/diary?type=session&limit=1'))).toEqual([
      'other session',
    ]);

    const sess = await t.uiReq('GET', '/api/diary/sessions/shared-sess');
    expect(sess.status).toBe(200);
    expect(sess.data.map((e: { body: string; type: string }) => [e.type, e.body])).toEqual([
      ['session', 'first in A'],
      ['session', 'then in B'],
      ['event', 'Completed task: T'],
    ]);
    expect((await t.uiReq('GET', '/api/diary/sessions/unknown')).data).toEqual([]);
  });

  it('the diary has no update or delete routes (append-only)', async () => {
    t = await startApi();
    const p = await t.createProject({ name: 'A' });
    const n = await t.uiReq('POST', `/api/projects/${p.slug}/diary`, { json: { body: 'keep' } });
    expect(
      (await t.uiReq('PATCH', `/api/diary/${n.data.id}`, { json: { body: 'x' } })).status,
    ).toBe(404);
    expect((await t.uiReq('DELETE', `/api/diary/${n.data.id}`)).status).toBe(404);
    expect((await t.uiReq('GET', `/api/diary/${n.data.id}`)).data.body).toBe('keep');
  });
});

describe('request body encoding (task #42)', () => {
  it('keeps UTF-8 text intact and refuses a body that is not UTF-8', async () => {
    const t = await startApi();
    try {
      const p = await t.seed();
      const text = 'Nota: più è già €';
      const ok = await t.agentReq('POST', `/api/projects/${p.id}/diary`, { json: { body: text } });
      expect(ok.status).toBe(201);
      expect(ok.data.body).toBe(text);
      const latin1 = new Uint8Array(Buffer.from(JSON.stringify({ body: 'più' }), 'latin1'));
      const res = await t.agent.request(`/api/projects/${p.id}/diary`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
        body: latin1,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation');
    } finally {
      t.cleanup();
    }
  });
});
