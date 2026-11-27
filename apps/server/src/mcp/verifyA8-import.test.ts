// Independent verification A8 (D65, D66): import parameters over MCP and REST. Data is invented.
import { describe, expect, it } from 'vitest';
import { startApi } from '../test/api.js';
import { startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const ORIGIN = 'migration 2026-11-20: docs/ROADMAP.md@1a2b3c4';

describe('A8 MCP: a realistic migration', () => {
  it('imports a mixed roadmap and a backdated diary, then normal use works', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'Forno a legna',
      origin: ORIGIN,
      repos: ['example/forno'],
      phases: [
        {
          title: 'Progetto',
          tasks: [
            { title: 'Disegno cupola', done: true, done_at: '2025-04-01' },
            { title: 'Calcolo mattoni', done: true, done_at: '2025-04-03T18:00:00+02:00' },
          ],
        },
        { title: 'Costruzione', tasks: ['Base', { title: 'Cupola', notes: 'Argilla + sabbia' }] },
        { title: 'Rifiniture' },
      ],
    });
    const p = m.d.projects.get('forno-a-legna');
    expect(p.phases.map((x) => x.status)).toEqual(['done', 'todo', 'todo']);
    expect(p.nextTask?.title).toBe('Base');

    for (const [body, at] of [
      ['Ordinati i mattoni refrattari', '2025-03-20'],
      ['Scavata la fondazione', '2025-05-02T07:00:00Z'],
      ['Primo fuoco di prova', '2025-06-10T20:00:00+02:00'],
    ]) {
      await m.ok('log_progress', {
        project: 'forno-a-legna',
        body,
        occurred_at: at,
        origin: ORIGIN,
        session_id: 'sess-import',
      });
    }
    const diary = await m.ok('get_diary', { project: 'forno-a-legna' });
    const order = ['Project created', 'Primo fuoco', 'Scavata', 'Ordinati'].map((s) =>
      diary.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(diary).toContain(`imported (${ORIGIN})`);

    const detail = await m.ok('get_project', { project: 'forno-a-legna' });
    expect(detail).toContain(`Imported: ${ORIGIN}`);

    // Normal use after the import.
    const base = p.phases[1]!.tasks[0]!;
    await m.ok('complete_task', { task_id: base.id, session_id: 'sess-1' });
    expect(m.d.roadmap.getPhase(p.phases[1]!.id).status).toBe('in_progress');
    const briefing = await m.ok('get_briefing', { project: 'forno-a-legna' });
    expect(briefing).toContain('Cupola');
  });

  it('get_briefing for an unlinked repo is an error that mentions the legacy marker', async () => {
    const m = await startMcp();
    const r = await m.call('get_briefing', { repo: 'example/not-linked' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Work state: legacy');
    expect(r.text).toContain('heph:migrate-project');
  });

  // A realistic slip: the agent uses the REST/camelCase spelling in an MCP call.
  // The value must not be silently dropped (the task would be stamped "now").
  it('camelCase doneAt in an MCP call is either honoured or refused, never dropped', async () => {
    const m = await startMcp();
    const r = await m.call('create_project', {
      name: 'Camel',
      phases: [{ title: 'A', tasks: [{ title: 'x', done: true, doneAt: '2025-01-10' }] }],
    });
    if (!r.isError) {
      const task = m.d.projects.get('camel').phases[0]!.tasks[0]!;
      expect(task.doneAt).toBe('2025-01-10T12:00:00.000Z');
    }
  });

  it('camelCase occurredAt in log_progress is either honoured or refused, never dropped', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Camel' });
    const r = await m.call('log_progress', {
      project: 'camel',
      body: 'Old note',
      occurredAt: '2025-01-10',
    });
    if (!r.isError) {
      const e = m.d.diary.list('camel', { limit: 5 }).find((x) => x.body === 'Old note')!;
      expect(e.occurredAt).toBe('2025-01-10T12:00:00.000Z');
    }
  });
});

describe('A8 REST: shared schemas', () => {
  it('POST /api/projects imports done tasks with doneAt and origin', async () => {
    const a = await startApi();
    const p = await a.createProject({
      name: 'Rest import',
      origin: ORIGIN,
      phases: [
        {
          title: 'A',
          tasks: [
            { title: 'Uno', done: true, doneAt: '2026-02-01' },
            { title: 'Due', done: true, doneAt: '2026-02-05T09:00:00+01:00' },
          ],
        },
      ],
    });
    expect(p.origin).toBe(ORIGIN);
    expect(p.phases[0].status).toBe('done');
    expect(p.phases[0].tasks.map((x: { doneAt: string }) => x.doneAt)).toEqual([
      '2026-02-01T12:00:00.000Z',
      '2026-02-05T08:00:00.000Z',
    ]);
  });

  it('POST /api/projects refuses bad import times with 400 and creates nothing', async () => {
    const a = await startApi();
    for (const task of [
      { title: 'x', doneAt: '2026-01-01' },
      { title: 'x', done: true, doneAt: '2026-02-30' },
      { title: 'x', done: true, doneAt: '2099-01-01' },
    ]) {
      const r = await a.uiReq('POST', '/api/projects', {
        json: { name: 'Bad', phases: [{ title: 'A', tasks: [task] }] },
      });
      expect(r.status).toBe(400);
    }
    expect(a.d.projects.list()).toHaveLength(0);
  });

  it('POST /api/projects/:ref/diary backdates with origin; future is 400', async () => {
    const a = await startApi();
    const p = await a.seed();
    const ok = await a.uiReq('POST', `/api/projects/${p.slug}/diary`, {
      json: { body: 'Vecchia nota', occurredAt: '2026-01-15', origin: ORIGIN },
    });
    expect(ok.status).toBe(201);
    expect(ok.data.occurredAt).toBe('2026-01-15T12:00:00.000Z');
    expect(ok.data.origin).toBe(ORIGIN);
    const bad = await a.uiReq('POST', `/api/projects/${p.slug}/diary`, {
      json: { body: 'Futuro', occurredAt: '2099-01-01T00:00:00Z' },
    });
    expect(bad.status).toBe(400);
    const list = await a.uiReq('GET', `/api/projects/${p.slug}/diary`);
    expect(list.data.map((e: { body: string }) => e.body)).not.toContain('Futuro');
    expect(list.data.at(-1).body).toBe('Vecchia nota');
  });
});
