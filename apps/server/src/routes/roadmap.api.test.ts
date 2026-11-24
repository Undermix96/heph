const iso = (ms: number) => new Date(ms).toISOString();

import { afterEach, describe, expect, it } from 'vitest';
import { type Api, startApi } from '../test/api.js';

let t: Api | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

type Phase = { id: number; title: string; status: string; tasks: { id: number; title: string }[] };
const titles = (phases: Phase[]) => phases.map((p) => p.title);
const taskTitles = (p: Phase) => p.tasks.map((x) => x.title);

describe('phases', () => {
  it('adds, inserts at a position, updates and lists phases', async () => {
    t = await startApi();
    const p = await t.seed();
    const add = await t.agentReq('POST', `/api/projects/${p.slug}/phases`, {
      json: { title: 'Test', description: 'Bench tests' },
    });
    expect(add.status).toBe(201);
    expect(add.data).toMatchObject({
      title: 'Test',
      description: 'Bench tests',
      position: 2,
      status: 'todo',
      tasks: [],
      progress: { done: 0, total: 0, ratio: 0 },
    });
    const first = await t.uiReq('POST', `/api/projects/${p.id}/phases`, {
      json: { title: 'Research', position: 0 },
    });
    expect(first.status).toBe(201);
    expect(first.data.position).toBe(0);
    const list = await t.uiReq('GET', `/api/projects/${p.slug}/phases`);
    expect(titles(list.data)).toEqual(['Research', 'Design', 'Build', 'Test']);
    expect(list.data.map((x: { position: number }) => x.position)).toEqual([0, 1, 2, 3]);

    const upd = await t.agentReq('PATCH', `/api/phases/${add.data.id}`, {
      json: { title: 'Testing', status: 'in_progress' },
    });
    expect(upd.status).toBe(200);
    expect(upd.data).toMatchObject({ title: 'Testing', status: 'in_progress', completedAt: null });
    const done = await t.agentReq('PATCH', `/api/phases/${add.data.id}`, {
      json: { status: 'done' },
    });
    expect(done.data.status).toBe('done');
    expect(done.data.completedAt).toBe(iso(t.clock.now));

    for (const json of [{ title: '' }, { status: 'finished' }]) {
      const r = await t.agentReq('PATCH', `/api/phases/${add.data.id}`, { json });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
    expect(
      (await t.agentReq('POST', `/api/projects/${p.slug}/phases`, { json: { title: '' } })).status,
    ).toBe(400);
    expect(
      (
        await t.agentReq('POST', `/api/projects/${p.slug}/phases`, {
          json: { title: 'x', position: -1 },
        })
      ).status,
    ).toBe(400);
    expect((await t.agentReq('PATCH', '/api/phases/9999', { json: { title: 'x' } })).status).toBe(
      404,
    );
    expect(
      (await t.agentReq('POST', '/api/projects/nope/phases', { json: { title: 'x' } })).status,
    ).toBe(404);
  });

  it('moves phases (position clamped) and returns the new order', async () => {
    t = await startApi();
    const p = await t.seed();
    await t.uiReq('POST', `/api/projects/${p.slug}/phases`, { json: { title: 'Ship' } });
    const [design] = p.phases;
    const m = await t.agentReq('POST', `/api/phases/${design.id}/move`, { json: { position: 2 } });
    expect(m.status).toBe(200);
    expect(titles(m.data)).toEqual(['Build', 'Ship', 'Design']);
    const m2 = await t.agentReq('POST', `/api/phases/${design.id}/move`, {
      json: { position: 99 },
    });
    expect(titles(m2.data)).toEqual(['Build', 'Ship', 'Design']);
    const m3 = await t.agentReq('POST', `/api/phases/${design.id}/move`, { json: { position: 0 } });
    expect(titles(m3.data)).toEqual(['Design', 'Build', 'Ship']);
    expect(
      (await t.agentReq('POST', `/api/phases/${design.id}/move`, { json: { position: 'x' } }))
        .status,
    ).toBe(400);
    expect((await t.agentReq('POST', `/api/phases/${design.id}/move`, { json: {} })).status).toBe(
      400,
    );
    expect(
      (await t.agentReq('POST', '/api/phases/999/move', { json: { position: 0 } })).status,
    ).toBe(404);
  });

  it('DELETE: UI 204, agent 202 + proposal, agent confirmed 204', async () => {
    t = await startApi();
    const p = await t.seed();
    await t.uiReq('POST', `/api/projects/${p.slug}/phases`, { json: { title: 'Ship' } });
    const [design, build] = p.phases;

    const gated = await t.agentReq('DELETE', `/api/phases/${design.id}`, {
      json: { reason: 'Merged into Build' },
      headers: { 'x-heph-session-id': 'sess-d' },
    });
    expect(gated.status).toBe(202);
    expect(gated.data.proposal).toMatchObject({
      kind: 'delete_phase',
      payload: { phaseId: design.id, title: 'Design', taskCount: 2 },
      reason: 'Merged into Build',
      sessionId: 'sess-d',
      state: 'pending',
    });
    expect((await t.uiReq('GET', `/api/projects/${p.slug}/phases`)).data).toHaveLength(3);

    const confirmed = await t.agentReq('DELETE', `/api/phases/${design.id}`, {
      headers: { 'x-heph-confirmed': 'true' },
    });
    expect(confirmed.status).toBe(204);
    expect(confirmed.data).toBeNull();

    const ui = await t.uiReq('DELETE', `/api/phases/${build.id}`);
    expect(ui.status).toBe(204);
    const left = await t.uiReq('GET', `/api/projects/${p.slug}/phases`);
    expect(titles(left.data)).toEqual(['Ship']);
    expect(left.data[0].position).toBe(0);
    // Tasks went with their phase.
    expect((await t.uiReq('GET', `/api/tasks/${design.tasks[0].id}`)).status).toBe(404);
    expect((await t.uiReq('DELETE', `/api/phases/${build.id}`)).status).toBe(404);
  });
});

describe('tasks', () => {
  it('adds, reads and updates tasks', async () => {
    t = await startApi();
    const p = await t.seed();
    const phaseId = p.phases[0].id;
    const add = await t.agentReq('POST', `/api/phases/${phaseId}/tasks`, {
      json: { title: 'PCB layout', notes: 'Two layers', link: 'https://github.com/a/b/issues/1' },
    });
    expect(add.status).toBe(201);
    expect(add.data).toMatchObject({
      phaseId,
      projectId: p.id,
      title: 'PCB layout',
      notes: 'Two layers',
      link: 'https://github.com/a/b/issues/1',
      position: 2,
      done: false,
      doneAt: null,
    });
    const front = await t.agentReq('POST', `/api/phases/${phaseId}/tasks`, {
      json: { title: 'Front', position: 0 },
    });
    expect(front.data.position).toBe(0);
    const phases = (await t.uiReq('GET', `/api/projects/${p.slug}/phases`)).data;
    expect(taskTitles(phases[0])).toEqual(['Front', 'Schematic', 'BOM', 'PCB layout']);

    const get = await t.agentReq('GET', `/api/tasks/${add.data.id}`);
    expect(get.status).toBe(200);
    expect(get.data.title).toBe('PCB layout');

    const upd = await t.agentReq('PATCH', `/api/tasks/${add.data.id}`, {
      json: { title: 'PCB', link: null },
    });
    expect(upd.status).toBe(200);
    expect(upd.data).toMatchObject({ title: 'PCB', link: null, notes: 'Two layers' });

    for (const json of [{ title: '' }, { link: 'not-a-url' }, { notes: 5 }]) {
      const r = await t.agentReq('PATCH', `/api/tasks/${add.data.id}`, { json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
    expect((await t.agentReq('POST', `/api/phases/${phaseId}/tasks`, { json: {} })).status).toBe(
      400,
    );
    expect(
      (await t.agentReq('POST', '/api/phases/9999/tasks', { json: { title: 'x' } })).status,
    ).toBe(404);
    expect((await t.agentReq('PATCH', '/api/tasks/9999', { json: { title: 'x' } })).status).toBe(
      404,
    );
  });

  it('completes and reopens tasks, syncing phase status and writing diary events', async () => {
    t = await startApi();
    const p = await t.seed();
    const [schematic, bom] = p.phases[0].tasks.map((x: { id: number }) => x.id);

    const c1 = await t.agentReq('POST', `/api/tasks/${schematic}/complete`, {
      headers: { 'x-heph-session-id': 'sess-c' },
    });
    expect(c1.status).toBe(200);
    expect(c1.data.task).toMatchObject({ id: schematic, done: true, doneAt: iso(t.clock.now) });
    expect(c1.data.nextTask).toMatchObject({ id: bom, title: 'BOM' });
    let phases = (await t.uiReq('GET', `/api/projects/${p.slug}/phases`)).data;
    expect(phases[0].status).toBe('in_progress');

    // Completing twice is idempotent and adds no second event.
    expect((await t.agentReq('POST', `/api/tasks/${schematic}/complete`)).status).toBe(200);

    const c2 = await t.agentReq('POST', `/api/tasks/${bom}/complete`);
    expect(c2.data.nextTask).toMatchObject({ title: 'Case', phaseTitle: 'Build' });
    phases = (await t.uiReq('GET', `/api/projects/${p.slug}/phases`)).data;
    expect(phases[0].status).toBe('done');
    expect(phases[0].progress).toEqual({ done: 2, total: 2, ratio: 1 });
    const proj = (await t.uiReq('GET', `/api/projects/${p.slug}`)).data;
    expect(proj.currentPhase.title).toBe('Build');
    expect(proj.progress).toEqual({ done: 2, total: 4, ratio: 0.5 });

    const re = await t.uiReq('POST', `/api/tasks/${bom}/reopen`);
    expect(re.status).toBe(200);
    expect(re.data).toMatchObject({ id: bom, done: false, doneAt: null });
    phases = (await t.uiReq('GET', `/api/projects/${p.slug}/phases`)).data;
    expect(phases[0].status).toBe('in_progress');
    // Reopening an open task is a no-op.
    expect((await t.uiReq('POST', `/api/tasks/${bom}/reopen`)).status).toBe(200);

    const events = (await t.uiReq('GET', `/api/projects/${p.slug}/diary?type=event`)).data;
    const kinds = events.map((e: { eventKind: string }) => e.eventKind);
    expect(kinds.filter((k: string) => k === 'task_completed')).toHaveLength(2);
    expect(kinds.filter((k: string) => k === 'task_reopened')).toHaveLength(1);
    const first = events.find(
      (e: { eventKind: string; data: { taskId: number } }) =>
        e.eventKind === 'task_completed' && e.data.taskId === schematic,
    );
    expect(first).toMatchObject({ source: 'claude_code', sessionId: 'sess-c' });

    expect((await t.agentReq('POST', '/api/tasks/9999/complete')).status).toBe(404);
    expect((await t.agentReq('POST', '/api/tasks/9999/reopen')).status).toBe(404);
  });

  it('moves tasks within a phase and across phases of the same project', async () => {
    t = await startApi();
    const p = await t.seed();
    const [schematic, bom] = p.phases[0].tasks.map((x: { id: number }) => x.id);
    const buildId = p.phases[1].id;

    const within = await t.agentReq('POST', `/api/tasks/${bom}/move`, { json: { position: 0 } });
    expect(within.status).toBe(200);
    expect(taskTitles(within.data[0])).toEqual(['BOM', 'Schematic']);

    const across = await t.agentReq('POST', `/api/tasks/${schematic}/move`, {
      json: { phaseId: buildId, position: 1 },
    });
    expect(across.status).toBe(200);
    expect(taskTitles(across.data[0])).toEqual(['BOM']);
    expect(taskTitles(across.data[1])).toEqual(['Case', 'Schematic', 'Wiring']);
    expect(across.data[1].tasks.map((x: { position: number }) => x.position)).toEqual([0, 1, 2]);
    expect((await t.uiReq('GET', `/api/tasks/${schematic}`)).data.phaseId).toBe(buildId);

    // Completing the only task left in the first phase marks the phase done.
    await t.uiReq('POST', `/api/tasks/${bom}/complete`);
    const phases = (await t.uiReq('GET', `/api/projects/${p.slug}/phases`)).data;
    expect(phases[0].status).toBe('done');

    expect((await t.agentReq('POST', `/api/tasks/${bom}/move`, { json: {} })).status).toBe(400);
    expect(
      (await t.agentReq('POST', `/api/tasks/${bom}/move`, { json: { phaseId: 9999, position: 0 } }))
        .status,
    ).toBe(404);
  });

  it('refuses to move a task into another project (400) and leaves it in place', async () => {
    t = await startApi();
    const a = await t.seed();
    const b = await t.seed({ name: 'Other' });
    const task = a.phases[0].tasks[0].id;
    const r = await t.uiReq('POST', `/api/tasks/${task}/move`, {
      json: { phaseId: b.phases[0].id, position: 0 },
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('validation');
    expect((await t.uiReq('GET', `/api/tasks/${task}`)).data).toMatchObject({
      phaseId: a.phases[0].id,
      projectId: a.id,
    });
    expect((await t.uiReq('GET', `/api/projects/${b.slug}/phases`)).data[0].tasks).toHaveLength(2);
  });

  it('DELETE: UI 204, agent 202 + proposal, agent confirmed 204', async () => {
    t = await startApi();
    const p = await t.seed();
    const [schematic, bom] = p.phases[0].tasks.map((x: { id: number }) => x.id);
    const [caseT] = p.phases[1].tasks.map((x: { id: number }) => x.id);

    const gated = await t.agentReq('DELETE', `/api/tasks/${schematic}`, {
      json: { reason: 'Duplicate' },
    });
    expect(gated.status).toBe(202);
    expect(gated.data.proposal).toMatchObject({
      kind: 'delete_task',
      payload: { taskId: schematic, title: 'Schematic' },
      reason: 'Duplicate',
    });
    expect((await t.uiReq('GET', `/api/tasks/${schematic}`)).status).toBe(200);

    const confirmed = await t.agentReq('DELETE', `/api/tasks/${schematic}`, {
      headers: { 'x-heph-confirmed': 'true' },
    });
    expect(confirmed.status).toBe(204);
    expect((await t.uiReq('GET', `/api/tasks/${schematic}`)).status).toBe(404);
    const phases = (await t.uiReq('GET', `/api/projects/${p.slug}/phases`)).data;
    expect(
      phases[0].tasks.map((x: { id: number; position: number }) => [x.id, x.position]),
    ).toEqual([[bom, 0]]);

    // Deleting the overridden next task clears the override.
    await t.uiReq('PUT', `/api/projects/${p.slug}/next-task`, { json: { taskId: caseT } });
    expect((await t.uiReq('DELETE', `/api/tasks/${caseT}`)).status).toBe(204);
    const next = await t.uiReq('GET', `/api/projects/${p.slug}/next-task`);
    expect(next.data.nextTask).toMatchObject({ id: bom, overridden: false });
    expect((await t.uiReq('DELETE', `/api/tasks/${caseT}`)).status).toBe(404);
  });
});
