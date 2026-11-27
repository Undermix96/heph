// Independent verification B8 (D65, D66, D67): MCP import shapes and the tool calls the
// heph:migrate-project skill relies on. All data is invented.
import { describe, expect, it } from 'vitest';
import { startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const ORIGIN = 'migration 2026-11-20: ROADMAP.md@1a2b3c4';
const SID = 'sess-migrate-b8';

describe('B8: strict import shapes (A)', () => {
  it('camelCase doneAt in a task object is a tool error and creates nothing', async () => {
    const m = await startMcp();
    const r = await m.call('create_project', {
      name: 'Camel',
      phases: [{ title: 'A', tasks: [{ title: 'x', done: true, doneAt: '2025-01-10' }] }],
    });
    expect(r.isError).toBe(true);
    expect(m.d.projects.list()).toHaveLength(0);
  });

  it('other unknown keys in a task object (completed, date) are refused too', async () => {
    const m = await startMcp();
    for (const task of [
      { title: 'x', completed: true },
      { title: 'x', done: true, date: '2025-01-10' },
      { title: 'x', done: true, done_on: '2025-01-10' },
    ]) {
      const r = await m.call('create_project', {
        name: 'Unknown key',
        phases: [{ title: 'A', tasks: [task] }],
      });
      expect(r.isError).toBe(true);
    }
    expect(m.d.projects.list()).toHaveLength(0);
  });

  it('snake_case done_at still imports; done_at without done is refused', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'Snake',
      origin: ORIGIN,
      phases: [{ title: 'A', tasks: [{ title: 'x', done: true, done_at: '2025-01-10' }, 'y'] }],
    });
    const p = m.d.projects.get('snake');
    expect(p.phases[0]!.tasks[0]!.doneAt).toBe('2025-01-10T12:00:00.000Z');
    const bad = await m.call('create_project', {
      name: 'Forgot done',
      phases: [{ title: 'A', tasks: [{ title: 'x', done_at: '2025-01-10' }] }],
    });
    expect(bad.isError).toBe(true);
    expect(m.d.projects.list()).toHaveLength(1);
  });

  it('camelCase occurredAt or an unknown key in log_progress is an error and writes nothing', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Diary' });
    const before = m.d.diary.list('diary', { limit: 50 }).length;
    for (const extra of [
      { occurredAt: '2025-01-10' },
      { date: '2025-01-10' },
      { sessionId: SID },
    ]) {
      const r = await m.call('log_progress', { project: 'diary', body: 'Old note', ...extra });
      expect(r.isError).toBe(true);
    }
    expect(m.d.diary.list('diary', { limit: 50 })).toHaveLength(before);
  });

  it('backdated note from a session: type note, no session id, source claude_code', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Diary' });
    const text = await m.ok('log_progress', {
      project: 'diary',
      body: 'Imported 2025 note',
      occurred_at: '2025-03-02',
      origin: ORIGIN,
      session_id: SID,
    });
    expect(text).toContain('(note');
    const e = m.d.diary.list('diary', { limit: 50 }).find((x) => x.body === 'Imported 2025 note')!;
    expect(e.type).toBe('note');
    expect(e.sessionId).toBeNull();
    expect(e.source).toBe('claude_code');
    expect(e.origin).toBe(ORIGIN);
    expect(e.occurredAt).toBe('2025-03-02T12:00:00.000Z');
  });

  it('normal log_progress from a session is unchanged: type session with its id', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Diary' });
    const text = await m.ok('log_progress', { project: 'diary', body: 'Today', session_id: SID });
    expect(text).toContain('(session');
    const e = m.d.diary.list('diary', { limit: 50 }).find((x) => x.body === 'Today')!;
    expect(e.type).toBe('session');
    expect(e.sessionId).toBe(SID);
  });

  it('future-time errors explain the 12:00 UTC rule (today before noon)', async () => {
    const m = await startMcp();
    // Clock: 2026-11-24 12:00 UTC. Move to 08:00 UTC of the next day.
    m.t.clock.advance(20 * 3600_000);
    const today = '2026-11-25';
    const a = await m.call('create_project', {
      name: 'Today',
      phases: [{ title: 'A', tasks: [{ title: 'x', done: true, done_at: today }] }],
    });
    expect(a.isError).toBe(true);
    expect(a.text).toContain('12:00 UTC');
    expect(a.text).toMatch(/omit/);
    await m.ok('create_project', { name: 'Diary' });
    const b = await m.call('log_progress', { project: 'diary', body: 'x', occurred_at: today });
    expect(b.isError).toBe(true);
    expect(b.text).toContain('12:00 UTC');
    expect(b.text).toMatch(/omit/);
  });
});

// The rest of the import shape is not strict: a realistic slip silently drops data,
// the same class of problem verification A8 fixed for task objects.
describe('B8: non-strict levels of create_project (finding)', () => {
  it('a phase-level unknown key (e.g. status or done) is honoured or refused, never dropped', async () => {
    const m = await startMcp();
    const r = await m.call('create_project', {
      name: 'Phase keys',
      phases: [{ title: 'Research', status: 'done', tasks: [] }, { title: 'Build' }],
    });
    if (!r.isError) {
      const p = m.d.projects.get('phase-keys');
      expect(p.phases[0]!.status).toBe('done');
    }
  });

  it('a camelCase statusNote at top level is honoured or refused, never dropped', async () => {
    const m = await startMcp();
    const r = await m.call('create_project', {
      name: 'Top keys',
      status: 'on_hold',
      statusNote: 'Waiting for the PCB',
    });
    if (!r.isError) {
      expect(m.d.projects.get('top-keys').statusNote).toBe('Waiting for the PCB');
    }
  });
});

describe('B8: tool calls the migrate-project skill relies on (B)', () => {
  it('skill §3 ADR folder kept: link_repo with docs_path after create_project with repos', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Adr', repos: ['example/adr-app'], origin: ORIGIN });
    // The skill says "then link_repo with docs_path pointing to its index", but the repo
    // is already linked by create_project and create_project takes no docs_path over MCP.
    const r = await m.call('link_repo', {
      project: 'adr',
      repo: 'example/adr-app',
      docs_path: 'docs/adr/README.md',
    });
    expect(r.isError, r.text).toBe(false);
    // The call reports "Linked" but must also have applied docs_path.
    const docs = await m.ok('get_docs', { project: 'adr' });
    expect(docs).toContain('docs/adr/README.md');
  });

  it('alternative ADR flow: create_project without repos, then link_repo with docs_path, uses repo docs', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Adr', origin: ORIGIN });
    await m.ok('link_repo', {
      project: 'adr',
      repo: 'example/adr-app',
      docs_path: 'docs/adr/README.md',
    });
    const docs = await m.ok('get_docs', { project: 'adr' });
    expect(docs).toContain('docs/adr/README.md');
  });

  it('a done phase without tasks cannot be imported as done by create_project', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'Empty done',
      phases: [
        { title: 'Phase 0 research', description: 'Done 2025-02 (source: ROADMAP.md)' },
        { title: 'Phase 1', tasks: ['Build'] },
      ],
    });
    const p = m.d.projects.get('empty-done');
    // Documents the behaviour the skill must handle: the empty phase is the current one.
    expect(p.phases[0]!.status).toBe('todo');
    await m.ok('update_phase', { phase_id: p.phases[0]!.id, status: 'done', session_id: SID });
    expect(m.d.projects.get('empty-done').phases[0]!.status).toBe('done');
  });

  it('project without GitHub remote: internal docs via update_docs and get_docs', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Local only', origin: ORIGIN });
    await m.ok('update_docs', {
      project: 'local-only',
      body: '## D1 — Use SQLite (2025-01-01)\nDecision: ...',
      session_id: SID,
    });
    const docs = await m.ok('get_docs', { project: 'local-only' });
    expect(docs).toContain('D1 — Use SQLite');
  });

  it('set_next_task, set_status with note, and status at create work as the skill assumes', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'Next',
      phases: [{ title: 'A', tasks: ['One', 'Two'] }],
    });
    const p = m.d.projects.get('next');
    const two = p.phases[0]!.tasks[1]!;
    await m.ok('set_next_task', { project: 'next', task_id: two.id, session_id: SID });
    expect(m.d.projects.get('next').nextTask?.id).toBe(two.id);
    await m.ok('set_status', {
      project: 'next',
      status: 'awaiting_manual_test',
      note: 'Test the relay board',
      session_id: SID,
    });
    expect(m.d.projects.get('next').lifecycleStatus).toBe('awaiting_manual_test');
  });

  it('existing project: add_phase / add_task / complete_task accept no origin or done date', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Existing' });
    const ph = await m.call('add_phase', {
      project: 'existing',
      title: 'Imported',
      origin: ORIGIN,
    });
    // Non-strict input: origin is accepted and silently dropped (documents skill §5.1 gap).
    expect(ph.isError).toBe(false);
    const p = m.d.projects.get('existing');
    expect(p.phases[0]!.title).toBe('Imported');
  });

  it('skill §8: request_upload, upload the report, attach it with log_progress file_ids', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Upload' });
    const text = await m.ok('request_upload', {
      project: 'upload',
      caption: 'Migration report',
      session_id: SID,
    });
    const token = /\/upload\/([^\s]+)/.exec(text)?.[1];
    expect(token).toBeTruthy();
    const form = new FormData();
    form.append(
      'file',
      new Blob(['# Migration report (invented)\n| S1 | ROADMAP.md:1-3 |\n'], {
        type: 'text/markdown',
      }),
      'migration-upload.md',
    );
    const res = await fetch(`${m.base}/upload/${token}`, { method: 'POST', body: form });
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { id?: number; file?: { id: number } };
    const fileId = body.id ?? body.file?.id;
    expect(fileId).toBeTypeOf('number');
    const done = await m.ok('log_progress', {
      project: 'upload',
      body: 'Migration done',
      file_ids: [fileId],
      session_id: SID,
    });
    expect(done).toContain('1 file(s)');
  });
});
