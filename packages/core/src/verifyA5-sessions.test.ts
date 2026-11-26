/**
 * Independent verification of phase 5 group A (live sessions, auto-diary,
 * SessionStart context, docs from the hook). Realistic use only (D54).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isTestCommand } from './autodiary.js';
import { HOOK_CONTEXT_MAX_CHARS } from './briefing.js';
import { UI } from './context.js';
import type { HookFacts } from './sessions.js';
import { expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const MIN = 60_000;
const REMOTE = 'git@github.com:example/spot-welder.git';
const git = (head: string | null = 'h1', worktree: string | null = 'w1'): HookFacts => ({
  remote: REMOTE,
  cwd: 'D:\\Git\\spot',
  head,
  worktree,
});
/** What the plugin script sends for Pre/PostToolUse: the remote only, no git state. */
const toolFacts: HookFacts = { remote: REMOTE };

function setup(overrides: Record<string, unknown> = {}) {
  t = makeDomain();
  const p = seedProject(t.d, { repos: ['example/spot-welder'], ...overrides });
  return { ...t, p };
}

const note = (d: TestDomain['d'], projectId: number, sessionId: string) =>
  d.diary.addNote(projectId, { body: 'Fatto il refactor' }, { source: 'claude_code', sessionId });

const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('verify A5: SessionStart context size', () => {
  it('a big project stays within HOOK_CONTEXT_MAX_CHARS including the header', () => {
    const { d, p } = setup();
    for (let i = 0; i < 60; i++) {
      d.roadmap.addTask(p.phases[0]!.id, { title: `Task ${i} ${'y'.repeat(200)}` }, UI);
      d.diary.addNote(p.id, { body: `${'x'.repeat(900)} ${i}` }, UI);
    }
    const text = d.hooks.sessionStart('s1', git());
    expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect(text).toContain('Pass session_id "s1"');
  });

  it('long notes on the next task still keep the rules and the session id line', () => {
    const { d, p } = setup();
    // A pasted spec in the notes of the next task: realistic, notes allow 50 000 chars.
    const notes = Array.from(
      { length: 300 },
      (_, i) => `- Step ${i}: wire the relay, check the timing again`,
    ).join('\n');
    d.roadmap.updateTask(p.phases[0]!.tasks[0]!.id, { notes }, UI);
    const text = d.hooks.sessionStart('s1', git());
    expect.soft(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect.soft(text).toContain('## Rules');
    expect.soft(text).toContain('Pass session_id "s1" to every write tool.');
    expect.soft(text).toContain('call get_briefing');
  });

  it('a long status note still keeps the rules and the session id line', () => {
    const { d, p } = setup();
    d.projects.setStatus(
      p.id,
      {
        status: 'awaiting_manual_test',
        note: 'Controlla la saldatura su lamiera da 0,5 mm e annota i tempi. '.repeat(200),
      },
      UI,
    );
    const text = d.hooks.sessionStart('s1', git());
    expect.soft(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect.soft(text).toContain('Pass session_id "s1" to every write tool.');
  });

  it('multi-byte content (accents, emoji) is cut without breaking characters', () => {
    const { d, p } = setup();
    d.roadmap.updateTask(
      p.phases[0]!.tasks[0]!.id,
      { notes: 'Perché la saldatura è fragile 🔥🔧 '.repeat(800) },
      UI,
    );
    for (let i = 0; i < 20; i++)
      d.diary.addNote(p.id, { body: `Più lavoro ✅ ${'à'.repeat(700)}` }, UI);
    const text = d.hooks.sessionStart('s1', git());
    expect.soft(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect(hasLoneSurrogate(text)).toBe(false);
  });

  it('a normal project gets the full briefing, no compact note', () => {
    const { d } = setup();
    const text = d.hooks.sessionStart('s1', git());
    expect(text).not.toContain('Compact briefing');
    expect(text).toContain('## Recent diary');
  });
});

describe('verify A5: session lifecycle', () => {
  it('a project deleted while a session is open: hooks keep working, session becomes unlinked', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    d.projects.delete(p.id, UI);
    expect(() => d.hooks.stop('s1', false, git('h2', 'w2'))).not.toThrow();
    expect(d.sessions.projectFor('s1')).toBeNull();
    const text = d.hooks.sessionStart('s1', git());
    expect(text).toContain('not linked to any Heph project');
    expect(d.hooks.docsTarget('s1')).toBeNull();
  });

  it('repo unlinked from A and linked to B: the open session follows the repo to B', () => {
    const { d, p } = setup();
    const b = d.projects.create({ name: 'Other project' }, UI);
    d.hooks.sessionStart('s1', git());
    const repoId = d.projects.get(p.id).repoDetails[0]!.id;
    d.projects.unlinkRepo(repoId, UI);
    d.projects.linkRepo(b.id, 'example/spot-welder', UI);
    d.hooks.stop('s1', false, git());
    expect(d.sessions.projectFor('s1')).toBe(b.id);
    expect(d.projects.get(p.id).liveSessions).toHaveLength(0);
    expect(d.projects.get(b.id).liveSessions).toHaveLength(1);
  });

  it('two sessions on one project are both live; a note from one does not reset the other', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('a', git('h1', 'w1'));
    d.hooks.sessionStart('b', git('h1', 'w1'));
    expect(
      d.projects
        .get(p.id)
        .liveSessions.map((s) => s.sessionId)
        .sort(),
    ).toEqual(['a', 'b']);
    for (let i = 0; i < 3; i++) {
      d.hooks.stop('a', false, git('h1', 'w2'));
      d.hooks.stop('b', false, git('h1', 'w2'));
    }
    note(d, p.id, 'b');
    d.hooks.stop('b', false, git('h1', 'w2'));
    expect(d.sessions.row('b')?.turnsSinceDiary).toBe(0);
    expect(d.sessions.row('a')?.turnsSinceDiary).toBe(3);
    d.hooks.stop('a', false, git('h1', 'w2'));
    expect(d.hooks.stop('a', false, git('h1', 'w2'))?.decision).toBe('block');
    // b's baseline moved to w2 at its Stop: nothing changed since, never due.
    for (let i = 0; i < 10; i++) expect(d.hooks.stop('b', false, git('h1', 'w2'))).toBeNull();
  });

  it('one session testing and another working: the project shows testing until it ends', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('a', git());
    d.hooks.sessionStart('b', git());
    d.sessions.toolStart('a', 'tu-a', 'npm test', toolFacts);
    d.hooks.stop('b', false, git());
    expect(d.projects.get(p.id).activityState).toBe('claude_testing');
    d.sessions.toolEnd('a', 'tu-a', toolFacts);
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
  });

  it('a session whose SessionStart was missed and first seen by PreToolUse does not nudge without changes', () => {
    const { d } = setup();
    // Heph was down at SessionStart; the first hook it sees is PreToolUse (no git headers).
    d.sessions.toolStart('late', 'tu1', 'git status', toolFacts);
    // Nothing changes in git for many turns.
    for (let i = 0; i < 12; i++) {
      expect(d.hooks.stop('late', false, git('h1', 'w1')), `turn ${i + 1}`).toBeNull();
    }
  });

  it('a session first seen by Stop has a baseline and nudges on a later commit', () => {
    const { d } = setup();
    expect(d.hooks.stop('late', false, git('h1', 'w1'))).toBeNull();
    expect(d.hooks.stop('late', false, git('h2', 'w1'))?.decision).toBe('block');
  });

  it('resume / compact keeps the project, the baseline and the counters', () => {
    const { d, p, clock } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    d.hooks.stop('s1', false, git('h1', 'w2'));
    d.hooks.stop('s1', false, git('h1', 'w2'));
    d.sessions.end('s1', 'prompt_input_exit');
    clock.advance(2 * 60 * MIN);
    expect(d.sessions.expireStale()).toBe(0); // already ended
    const text = d.hooks.sessionStart('s1', git('h1', 'w2'));
    expect(text).toContain('# Briefing: Spot Welder');
    expect(d.sessions.projectFor('s1')).toBe(p.id);
    expect(d.sessions.row('s1')?.turnsSinceDiary).toBe(2);
    expect(d.sessions.row('s1')?.endedAt).toBeNull();
    // compact: same session id, another SessionStart mid-session
    d.hooks.sessionStart('s1', git('h1', 'w2'));
    expect(d.projects.get(p.id).liveSessions).toHaveLength(1);
  });

  it('expired then back: the reopened session is live and its Stop counts', () => {
    const { d, p, clock } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    clock.advance(31 * MIN);
    expect(d.sessions.expireStale()).toBe(1);
    expect(d.projects.get(p.id).liveSessions).toHaveLength(0);
    // Back after a long pause with a commit made in between.
    expect(d.hooks.stop('s1', false, git('h2', 'w1'))?.decision).toBe('block');
    expect(d.projects.get(p.id).liveSessions).toHaveLength(1);
    expect(d.sessions.row('s1')?.endReason).toBeNull();
  });

  it('SessionEnd is idempotent and a reason is kept', () => {
    const { d, clock } = setup();
    d.hooks.sessionStart('s1', git());
    d.sessions.end('s1', 'clear');
    const first = d.sessions.row('s1')?.endedAt;
    clock.advance(MIN);
    d.sessions.end('s1', 'other');
    expect(d.sessions.row('s1')?.endedAt).toEqual(first);
    expect(d.sessions.row('s1')?.endReason).toBe('clear');
  });
});

describe('verify A5: auto-diary over many turns', () => {
  it('a long realistic session: nudges happen only with changes and never twice in a row', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git('h0', 'w0'));
    let nudges = 0;
    let lastNudgeTurn = -100;
    let head = 'h0';
    let wt = 'w0';
    for (let turn = 1; turn <= 60; turn++) {
      if (turn % 3 === 0) wt = `w${turn}`;
      if (turn % 11 === 0) head = `h${turn}`;
      const b = d.hooks.stop('s1', false, git(head, wt));
      if (b) {
        nudges++;
        expect(turn - lastNudgeTurn).toBeGreaterThanOrEqual(5);
        lastNudgeTurn = turn;
        // Claude follows the nudge half the time.
        if (nudges % 2 === 1) note(d, p.id, 's1');
        expect(d.hooks.stop('s1', true, git(head, wt))).toBeNull();
      }
    }
    expect(nudges).toBeGreaterThan(2);
  });

  it('stop_hook_active turns are not counted', () => {
    const { d } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    for (let i = 0; i < 10; i++) expect(d.hooks.stop('s1', true, git('h1', 'w2'))).toBeNull();
    expect(d.sessions.row('s1')?.turnsSinceDiary).toBe(0);
  });

  it('a note then a revert to the old state counts as changed', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    d.hooks.stop('s1', false, git('h1', 'w2'));
    note(d, p.id, 's1');
    d.hooks.stop('s1', false, git('h1', 'w2')); // baseline moves to w2
    // Work reverted to the clean tree: still a change vs the baseline.
    for (let i = 0; i < 4; i++) expect(d.hooks.stop('s1', false, git('h1', 'w1'))).toBeNull();
    expect(d.hooks.stop('s1', false, git('h1', 'w1'))).not.toBeNull();
  });

  it('outside git: the minutes threshold nudges, and the wait after a nudge applies', () => {
    const { d, clock } = setup();
    const noGit: HookFacts = { remote: REMOTE };
    d.hooks.sessionStart('s1', noGit);
    clock.advance(31 * MIN);
    expect(d.hooks.stop('s1', false, noGit)).not.toBeNull();
    for (let i = 0; i < 4; i++) expect(d.hooks.stop('s1', false, noGit)).toBeNull();
    expect(d.hooks.stop('s1', false, noGit)).not.toBeNull();
  });

  it('enabling Claude write on a read-only project: a pending commit nudges right away', () => {
    const { d, p } = setup();
    d.projects.update(p.id, { claudeWriteEnabled: false }, UI);
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    expect(d.hooks.stop('s1', false, git('h2', 'w1'))).toBeNull(); // read only: no nudge sent
    d.projects.update(p.id, { claudeWriteEnabled: true }, UI);
    // No nudge was ever sent, so the "wait after a nudge" rule should not apply.
    expect(d.hooks.stop('s1', false, git('h2', 'w1'))?.decision).toBe('block');
  });

  it('a note through the REST/MCP path for an unknown session is harmless', () => {
    const { d, p } = setup();
    expect(() => note(d, p.id, 'never-seen')).not.toThrow();
    expect(d.sessions.row('never-seen')).toBeUndefined();
  });

  it('diaryNudgeTurns raised mid-session applies to the next Stop', () => {
    const { d } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    for (let i = 0; i < 4; i++) d.hooks.stop('s1', false, git('h1', 'w2'));
    d.settings.update({ diaryNudgeTurns: 10 }, UI);
    expect(d.hooks.stop('s1', false, git('h1', 'w2'))).toBeNull();
  });
});

describe('verify A5: settings for the new keys', () => {
  it('rejects out-of-range values and keeps defaults for bad stored values', () => {
    const { d } = setup();
    expectDomainError(() => d.settings.update({ diaryNudgeTurns: 0 }, UI), 'validation');
    expectDomainError(() => d.settings.update({ diaryNudgeMinutes: 1441 }, UI), 'validation');
    expectDomainError(() => d.settings.update({ diaryNudgeTurns: 2.5 }, UI), 'validation');
    const s = d.settings.get();
    expect(s.diaryNudgeTurns).toBe(5);
    expect(s.diaryNudgeMinutes).toBe(30);
    expect(() =>
      d.settings.update({ diaryNudgeTurns: 3 }, { source: 'claude_code', sessionId: 's' }),
    ).toThrow();
  });
});

describe('verify A5: test command detection on real command lines', () => {
  const patterns = [
    'npm test',
    'npm run test',
    'pnpm test',
    'yarn test',
    'npx vitest',
    'vitest',
    'jest',
    'pytest',
    'playwright test',
    'go test',
    'cargo test',
  ];
  const positives = [
    'npm test',
    'npm test 2>&1 | tail -n 40',
    'cd apps/server && npx vitest run src/routes/hooks.api.test.ts',
    'CI=1 npm test',
    'NODE_OPTIONS="--max-old-space-size=4096" npx vitest run',
    '$env:CI = "1"; npm test',
    '& npm test',
    'cd "D:\\Git\\Hephaestus"; npm test 2>&1 | Select-Object -Last 30',
    'npm run lint && npm run typecheck && npm test',
    'npm run test -- --reporter=dot',
    'python -m venv .venv; pytest -q tests/',
    'go test ./...',
    'cargo test --workspace',
    'npx playwright test --project=chromium',
    'npm test\r\n',
    'npm run build\nnpm test',
    '(cd apps/web && npx vitest run)',
  ];
  const negatives = [
    'npm install',
    'git status',
    'npm run lint',
    'git commit -m "test: add vitest config"',
    'cat vitest.config.ts',
    'npm testing',
    'rg "npm test" docs',
  ];
  for (const c of positives) {
    it(`detects: ${JSON.stringify(c)}`, () => expect(isTestCommand(c, patterns)).toBe(true));
  }
  for (const c of negatives) {
    it(`ignores: ${JSON.stringify(c)}`, () => expect(isTestCommand(c, patterns)).toBe(false));
  }
});

describe('verify A5: overlapping tool calls', () => {
  it('two test runs in parallel: testing until the last one ends, whatever the order', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git());
    d.sessions.toolStart('s1', 'tu-unit', 'npm test', toolFacts);
    d.sessions.toolStart('s1', 'tu-e2e', 'npx playwright test', toolFacts);
    d.sessions.toolEnd('s1', 'tu-e2e', toolFacts);
    // The unit tests are still running.
    expect(d.projects.get(p.id).activityState).toBe('claude_testing');
    d.sessions.toolEnd('s1', 'tu-unit', toolFacts);
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
  });

  it('a non-test command during a test run does not end it', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git());
    d.sessions.toolStart('s1', 'tu1', 'npm test', toolFacts);
    d.sessions.toolStart('s1', 'tu2', 'git status', toolFacts);
    d.sessions.toolEnd('s1', 'tu2', toolFacts);
    expect(d.projects.get(p.id).activityState).toBe('claude_testing');
    const since = d.sessions.row('s1')?.testingSince;
    d.sessions.toolStart('s1', 'tu3', 'npm test', toolFacts);
    expect(d.sessions.row('s1')?.testingSince).toEqual(since);
  });
});

describe('verify A5: docs from the hook', () => {
  it('a docs path change refuses the old path and offers the new one with no hash', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git());
    expect(d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('# D\n'))).toBe(true);
    const repoId = d.projects.get(p.id).repoDetails[0]!.id;
    d.projects.updateRepo(repoId, { docsPath: 'docs/DECISIONS.md' }, UI);
    expect(d.hooks.docsTarget('s1')).toEqual({ path: 'docs/DECISIONS.md', hash: null });
    expectDomainError(() => d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from('x')), 'conflict');
    expect(d.hooks.storeDocs('s1', 'docs/DECISIONS.md', Buffer.from('# D\n'))).toBe(true);
  });

  it('CRLF content, BOM and empty file are stored as they are', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git());
    const crlf = Buffer.from('# Decisioni\r\n\r\n## D1 — Perché SQLite\r\n');
    expect(d.hooks.storeDocs('s1', 'DECISIONS.md', crlf)).toBe(true);
    expect(d.projects.docs(p.id).repos[0]?.content).toBe(crlf.toString('utf8'));
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# D\n')]);
    expect(d.hooks.storeDocs('s1', 'DECISIONS.md', bom)).toBe(true);
    expect(d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.alloc(0))).toBe(true);
    expect(d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.alloc(0))).toBe(false);
  });

  it('a session on another repo of the same project uses that repo docs', () => {
    const { d } = setup({ repos: ['example/spot-welder', 'example/spot-firmware'] });
    d.hooks.sessionStart('fw', { remote: 'https://github.com/example/spot-firmware.git' });
    expect(d.hooks.docsTarget('fw')?.path).toBe('DECISIONS.md');
    d.hooks.storeDocs('fw', 'DECISIONS.md', Buffer.from('# Firmware\n'));
    d.hooks.sessionStart('main', git());
    expect(d.hooks.docsTarget('main')?.hash).toBeNull();
  });
});
