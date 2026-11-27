// link_repo and docs (D68): relinking updates the docs path; the first repo switches empty internal docs.
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { CLAUDE } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

describe('linkRepo and docs (D68)', () => {
  it('relinking the same repo updates docs path and showCommits', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Adr', repos: ['me/adr'] }, UI);
    const after = t.d.projects.linkRepo(
      p.id,
      { fullName: 'me/adr', docsPath: 'docs/adr/README.md', showCommits: false },
      CLAUDE,
    );
    expect(after.repoDetails).toHaveLength(1);
    expect(after.repoDetails[0]).toMatchObject({
      docsPath: 'docs/adr/README.md',
      showCommits: false,
    });
    // A plain relink changes nothing.
    const again = t.d.projects.linkRepo(p.id, 'me/adr', CLAUDE);
    expect(again.repoDetails[0]!.docsPath).toBe('docs/adr/README.md');
  });

  it('the first repo of a project with empty internal docs switches it to repo docs', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Late' }, UI);
    expect(p.docsSource).toBe('internal');
    expect(t.d.projects.linkRepo(p.id, 'me/late', CLAUDE).docsSource).toBe('repo');
  });

  it('internal docs with content are kept', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Kept' }, UI);
    t.d.projects.update(p.id, { internalDocs: '# Decisions\n\nD1' }, UI);
    const after = t.d.projects.linkRepo(p.id, 'me/kept', CLAUDE);
    expect(after.docsSource).toBe('internal');
    expect(after.internalDocs).toContain('D1');
  });
});
