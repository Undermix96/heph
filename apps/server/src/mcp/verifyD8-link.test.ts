// Independent verification D8 (D68, D69): link_repo replies with URL forms, internal-docs
// reply, strict links in create_project. All data is invented.
import { describe, expect, it } from 'vitest';
import { startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

describe('D8: link_repo reply shows the stored docs path for every repo form', () => {
  const forms = [
    'https://github.com/example/adr-app',
    'https://github.com/Example/ADR-App.git',
    'https://github.com/example/adr-app/',
    'git@github.com:example/adr-app.git',
    'ssh://git@github.com/example/adr-app.git',
    '  example/adr-app  ',
    'example/adr-app.git',
  ];
  for (const repo of forms) {
    it(`relink as ${JSON.stringify(repo)} with docs_path`, async () => {
      const m = await startMcp();
      await m.ok('create_project', { name: 'Adr', repos: ['example/adr-app'] });
      const text = await m.ok('link_repo', {
        project: 'adr',
        repo,
        docs_path: 'docs/adr/README.md',
      });
      expect(text).toContain('Docs path: docs/adr/README.md.');
      expect(m.d.projects.get('adr').repos).toHaveLength(1);
    });

    it(`first link as ${JSON.stringify(repo)} with docs_path`, async () => {
      const m = await startMcp();
      await m.ok('create_project', { name: 'New' });
      const text = await m.ok('link_repo', { project: 'new', repo, docs_path: 'docs/x.md' });
      expect(text).toContain('Docs path: docs/x.md.');
    });
  }

  it('second repo with its own docs path: reply names that repo path, not the first', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Two', repos: ['example/one'] });
    const text = await m.ok('link_repo', {
      project: 'two',
      repo: 'https://github.com/example/two',
      docs_path: 'docs/two.md',
    });
    expect(text).toContain('Docs path: docs/two.md.');
  });

  it('internal docs: the reply explains update_docs and shows no docs path', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Kept' });
    await m.ok('update_docs', { project: 'kept', body: '## D1 — Invented\n' });
    const text = await m.ok('link_repo', { project: 'kept', repo: 'example/kept' });
    expect(text).toContain('update_docs');
    expect(text).not.toContain('Docs path');
  });

  it('first repo with empty internal docs: reply shows the default docs path', async () => {
    const m = await startMcp();
    await m.ok('create_project', { name: 'Empty' });
    const text = await m.ok('link_repo', { project: 'empty', repo: 'example/empty' });
    expect(text).toContain('Docs path: DECISIONS.md.');
    expect(m.d.projects.get('empty').docsSource).toBe('repo');
  });
});

describe('D8: create_project links are strict', () => {
  it('a misspelled link key is an error and creates nothing', async () => {
    const m = await startMcp();
    const r = await m.call('create_project', {
      name: 'L',
      links: [{ label: 'Docs', href: 'https://example.com' }],
    });
    expect(r.isError).toBe(true);
    expect(m.d.projects.list()).toHaveLength(0);
  });

  it('a valid link still works', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'L',
      links: [{ label: 'Docs', url: 'https://example.com' }],
    });
    expect(m.d.projects.get('l').links).toHaveLength(1);
  });
});
