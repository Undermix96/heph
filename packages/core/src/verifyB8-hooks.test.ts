// Independent verification B8 (D59, D65, D66): unlinked SessionStart text for repos without a
// GitHub remote, and the auto-diary counters around backdated notes. Data is invented.
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_CONTEXT_MAX_CHARS } from './briefing.js';
import { UI } from './context.js';
import { LEGACY_MARKER } from './hooks.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const SID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

describe('B8: unlinked text without a GitHub remote (D66)', () => {
  const remotes: [string, string | null][] = [
    ['GitLab', 'https://gitlab.example.com/group/forno.git'],
    ['self-hosted with credentials', 'https://user:s3cret@git.example.lan/forno.git'],
    ['very long', `ssh://git@git.example.lan/${'sub/'.repeat(120)}forno.git`],
    ['no remote', null],
  ];
  for (const lang of ['en', 'it'] as const) {
    for (const [label, remote] of remotes) {
      it(`${label} (${lang}): legacy, then migrate hint, then fallback, then complete rules`, () => {
        t = makeDomain();
        t.d.settings.update({ contentLanguage: lang }, UI);
        const text = t.d.hooks.sessionStart(SID, { remote });
        expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
        const iLegacy = text.indexOf(LEGACY_MARKER);
        const iMigrate = text.indexOf('heph:migrate-project');
        const iFallback = text.indexOf('If not, ask the user which Heph project');
        const iRules = text.indexOf('## Rules');
        expect(iLegacy).toBeGreaterThan(0);
        expect(iLegacy).toBeLessThan(iMigrate);
        expect(iMigrate).toBeLessThan(iFallback);
        expect(iFallback).toBeLessThan(iRules);
        // Exactly one migration proposal, and no create_project advice (cannot link).
        expect(text.split('heph:migrate-project').length - 1).toBe(1);
        expect(text).not.toContain('create_project with repos');
        expect(text).not.toContain('s3cret');
        expect(text).toContain(`- Pass session_id "${SID}" to every write tool.`);
        expect(text.trimEnd().endsWith('never pass file content in tool arguments.')).toBe(true);
      });
    }
  }
});

describe('B8: auto-diary counters and backdated notes (D59, A8)', () => {
  function linkedSession() {
    t = makeDomain();
    const { d } = t;
    d.projects.create({ name: 'Forno', repos: ['example/forno'] }, UI);
    d.hooks.sessionStart(SID, { remote: 'git@github.com:example/forno.git', head: 'a1' });
    return d;
  }
  const cc = { source: 'claude_code' as const, sessionId: SID };

  it('a normal session note restarts the counters; a backdated one does not', () => {
    const d = linkedSession();
    d.diary.addNote('forno', { body: 'Imported 2025 note', occurredAt: '2025-03-02' }, cc);
    expect(d.sessions.row(SID)?.lastDiaryAt ?? null).toBeNull();
    d.diary.addNote('forno', { body: 'Worked on the dome' }, cc);
    expect(d.sessions.row(SID)?.lastDiaryAt).not.toBeNull();
  });

  it('session diary grouping: backdated notes are outside the session, live ones inside', () => {
    const d = linkedSession();
    d.diary.addNote('forno', { body: 'Old', occurredAt: '2025-03-02' }, cc);
    d.diary.addNote('forno', { body: 'Live' }, cc);
    const list = d.diary.list('forno', { limit: 50 });
    const old = list.find((e) => e.body === 'Old')!;
    const live = list.find((e) => e.body === 'Live')!;
    expect(old.sessionId).toBeNull();
    expect(old.type).toBe('note');
    expect(live.sessionId).toBe(SID);
    expect(live.type).toBe('session');
  });

  it('a backdated note never lowers the project last activity', () => {
    const d = linkedSession();
    const before = d.projects.get('forno').lastActivityAt;
    d.diary.addNote('forno', { body: 'Old', occurredAt: '2024-01-01' }, cc);
    expect(d.projects.get('forno').lastActivityAt).toBe(before);
  });
});
