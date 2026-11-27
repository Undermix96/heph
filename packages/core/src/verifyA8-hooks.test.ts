// Independent verification A8 (D66): the legacy escape in unlinked SessionStart text.
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_CONTEXT_MAX_CHARS } from './briefing.js';
import { UI } from './context.js';
import { LEGACY_MARKER } from './hooks.js';
import { expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const SID = '3f2b8c1e-9a7d-4e21-b6c5-0d1e2f3a4b5c';
const longOwner = 'o'.repeat(39);
const longName = 'n'.repeat(100);

const remotes: [string, string | null][] = [
  ['GitHub SSH', 'git@github.com:example/other.git'],
  ['GitHub HTTPS no .git', 'https://github.com/example/other'],
  ['GitHub longest names', `git@github.com:${longOwner}/${longName}.git`],
  ['non-GitHub', 'https://gitlab.example.com/group/sub/project.git'],
  ['non-GitHub very long', `https://git.example.com/${'deep/'.repeat(100)}repo.git`],
  ['no remote', null],
];

describe('A8: unlinked SessionStart text', () => {
  for (const lang of ['en', 'it'] as const) {
    for (const [label, remote] of remotes) {
      it(`${label} (${lang}): header, legacy escape, Otherwise, rules, session id; within limit`, () => {
        t = makeDomain();
        const { d } = t;
        seedProject(d, { repos: ['example/spot-welder'] });
        d.settings.update({ contentLanguage: lang }, UI);
        const text = d.hooks.sessionStart(SID, { remote });
        expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
        const lines = text.split('\n');
        expect(lines[0]).toBe('# Heph session start');
        // The first instruction is the legacy escape.
        const firstInstruction = lines.slice(1).find((l) => l.trim() !== '')!;
        expect(firstInstruction).toContain(`\`${LEGACY_MARKER}\``);
        expect(firstInstruction).toContain('follow that CLAUDE.md');
        expect(firstInstruction).toContain('do not propose registering or migrating');
        const iLegacy = text.indexOf(LEGACY_MARKER);
        const iOtherwise = text.indexOf('Otherwise');
        const iRules = text.indexOf('## Rules');
        expect(iLegacy).toBeLessThan(iOtherwise);
        expect(iOtherwise).toBeLessThan(iRules);
        // Rules are complete: the session id line and the last rule survive.
        expect(text).toContain(`- Pass session_id "${SID}" to every write tool.`);
        expect(text.trimEnd().endsWith('never pass file content in tool arguments.')).toBe(true);
        expect(d.sessions.projectFor(SID)).toBeNull();
      });
    }
  }

  it('GitHub unlinked: offers migration for file-tracked repos, else registering', () => {
    t = makeDomain();
    const text = t.d.hooks.sessionStart(SID, { remote: 'git@github.com:Example/Other.git' });
    expect(text).toContain('heph:migrate-project');
    expect(text).toMatch(/PROGRESS\.md/);
    expect(text).toContain('create_project with repos: ["example/other"]');
    expect(text).toContain('link_repo');
  });

  // D66: "Otherwise it proposes the migration skill when the repo tracks work in files".
  // A repo on GitLab or without a remote can track work in files too.
  for (const [label, remote] of [
    ['non-GitHub', 'https://gitlab.example.com/a/b.git'],
    ['no remote', null],
  ] as const) {
    it(`${label} unlinked: also mentions the migrate-project skill (D66)`, () => {
      t = makeDomain();
      const text = t.d.hooks.sessionStart(SID, { remote });
      expect(text).toContain('heph:migrate-project');
    });
  }

  it('the legacy marker matches the skill text', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const skill = fs.readFileSync(
      path.resolve(__dirname, '../../../plugin/skills/migrate-project/SKILL.md'),
      'utf8',
    );
    expect(skill).toContain(LEGACY_MARKER);
  });

  it('linked repo sessions never get the legacy escape, even after linking an unlinked one', () => {
    t = makeDomain();
    const { d } = t;
    const first = d.hooks.sessionStart('a', { remote: 'git@github.com:example/later.git' });
    expect(first).toContain(LEGACY_MARKER);
    d.projects.create({ name: 'Later', repos: ['example/later'] }, UI);
    const second = d.hooks.sessionStart('b', { remote: 'git@github.com:example/later.git' });
    expect(second).not.toContain(LEGACY_MARKER);
    expect(second).toContain('# Briefing: Later');
  });

  it('get_briefing for an unlinked repo explains the legacy marker and the migration skill', () => {
    t = makeDomain();
    const err = expectDomainError(
      () => t.d.briefing.resolve({ repo: 'https://github.com/Example/Unlinked.git' }),
      'not_found',
    );
    expect(err.message).toContain('Work state: legacy');
    expect(err.message).toContain('heph:migrate-project');
    // Case as given by the caller (matching is case-insensitive anyway).
    expect(err.message.toLowerCase()).toContain('create_project with repos: ["example/unlinked"]');
  });
});
