const iso = (ms: number) => new Date(ms).toISOString();

import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Two projects with a few pending agent proposals. */
async function withProposals(api: Api) {
  const a = await api.seed({ name: 'A' });
  const b = await api.seed({ name: 'B' });
  const status = await api.agentReq('POST', `/api/projects/${a.slug}/status`, {
    json: { status: 'completed', note: 'Shipped', reason: 'All tasks done' },
    headers: { 'x-heph-session-id': 'sess-p' },
  });
  api.clock.advance(1000);
  const delTask = await api.agentReq('DELETE', `/api/tasks/${a.phases[0].tasks[0].id}`, {
    json: { reason: 'Obsolete' },
  });
  api.clock.advance(1000);
  const delPhase = await api.agentReq('DELETE', `/api/phases/${b.phases[1].id}`);
  for (const r of [status, delTask, delPhase]) expect(r.status).toBe(202);
  return {
    a,
    b,
    statusId: status.data.proposal.id as number,
    taskPropId: delTask.data.proposal.id as number,
    phasePropId: delPhase.data.proposal.id as number,
  };
}

describe('proposals', () => {
  it('lists proposals per project and globally, newest first, filtered by ?state', async () => {
    t = await startApi();
    const { a, b, statusId, taskPropId, phasePropId } = await withProposals(t);
    const ids = (r: { data: { id: number }[] }) => r.data.map((p) => p.id);

    const all = await t.agentReq('GET', '/api/proposals');
    expect(all.status).toBe(200);
    expect(ids(all)).toEqual([phasePropId, taskPropId, statusId]);
    expect(ids(await t.agentReq('GET', `/api/projects/${a.slug}/proposals`))).toEqual([
      taskPropId,
      statusId,
    ]);
    expect(ids(await t.agentReq('GET', `/api/projects/${b.id}/proposals`))).toEqual([phasePropId]);
    expect((await t.agentReq('GET', '/api/projects/nope/proposals')).status).toBe(404);

    expect((await t.uiReq('GET', `/api/projects/${a.slug}`)).data.pendingProposals).toBe(2);

    await t.uiReq('POST', `/api/proposals/${taskPropId}/reject`, { json: { note: 'Keep it' } });
    expect(ids(await t.uiReq('GET', '/api/proposals?state=pending'))).toEqual([
      phasePropId,
      statusId,
    ]);
    expect(ids(await t.uiReq('GET', '/api/proposals?state=rejected'))).toEqual([taskPropId]);
    expect(ids(await t.uiReq('GET', `/api/projects/${a.slug}/proposals?state=pending`))).toEqual([
      statusId,
    ]);
    expect(ids(await t.uiReq('GET', '/api/proposals?state=approved'))).toEqual([]);
    expect((await t.uiReq('GET', `/api/projects/${a.slug}`)).data.pendingProposals).toBe(1);

    const one = await t.agentReq('GET', `/api/proposals/${statusId}`);
    expect(one.status).toBe(200);
    expect(one.data).toMatchObject({
      projectId: a.id,
      kind: 'set_status',
      payload: { status: 'completed', note: 'Shipped' },
      reason: 'All tasks done',
      createdBy: 'claude_code',
      sessionId: 'sess-p',
      state: 'pending',
      decisionNote: null,
      decidedAt: null,
    });
  });

  it('rejects an unknown ?state with 400', async () => {
    t = await startApi();
    const r = await t.uiReq('GET', '/api/proposals?state=bogus');
    expect(r.status).toBe(400);
  });

  it('approving applies the change, records the decision and a diary event', async () => {
    t = await startApi();
    const { a, b, statusId, taskPropId, phasePropId } = await withProposals(t);

    const ok = await t.uiReq('POST', `/api/proposals/${statusId}/approve`, {
      json: { note: ' Well done ' },
    });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({
      state: 'approved',
      decisionNote: 'Well done',
      decidedAt: iso(t.clock.now),
    });
    const proj = await t.uiReq('GET', `/api/projects/${a.slug}`);
    expect(proj.data.lifecycleStatus).toBe('completed');
    expect(proj.data.statusNote).toBe('Shipped');

    const t1 = (await t.uiReq('POST', `/api/proposals/${taskPropId}/approve`)).data;
    expect(t1.state).toBe('approved');
    expect((await t.uiReq('GET', `/api/tasks/${a.phases[0].tasks[0].id}`)).status).toBe(404);

    expect((await t.uiReq('POST', `/api/proposals/${phasePropId}/approve`)).status).toBe(200);
    const phases = await t.uiReq('GET', `/api/projects/${b.slug}/phases`);
    expect(phases.data.map((p: { title: string }) => p.title)).toEqual(['Design']);

    const events = await t.uiReq('GET', `/api/projects/${a.slug}/diary?type=event`);
    const decided = events.data.filter(
      (e: { eventKind: string }) => e.eventKind === 'proposal_decided',
    );
    expect(decided).toHaveLength(2);
    expect(decided.every((e: { source: string }) => e.source === 'ui')).toBe(true);
    const statusEvent = events.data.find(
      (e: { eventKind: string }) => e.eventKind === 'status_changed',
    );
    expect(statusEvent.source).toBe('ui');
  });

  it('rejecting changes nothing; deciding twice is 409; unknown is 404', async () => {
    t = await startApi();
    const { a, statusId, taskPropId } = await withProposals(t);
    const rej = await t.uiReq('POST', `/api/proposals/${statusId}/reject`, {
      json: { note: 'Not yet' },
    });
    expect(rej.status).toBe(200);
    expect(rej.data).toMatchObject({ state: 'rejected', decisionNote: 'Not yet' });
    expect((await t.uiReq('GET', `/api/projects/${a.slug}`)).data.lifecycleStatus).toBe(
      'in_development',
    );

    for (const action of ['approve', 'reject']) {
      const again = await t.uiReq('POST', `/api/proposals/${statusId}/${action}`);
      expect(again.status).toBe(409);
      expect(again.data.error.code).toBe('conflict');
      expect((await t.uiReq('POST', `/api/proposals/9999/${action}`)).status).toBe(404);
    }
    expect((await t.uiReq('GET', '/api/proposals/9999')).status).toBe(404);
    const badNote = await t.uiReq('POST', `/api/proposals/${taskPropId}/reject`, {
      json: { note: 42 },
    });
    expect(badNote.status).toBe(400);
    expect((await t.uiReq('GET', `/api/proposals/${taskPropId}`)).data.state).toBe('pending');
  });

  it('approving a proposal whose target is gone fails without deciding it', async () => {
    t = await startApi();
    const { a, taskPropId } = await withProposals(t);
    // The user deletes the task directly first.
    expect((await t.uiReq('DELETE', `/api/tasks/${a.phases[0].tasks[0].id}`)).status).toBe(204);
    const r = await t.uiReq('POST', `/api/proposals/${taskPropId}/approve`);
    expect(r.status).toBe(404);
    expect((await t.uiReq('GET', `/api/proposals/${taskPropId}`)).data.state).toBe('pending');
    // It can still be rejected.
    expect((await t.uiReq('POST', `/api/proposals/${taskPropId}/reject`)).status).toBe(200);
  });
});
