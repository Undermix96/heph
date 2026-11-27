import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';
import { seedProject, startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe('changes REST (D74)', () => {
  it('lists changes newest first and reverts one as the user', async () => {
    t = await startApi();
    const p = await t.seed();
    const bom = p.phases[0].tasks[1].id;
    expect((await t.uiReq('POST', `/api/tasks/${bom}/complete`)).status).toBe(200);
    const list = await t.uiReq('GET', `/api/projects/${p.slug}/changes?limit=5`);
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(5);
    const c = list.data[0];
    expect(c).toMatchObject({ entity: 'task', action: 'complete', label: 'BOM', revertible: true });

    const r = await t.uiReq('POST', `/api/changes/${c.id}/revert`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ id: c.id, revertible: false });
    expect(r.data.revertedAt).toBeTruthy();
    expect(t.d.roadmap.getTask(bom).done).toBe(false);

    // Keyset paging by id.
    const next = await t.uiReq('GET', `/api/projects/${p.slug}/changes?before=${c.id}&limit=200`);
    expect(next.data.every((x: { id: number }) => x.id < c.id)).toBe(true);
  });

  it('a blocked revert is a 409 naming the later change', async () => {
    t = await startApi();
    const p = await t.seed();
    const bom = p.phases[0].tasks[1].id;
    await t.uiReq('POST', `/api/tasks/${bom}/complete`);
    const done = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data[0];
    await t.uiReq('PATCH', `/api/tasks/${bom}`, { json: { notes: 'later' } });
    const edit = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data[0];
    const r = await t.uiReq('POST', `/api/changes/${done.id}/revert`);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatchObject({
      code: 'conflict',
      details: { reason: 'blocked', blockedBy: edit.id },
    });
  });

  it('the API token cannot revert (only the UI session)', async () => {
    t = await startApi();
    const p = await t.seed();
    await t.uiReq('POST', `/api/tasks/${p.phases[0].tasks[0].id}/complete`);
    const c = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data[0];
    for (const app of ['agent', 'ui'] as const) {
      const r = await t.agentReq('POST', `/api/changes/${c.id}/revert`, {}, app);
      expect(r.status, app).toBe(403);
    }
    // Reading the list with the token is fine.
    expect((await t.agentReq('GET', `/api/projects/${p.slug}/changes`)).status).toBe(200);
  });

  it('?revertible=true keeps revertible kinds, reverted ones included; GET one change', async () => {
    t = await startApi();
    const p = await t.seed();
    const bom = p.phases[0].tasks[1].id;
    await t.uiReq('POST', `/api/tasks/${bom}/complete`);
    await t.uiReq('POST', `/api/projects/${p.slug}/materials`, { json: { name: 'Glue' } });
    const all = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data;
    const done = all.find((c: { action: string }) => c.action === 'complete');
    await t.uiReq('POST', `/api/changes/${done.id}/revert`);
    const only = (await t.uiReq('GET', `/api/projects/${p.slug}/changes?revertible=true`)).data;
    expect(only.map((c: { id: number }) => c.id)).toEqual([done.id]);
    expect(only[0].revertedAt).toBeTruthy();
    const one = await t.uiReq('GET', `/api/changes/${done.id}`);
    expect(one.data).toMatchObject({ id: done.id, summary: 'Completed task "BOM"' });
  });

  it('bad paging parameters are a 400, unknown changes a 404', async () => {
    t = await startApi();
    const p = await t.seed();
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/changes?limit=0`)).status).toBe(400);
    expect((await t.uiReq('POST', '/api/changes/99999/revert')).status).toBe(404);
  });
});

describe('changes MCP (D75)', () => {
  it('list_changes shows ids and state; propose_revert creates a proposal only', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('complete_task', { task_id: s.tasks.bom.id, session_id: 'sess-r' });
    const list = await m.ok('list_changes', { project: s.slug, limit: 3 });
    const id = Number(/#(\d+) .*Completed task "BOM" · revertible/.exec(list)?.[1]);
    expect(id).toBeGreaterThan(0);
    expect(list).toContain('More: call again with before=');

    const out = await m.ok('propose_revert', {
      project: s.slug,
      change_id: id,
      reason: 'done by mistake',
      session_id: 'sess-r',
    });
    expect(out).toMatch(/Created proposal #\d+ \(revert_change\): Completed task "BOM"/);
    expect(m.d.roadmap.getTask(s.tasks.bom.id).done).toBe(true);
    const [prop] = m.d.proposals.list(s.id, 'pending');
    expect(prop).toMatchObject({ kind: 'revert_change', payload: { changeId: id } });

    m.d.proposals.approve(prop!.id, {}, { source: 'ui' });
    expect(m.d.roadmap.getTask(s.tasks.bom.id).done).toBe(false);
    expect(await m.ok('list_changes', { project: s.slug, limit: 50 })).toMatch(
      new RegExp(`#${id} .* · reverted `),
    );
  });

  it('propose_revert of a change that cannot be reverted is a tool error', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    const list = await m.ok('list_changes', { project: s.slug });
    const id = Number(/#(\d+) .*not revertible/.exec(list)?.[1]);
    const r = await m.call('propose_revert', { project: s.slug, change_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Error (validation)');
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
  });
});

describe("Claude's queue REST (D76)", () => {
  it('returns running sessions; `since` is required', async () => {
    t = await startApi();
    const p = await t.seed();
    t.insertLiveSession(p.id, 'sess-q', true);
    const since = new Date(t.clock.now - 3_600_000).toISOString();
    const r = await t.uiReq('GET', `/api/claude-queue?since=${encodeURIComponent(since)}`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      running: [{ sessionId: 'sess-q', projectSlug: p.slug, state: 'testing', lastEntry: null }],
      ended: [],
    });
    expect((await t.uiReq('GET', '/api/claude-queue')).status).toBe(400);
    // The token reads it too (same data as the dashboard).
    expect(
      (await t.agentReq('GET', `/api/claude-queue?since=${encodeURIComponent(since)}`)).status,
    ).toBe(200);
  });
});
