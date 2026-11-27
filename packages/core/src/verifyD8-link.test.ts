// Independent verification D8 (D68, D69): linkRepo first-repo switch, second repo, plain
// relink, audit of the switch, briefing docs rule. All repos and content are invented.
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_CONTEXT_MAX_CHARS } from './briefing.js';
import { UI } from './context.js';
import { changeLog, projectRepos } from './db/schema.js';
import { CLAUDE } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const A = 'example/alpha';
const B = 'example/beta';

const logRows = () => t.d.db.select().from(changeLog).all();
const repoRowsRaw = () => t.d.db.select().from(projectRepos).all();

describe('D8: first repo vs later repos (D68)', () => {
  it('second repo never switches docs, even with empty internal docs', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Two' }, UI);
    t.d.projects.linkRepo(p.id, A, CLAUDE);
    expect(t.d.projects.get(p.id).docsSource).toBe('repo');
    // The user chooses internal again (still empty), then a second repo is linked.
    t.d.projects.update(p.id, { docsSource: 'internal' }, UI);
    t.d.projects.linkRepo(p.id, B, CLAUDE);
    expect(t.d.projects.get(p.id).docsSource).toBe('internal');
    const last = logRows().at(-1)!;
    expect(last.action).toBe('link');
    expect(last.before).toBeNull();
    expect(JSON.stringify(last.after)).not.toContain('docsSource');
  });

  it('a project created with repos (docs repo) and a second repo stays repo', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Created', repos: [A] }, UI);
    expect(p.docsSource).toBe('repo');
    t.d.projects.linkRepo(p.id, B, CLAUDE);
    expect(t.d.projects.get(p.id).docsSource).toBe('repo');
  });

  it('first repo linked by URL also switches; audit has before/after docsSource', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Url' }, UI);
    const r = t.d.projects.linkRepo(p.id, 'git@github.com:Example/Alpha.git', CLAUDE);
    expect(r.docsSource).toBe('repo');
    const last = logRows().at(-1)!;
    expect(last.action).toBe('link');
    expect(last.before).toEqual({ docsSource: 'internal' });
    expect(last.after).toMatchObject({ fullName: 'Example/Alpha', docsSource: 'repo' });
  });

  it('first repo with content in internal docs: no switch, no docsSource in the audit', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Content' }, UI);
    t.d.projects.update(p.id, { internalDocs: '## D1 — Invented\n' }, UI);
    t.d.projects.linkRepo(p.id, A, CLAUDE);
    expect(t.d.projects.get(p.id).docsSource).toBe('internal');
    const last = logRows().at(-1)!;
    expect(last.before).toBeNull();
    expect(JSON.stringify(last.after)).not.toContain('docsSource');
  });

  it('unlink the only repo, then link one again: it is the first repo again', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Again' }, UI);
    const linked = t.d.projects.linkRepo(p.id, A, CLAUDE);
    t.d.projects.update(p.id, { docsSource: 'internal' }, UI);
    t.d.projects.unlinkRepo(linked.repoDetails[0]!.id, UI);
    expect(t.d.projects.linkRepo(p.id, B, CLAUDE).docsSource).toBe('repo');
  });

  it('first repo of a project whose docs are already repo: no audit before, stays repo', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Repo already', docsSource: 'repo' }, UI);
    t.d.projects.linkRepo(p.id, A, CLAUDE);
    expect(t.d.projects.get(p.id).docsSource).toBe('repo');
    expect(logRows().at(-1)!.before).toBeNull();
  });
});

describe('D8: plain relink changes nothing (C8 / D69)', () => {
  function linked() {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Relink' }, UI);
    t.d.projects.linkRepo(p.id, { fullName: A, docsPath: 'docs/adr/README.md' }, CLAUDE);
    t.clock.advance(60_000);
    return p;
  }

  for (const [label, input] of [
    ['string', A],
    ['https URL, other case', 'https://github.com/EXAMPLE/Alpha/'],
    ['SSH URL', 'git@github.com:example/alpha.git'],
    ['object with undefined fields', { fullName: A, docsPath: undefined, showCommits: undefined }],
    ['object with fullName only', { fullName: A }],
  ] as const) {
    it(`${label}: no updatedAt bump, no change-log row, same repo row`, () => {
      const p = linked();
      const projBefore = t.d.projects.row(p.id).updatedAt;
      const logBefore = logRows().length;
      const repoBefore = repoRowsRaw();
      const r = t.d.projects.linkRepo(p.id, input, CLAUDE);
      expect(t.d.projects.row(p.id).updatedAt).toBe(projBefore);
      expect(logRows()).toHaveLength(logBefore);
      expect(repoRowsRaw()).toEqual(repoBefore);
      expect(r.repoDetails).toHaveLength(1);
      expect(r.repoDetails[0]!.docsPath).toBe('docs/adr/README.md');
    });
  }

  it('relink with docs_path updates it and records one change-log row', () => {
    const p = linked();
    const logBefore = logRows().length;
    const r = t.d.projects.linkRepo(p.id, { fullName: A, docsPath: 'DECISIONS.md' }, CLAUDE);
    expect(r.repoDetails[0]!.docsPath).toBe('DECISIONS.md');
    expect(logRows()).toHaveLength(logBefore + 1);
    expect(logRows().at(-1)!.action).toBe('update');
  });

  it('relink with show_commits only keeps the docs path', () => {
    const p = linked();
    const r = t.d.projects.linkRepo(p.id, { fullName: A, showCommits: false }, CLAUDE);
    expect(r.repoDetails[0]).toMatchObject({ docsPath: 'docs/adr/README.md', showCommits: false });
  });

  it('relink never changes docsSource', () => {
    const p = linked();
    t.d.projects.update(p.id, { docsSource: 'internal' }, UI);
    t.d.projects.linkRepo(p.id, { fullName: A, docsPath: 'other.md' }, CLAUDE);
    expect(t.d.projects.get(p.id).docsSource).toBe('internal');
  });
});

describe('D8: briefing docs rule (D69)', () => {
  const SID = '0f1e2d3c-4b5a-4968-8776-655443322110';

  it('internal-docs project: rule mentions update_docs and the local-repo DECISIONS.md case', () => {
    t = makeDomain();
    const p = t.d.projects.create({ name: 'Diy' }, UI);
    const b = t.d.briefing.build({ project: p.id, sessionId: SID });
    expect(b).toContain('with update_docs');
    expect(b).toMatch(/local repo not on GitHub yet, in that repo's DECISIONS\.md instead/);
  });

  it('repo-docs project: rule names the repo docs path, not the local-repo case', () => {
    t = makeDomain();
    const p = t.d.projects.create(
      { name: 'Gh', repos: [{ fullName: A, docsPath: 'docs/d.md' }] },
      UI,
    );
    const b = t.d.briefing.build({ project: p.id, sessionId: SID });
    expect(b).toContain('in docs/d.md in the repo, in English');
    expect(b).not.toContain('not on GitHub yet');
  });

  it('hook context of a huge internal-docs project fits and keeps rules and session id', () => {
    t = makeDomain();
    const long = 'x'.repeat(280);
    const p = t.d.projects.create(
      {
        name: 'Huge',
        description: 'd'.repeat(5000),
        phases: Array.from({ length: 50 }, (_, i) => ({
          title: `Phase ${i} ${long}`,
          tasks: Array.from({ length: 30 }, (_, j) => `Task ${i}.${j} ${long}`),
        })),
      },
      UI,
    );
    for (let i = 0; i < 30; i++)
      t.d.diary.append(p.id, { type: 'note', body: 'n'.repeat(3000) }, UI);
    const text = t.d.briefing.forHook(p.id, SID, '# Heph session start\n\n');
    expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect(text).toContain('## Rules');
    expect(text).toContain(`session_id "${SID}"`);
    expect(text).toContain("in that repo's DECISIONS.md instead, in English");
  });
});
