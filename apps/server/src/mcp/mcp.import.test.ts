// MCP import parameters (spec §13, D65): origin, done_at, occurred_at.
import { describe, expect, it } from 'vitest';
import { startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const ORIGIN = 'migration 2026-11-27: PROGRESS.md@abc1234';

describe('MCP import parameters', () => {
  it('create_project imports done tasks and origin; get_project shows them', async () => {
    const m = await startMcp();
    const text = await m.ok('create_project', {
      name: 'Kiln',
      origin: ORIGIN,
      phases: [
        {
          title: 'Build',
          tasks: [
            { title: 'Frame', done: true, done_at: '2025-06-01' },
            { title: 'Wiring', notes: 'Use 2.5 mm²' },
            'Test fire',
          ],
        },
      ],
    });
    expect(text).toContain('Created project');
    const p = m.d.projects.get('kiln');
    expect(p.origin).toBe(ORIGIN);
    expect(p.phases[0]!.tasks.map((t) => [t.title, t.done, t.doneAt])).toEqual([
      ['Frame', true, '2025-06-01T12:00:00.000Z'],
      ['Wiring', false, null],
      ['Test fire', false, null],
    ]);
    expect(p.phases[0]!.tasks[1]!.notes).toBe('Use 2.5 mm²');
    expect(p.nextTask?.title).toBe('Wiring');
    expect(m.d.diary.list(p.id, { limit: 50 }).map((e) => e.eventKind)).toEqual([
      'project_created',
    ]);
    const detail = await m.ok('get_project', { project: 'kiln' });
    expect(detail).toContain(`Imported: ${ORIGIN}`);
  });

  it('log_progress backdates an entry with origin; get_diary marks it imported', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Kiln' });
    const r = await m.ok('log_progress', {
      project: 'kiln',
      body: 'Ordered the elements',
      occurred_at: '2025-05-20T09:00:00Z',
      origin: ORIGIN,
    });
    expect(r).toMatch(/Diary entry #\d+ saved/);
    const diary = await m.ok('get_diary', { project: 'kiln' });
    expect(diary).toContain(`imported (${ORIGIN})`);
    expect(diary).toContain('2025-05-20T09:00:00');
  });

  it('future times and done_at without done are tool errors that write nothing', async () => {
    const m = await startMcp();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const a = await m.call('create_project', {
      name: 'Nope',
      phases: [{ title: 'A', tasks: [{ title: 'x', done: true, done_at: future }] }],
    });
    expect(a.isError).toBe(true);
    const b = await m.call('create_project', {
      name: 'Nope',
      phases: [{ title: 'A', tasks: [{ title: 'x', done_at: '2025-01-01' }] }],
    });
    expect(b.isError).toBe(true);
    expect(m.d.projects.list().map((p) => p.name)).not.toContain('Nope');

    await m.ok('create_project', { name: 'Kiln' });
    const c = await m.call('log_progress', { project: 'kiln', body: 'x', occurred_at: future });
    expect(c.isError).toBe(true);
    expect(c.text).toContain('future');
    const d = await m.call('log_progress', {
      project: 'kiln',
      body: 'x',
      occurred_at: 'last week',
    });
    expect(d.isError).toBe(true);
  });
});
