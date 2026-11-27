// Independent verification B9: revert over REST and MCP end to end (D74, D75).
import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';
import { seedProject, startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

type C = {
  id: number;
  action: string;
  entity: string;
  revertible: boolean;
  revertedAt: string | null;
};

describe('B9 REST: auth', () => {
  it('the token cannot revert on either port, the UI session can; GET works for both', async () => {
    t = await startApi();
    const p = await t.seed();
    const bom = p.phases[0].tasks[1].id;
    await t.uiReq('POST', `/api/tasks/${bom}/complete`);
    const c = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data[0] as C;
    expect((await t.agentReq('GET', `/api/changes/${c.id}`)).status).toBe(200);
    expect((await t.agentReq('GET', `/api/changes/${c.id}`, {}, 'ui')).status).toBe(200);
    for (const app of ['agent', 'ui'] as const) {
      expect((await t.agentReq('POST', `/api/changes/${c.id}/revert`, {}, app)).status).toBe(403);
    }
    expect(t.d.roadmap.getTask(bom).done).toBe(true);
    // A change made over REST with the token is attributed to Claude and is revertible by the UI.
    await t.agentReq('PATCH', `/api/tasks/${bom}`, { json: { notes: 'agent' } });
    const edit = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data[0] as C;
    expect(edit.action).toBe('update');
    expect((await t.uiReq('POST', `/api/changes/${edit.id}/revert`)).status).toBe(200);
    expect(t.d.roadmap.getTask(bom).notes).toBe('');
  });

  it('reverting twice is a 409 already_reverted; a not revertible change is a 400', async () => {
    t = await startApi();
    const p = await t.seed();
    await t.uiReq('POST', `/api/tasks/${p.phases[0].tasks[0].id}/complete`);
    const all = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data as C[];
    const done = all.find((c) => c.action === 'complete')!;
    expect((await t.uiReq('POST', `/api/changes/${done.id}/revert`)).status).toBe(200);
    const again = await t.uiReq('POST', `/api/changes/${done.id}/revert`);
    expect(again.status).toBe(409);
    expect(again.data.error.details).toMatchObject({ reason: 'already_reverted' });
    const create = all.find((c) => !c.revertible)!;
    const r = await t.uiReq('POST', `/api/changes/${create.id}/revert`);
    expect(r.status).toBe(400);
    expect(r.data.error.details).toMatchObject({ reason: 'not_revertible' });
  });

  it('a change id of another project is reachable by id; list is per project', async () => {
    t = await startApi();
    const a = await t.seed();
    const b = await t.seed({ name: 'Other' });
    await t.uiReq('POST', `/api/tasks/${b.phases[0].tasks[0].id}/complete`);
    const listA = (await t.uiReq('GET', `/api/projects/${a.slug}/changes?limit=200`)).data as C[];
    const listB = (await t.uiReq('GET', `/api/projects/${b.slug}/changes?limit=200`)).data as C[];
    const ids = new Set(listA.map((c) => c.id));
    expect(listB.some((c) => ids.has(c.id))).toBe(false);
  });
});

describe('B9 REST: paging and filter', () => {
  it('pages cover every change exactly once, with and without the revertible filter', async () => {
    t = await startApi();
    const p = await t.seed();
    const [s, bom] = p.phases[0].tasks.map((x: { id: number }) => x.id);
    for (let i = 0; i < 7; i++) {
      await t.uiReq('PATCH', `/api/tasks/${s}`, { json: { notes: `n${i}` } });
      await t.uiReq('POST', `/api/projects/${p.slug}/materials`, { json: { name: `M${i}` } });
    }
    await t.uiReq('POST', `/api/tasks/${bom}/complete`);
    for (const filter of ['', '&revertible=true']) {
      const full = (await t.uiReq('GET', `/api/projects/${p.slug}/changes?limit=200${filter}`))
        .data as C[];
      const seen: number[] = [];
      let before: number | undefined;
      for (;;) {
        const q = `limit=3${filter}${before ? `&before=${before}` : ''}`;
        const page = (await t.uiReq('GET', `/api/projects/${p.slug}/changes?${q}`)).data as C[];
        seen.push(...page.map((c) => c.id));
        if (page.length < 3) break;
        before = page.at(-1)!.id;
      }
      expect(seen).toEqual(full.map((c) => c.id));
      expect([...seen].sort((x, y) => y - x)).toEqual(seen);
      if (filter) {
        expect(full.length).toBe(8); // 7 note edits + 1 completion
        expect(full.every((c) => c.entity !== 'material')).toBe(true);
      }
    }
  });

  it('revertible=false and junk values do not hide everything', async () => {
    t = await startApi();
    const p = await t.seed();
    const all = await t.uiReq('GET', `/api/projects/${p.slug}/changes`);
    const off = await t.uiReq('GET', `/api/projects/${p.slug}/changes?revertible=false`);
    expect(off.status).toBe(200);
    expect(off.data.length).toBe(all.data.length);
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/changes?before=abc`)).status).toBe(400);
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/changes?limit=201`)).status).toBe(400);
    expect((await t.uiReq('GET', '/api/projects/nope/changes')).status).toBe(404);
  });
});

describe('B9 MCP + UI approval', () => {
  it('propose_revert with confirmed: true still only proposes; the UI approves over REST', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('complete_task', { task_id: s.tasks.case.id, session_id: 'sess-b9' });
    const list = await m.ok('list_changes', { project: s.slug });
    const id = Number(/#(\d+) .*Completed task "Case" · revertible/.exec(list)?.[1]);
    const r = await m.call('propose_revert', {
      project: s.slug,
      change_id: id,
      reason: 'user said so',
      confirmed: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('Nothing is reverted');
    expect(m.d.roadmap.getTask(s.tasks.case.id).done).toBe(true);
    const props = m.d.proposals.list(s.id, 'pending');
    expect(props).toHaveLength(1);
    // The listing names Claude's session.
    expect(list).toMatch(/claude_code \(session sess-b9\)/);
  });

  it('a revert proposal approved via the REST UI route reverts; via the token it is 403', async () => {
    t = await startApi();
    const p = await t.seed();
    const bom = p.phases[0].tasks[1].id;
    await t.agentReq('POST', `/api/tasks/${bom}/complete`);
    const c = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data[0] as C;
    const prop = t.d.revert.propose(p.id, c.id, 'oops', { source: 'claude_code', sessionId: 's' });
    expect(
      (await t.agentReq('POST', `/api/proposals/${prop.id}/approve`, { json: {} })).status,
    ).toBe(403);
    expect(t.d.roadmap.getTask(bom).done).toBe(true);
    const ok = await t.uiReq('POST', `/api/proposals/${prop.id}/approve`, { json: {} });
    expect(ok.status).toBe(200);
    expect(ok.data.state).toBe('approved');
    expect(t.d.roadmap.getTask(bom).done).toBe(false);
  });

  it('approving a revert proposal that became blocked is a 409 and stays pending', async () => {
    t = await startApi();
    const p = await t.seed();
    const bom = p.phases[0].tasks[1].id;
    await t.uiReq('POST', `/api/tasks/${bom}/complete`);
    const c = (await t.uiReq('GET', `/api/projects/${p.slug}/changes`)).data[0] as C;
    const prop = t.d.revert.propose(p.id, c.id, '', { source: 'claude_code', sessionId: 's' });
    await t.uiReq('POST', `/api/tasks/${bom}/reopen`);
    const r = await t.uiReq('POST', `/api/proposals/${prop.id}/approve`, { json: {} });
    expect(r.status).toBe(409);
    expect(r.data.error.details).toMatchObject({ reason: 'blocked' });
    expect(t.d.proposals.get(prop.id).state).toBe('pending');
  });

  it('Claude write disabled: list_changes works, propose_revert is refused', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('complete_task', { task_id: s.tasks.bom.id });
    m.d.projects.update(s.id, { claudeWriteEnabled: false }, { source: 'ui' });
    const list = await m.ok('list_changes', { project: s.slug });
    const id = Number(/#(\d+) .*Completed task "BOM" · revertible/.exec(list)?.[1]);
    const r = await m.call('propose_revert', { project: s.slug, change_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/forbidden|disabled/i);
    expect(m.d.proposals.list(s.id)).toHaveLength(0);
  });

  it('propose_revert of a blocked change names the later change', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    await m.ok('complete_task', { task_id: s.tasks.bom.id });
    await m.ok('update_task', { task_id: s.tasks.bom.id, notes: 'later' });
    const list = await m.ok('list_changes', { project: s.slug });
    const id = Number(/#(\d+) .*Completed task "BOM"/.exec(list)?.[1]);
    const later = Number(/#(\d+) .*Edited task "BOM"/.exec(list)?.[1]);
    const r = await m.call('propose_revert', { project: s.slug, change_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`Revert change ${later} first`);
  });

  it('list_changes pages with before and prints no "More" on the last page', async () => {
    const m = await startMcp();
    const s = await seedProject(m);
    for (let i = 0; i < 4; i++)
      await m.ok('update_task', { task_id: s.tasks.bom.id, notes: `${i}` });
    const p1 = await m.ok('list_changes', { project: s.slug, limit: 2 });
    const before = Number(/before=(\d+)/.exec(p1)?.[1]);
    const ids1 = [...p1.matchAll(/^- #(\d+)/gm)].map((x) => Number(x[1]));
    const p2 = await m.ok('list_changes', { project: s.slug, limit: 2, before });
    const ids2 = [...p2.matchAll(/^- #(\d+)/gm)].map((x) => Number(x[1]));
    expect(Math.min(...ids1)).toBeGreaterThan(Math.max(...ids2));
    const all = await m.ok('list_changes', { project: s.slug, limit: 200 });
    expect(all).not.toContain('More:');
  });
});
