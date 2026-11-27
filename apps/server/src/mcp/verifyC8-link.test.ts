// Independent verification C8 (D65, D68): link_repo replies and relinks over MCP, and the
// strict create_project shape. All data is invented.

import { UI } from '@heph/core';
import { describe, expect, it } from 'vitest';
import { startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const SID = 'sess-verify-c8';

describe('C8: link_repo over MCP (D68)', () => {
  it('relink by GitHub URL with docs_path: the reply names the path that was set', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Adr', repos: ['example/adr-app'] });
    const text = await m.ok('link_repo', {
      project: 'adr',
      repo: 'https://github.com/example/adr-app',
      docs_path: 'docs/adr/README.md',
    });
    expect(m.d.projects.get('adr').repoDetails[0]!.docsPath).toBe('docs/adr/README.md');
    expect(text).toContain('docs/adr/README.md');
  });

  it('first link by SSH URL with docs_path: the reply names the path that was set', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Ssh' });
    const text = await m.ok('link_repo', {
      project: 'ssh',
      repo: 'git@github.com:example/ssh-app.git',
      docs_path: 'docs/adr/README.md',
    });
    expect(text).toContain('Docs path: docs/adr/README.md');
  });

  it('plain relink keeps an ADR docs path set earlier', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Adr', repos: ['example/adr-app'] });
    await m.ok('link_repo', {
      project: 'adr',
      repo: 'example/adr-app',
      docs_path: 'docs/adr/README.md',
    });
    const text = await m.ok('link_repo', { project: 'adr', repo: 'example/adr-app' });
    expect(text).toContain('Docs path: docs/adr/README.md');
    expect(m.d.projects.get('adr').repoDetails[0]!.docsPath).toBe('docs/adr/README.md');
  });

  it('link to a repo of another project is an error and changes nothing', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Owner', repos: ['example/shared'] });
    await m.ok('create_project', { name: 'Thief' });
    const r = await m.call('link_repo', {
      project: 'thief',
      repo: 'example/shared',
      docs_path: 'other.md',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('owner');
    expect(m.d.projects.get('owner').repoDetails[0]!.docsPath).toBe('DECISIONS.md');
    expect(m.d.projects.get('thief').docsSource).toBe('internal');
  });

  it('first repo of a project with internal docs content: reply says docs stay internal', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Kept' });
    await m.ok('update_docs', { project: 'kept', body: '## D1 — Use SQLite\n', session_id: SID });
    const text = await m.ok('link_repo', { project: 'kept', repo: 'example/kept' });
    expect(text).toContain('Docs stay internal');
    expect(m.d.projects.get('kept').docsSource).toBe('internal');
  });

  it('project switched to internal by the user (empty docs), relink: reply does not claim content', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Chosen', repos: ['example/chosen'] });
    m.d.projects.update('chosen', { docsSource: 'internal' }, UI);
    const text = await m.ok('link_repo', { project: 'chosen', repo: 'example/chosen' });
    // The project has no internal docs, so "already has internal docs" is misleading.
    expect(text).not.toContain('already has internal docs');
  });
});

describe('C8: strict create_project (D68)', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['top-level statusNote', { statusNote: 'x' }],
    ['top-level repo (singular)', { repo: 'example/x' }],
    ['top-level docs_path', { docs_path: 'docs/adr/README.md' }],
    ['top-level sessionId', { sessionId: SID }],
    ['phase key task (singular)', { phases: [{ title: 'A', task: ['x'] }] }],
    ['phase key notes', { phases: [{ title: 'A', notes: 'x' }] }],
    ['phase key status', { phases: [{ title: 'A', status: 'done' }] }],
    ['task key note', { phases: [{ title: 'A', tasks: [{ title: 'x', note: 'n' }] }] }],
  ];
  for (const [label, extra] of bad) {
    it(`${label} is an error and creates nothing`, async () => {
      const m = await startMcp();
      const r = await m.call('create_project', { name: 'Strict', ...extra });
      expect(r.isError).toBe(true);
      expect(m.d.projects.list()).toHaveLength(0);
    });
  }

  it('every documented key still works together', async () => {
    const m = await startMcp();
    const text = await m.ok('create_project', {
      name: 'All keys',
      description: 'Invented project',
      tags: ['diy', 'firmware'],
      repos: ['example/all-keys'],
      links: [{ label: 'Docs', url: 'https://example.com/docs' }],
      phases: [
        {
          title: 'Done phase',
          description: 'Verified 2025-02',
          tasks: ['Plain', { title: 'Old', notes: 'n', done: true, done_at: '2025-01-10' }],
        },
        { title: 'Open', tasks: [{ title: 'Next', done: false }] },
        { title: 'Empty' },
      ],
      status: 'on_hold',
      status_note: 'Waiting for parts',
      origin: 'migration 2026-11-27: ROADMAP.md@abc1234',
      session_id: SID,
    });
    expect(text).toContain('Created project');
    const p = m.d.projects.get('all-keys');
    expect(p.tags.sort()).toEqual(['diy', 'firmware']);
    expect(p.repos).toEqual(['example/all-keys']);
    expect(p.links).toHaveLength(1);
    expect(p.phases).toHaveLength(3);
    expect(p.phases[0]!.tasks[1]!.doneAt).toBe('2025-01-10T12:00:00.000Z');
    expect(p.lifecycleStatus).toBe('on_hold');
    expect(p.statusNote).toBe('Waiting for parts');
    expect(p.origin).toBe('migration 2026-11-27: ROADMAP.md@abc1234');
  });

  it('a link object with an extra key is refused, not dropped (links are not strict)', async () => {
    const m = await startMcp();
    const r = await m.call('create_project', {
      name: 'Links',
      links: [{ label: 'Docs', url: 'https://example.com', title: 'Docs page' }],
    });
    // Finding if not an error: links still drop misspelled keys silently.
    expect(r.isError).toBe(true);
  });
});
