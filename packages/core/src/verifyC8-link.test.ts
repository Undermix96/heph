// Independent verification C8 (D63, D68): linkRepo on an already-linked repo, the first-repo
// docs switch, and their interaction with GitHub sync, the Stop-hook docs upload and the
// briefing. All repos and content are invented.
import { afterEach, describe, expect, it } from 'vitest';
import { UI } from './context.js';
import { changeLog } from './db/schema.js';
import { FakeGitHub } from './test/fake-github.js';
import { CLAUDE, expectDomainError } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const REPO = 'example/adr-app';
const SID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function setup() {
  t = makeDomain();
  t.d.settings.update({ githubToken: 'invented-token' }, UI);
  const gh = new FakeGitHub();
  gh.add(REPO);
  gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: '# Root decisions\n', commits: [] };
  gh.repos.get(REPO)!.files['docs/adr/README.md'] = { text: '# ADR index\n', commits: [] };
  const p = t.d.projects.create({ name: 'Adr', repos: [REPO] }, UI);
  const row = () => t.d.projects.repoRows(p.id)[0]!;
  return { d: t.d, gh, p, row };
}

describe('C8: relink of an already-linked repo (D68)', () => {
  it('relink with a new docs path: next sync fetches the new file, not the old cache', async () => {
    const { d, gh, p, row } = setup();
    await d.github.syncDue(gh);
    expect(row().docsContent).toBe('# Root decisions\n');
    d.projects.linkRepo(p.id, { fullName: REPO, docsPath: 'docs/adr/README.md' }, CLAUDE);
    expect(row()).toMatchObject({ docsPath: 'docs/adr/README.md', docsContent: null });
    t.clock.advance(60 * 60_000);
    await d.github.syncDue(gh);
    expect(row().docsContent).toBe('# ADR index\n');
    expect(d.projects.repoRows(p.id)).toHaveLength(1);
  });

  it('relink with the SAME docs path keeps the cached docs', async () => {
    const { d, gh, p, row } = setup();
    await d.github.syncDue(gh);
    d.projects.linkRepo(p.id, { fullName: REPO, docsPath: 'DECISIONS.md' }, CLAUDE);
    expect(row().docsContent).toBe('# Root decisions\n');
  });

  it('plain relink (object with undefined fields, as MCP sends it) changes nothing', async () => {
    const { d, gh, p, row } = setup();
    d.projects.linkRepo(p.id, { fullName: REPO, docsPath: 'docs/adr/README.md' }, CLAUDE);
    t.clock.advance(60 * 60_000);
    await d.github.syncDue(gh);
    const before = row();
    d.projects.linkRepo(
      p.id,
      { fullName: REPO, docsPath: undefined, showCommits: undefined },
      CLAUDE,
    );
    const after = row();
    expect(after.docsPath).toBe('docs/adr/README.md');
    expect(after.docsContent).toBe(before.docsContent);
    expect(after.showCommits).toBe(before.showCommits);
  });

  it('relink by URL or different case updates the same row', () => {
    const { d, p, row } = setup();
    d.projects.linkRepo(
      p.id,
      { fullName: 'https://github.com/Example/ADR-App', docsPath: 'docs/adr/README.md' },
      CLAUDE,
    );
    expect(d.projects.repoRows(p.id)).toHaveLength(1);
    expect(row().docsPath).toBe('docs/adr/README.md');
  });

  it('a repo linked to another project is a conflict and changes neither project', () => {
    const { d, p, row } = setup();
    const other = d.projects.create({ name: 'Other' }, UI);
    expectDomainError(
      () => d.projects.linkRepo(other.id, { fullName: REPO, docsPath: 'x.md' }, CLAUDE),
      'conflict',
    );
    expect(row().docsPath).toBe('DECISIONS.md');
    expect(d.projects.get(other.id).docsSource).toBe('internal');
    expect(d.projects.get(other.id).repos).toEqual([]);
    expect(d.projects.get(p.id).repos).toHaveLength(1);
  });

  it('Stop hook after a path change: old path refused, new path stored, briefing shows it', () => {
    const { d, p } = setup();
    d.hooks.sessionStart(SID, { remote: `git@github.com:${REPO}.git`, head: 'a1' });
    d.projects.linkRepo(p.id, { fullName: REPO, docsPath: 'docs/adr/README.md' }, CLAUDE);
    expect(d.hooks.docsTarget(SID)?.path).toBe('docs/adr/README.md');
    expectDomainError(
      () => d.hooks.storeDocs(SID, 'DECISIONS.md', Buffer.from('# old\n')),
      'conflict',
    );
    expect(d.hooks.storeDocs(SID, 'docs/adr/README.md', Buffer.from('# local\n'))).toBe(true);
    const b = d.briefing.build({ project: p.id });
    expect(b).toContain('`docs/adr/README.md`');
  });
});

describe('C8: first repo and internal docs (D68)', () => {
  it('a project with empty internal docs links: Stop hook and sync then use repo docs', async () => {
    t = makeDomain();
    const { d } = t;
    d.settings.update({ githubToken: 'invented-token' }, UI);
    const gh = new FakeGitHub();
    gh.add(REPO);
    gh.repos.get(REPO)!.files['DECISIONS.md'] = { text: '# D\n', commits: [] };
    const p = d.projects.create({ name: 'Late' }, UI);
    d.projects.linkRepo(p.id, REPO, CLAUDE);
    expect(d.projects.get(p.id).docsSource).toBe('repo');
    await d.github.syncDue(gh);
    expect(d.projects.docs(p.id).repos[0]?.content).toBe('# D\n');
    d.hooks.sessionStart(SID, { remote: `git@github.com:${REPO}.git`, head: 'a1' });
    expect(d.hooks.docsTarget(SID)?.path).toBe('DECISIONS.md');
  });

  it('whitespace-only internal docs count as empty', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Blank' }, UI);
    t.d.projects.update(p.id, { internalDocs: '  \n\n ' }, UI);
    expect(t.d.projects.linkRepo(p.id, REPO, CLAUDE).docsSource).toBe('repo');
  });

  it('internal docs with content: kept, no Stop-hook target, briefing rule stays update_docs', () => {
    t = makeDomain();
    const { d } = t;
    const p = d.projects.create({ name: 'Kept' }, UI);
    d.projects.update(p.id, { internalDocs: '## D1 — Use SQLite\n' }, UI);
    d.projects.linkRepo(p.id, REPO, CLAUDE);
    expect(d.projects.get(p.id).docsSource).toBe('internal');
    d.hooks.sessionStart(SID, { remote: `git@github.com:${REPO}.git`, head: 'a1' });
    expect(d.hooks.docsTarget(SID)).toBeNull();
    expect(d.briefing.build({ project: p.id })).toContain('update_docs');
  });

  it('the docs-source switch on link is recorded in the audit (before/after)', () => {
    t = makeDomain();
    const { d } = t;
    const p = d.projects.create({ name: 'Audit' }, UI);
    d.projects.linkRepo(p.id, REPO, CLAUDE);
    const rows = JSON.stringify(d.db.select().from(changeLog).all());
    expect(rows).toContain('docsSource');
  });
});
