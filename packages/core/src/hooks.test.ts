import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_CONTEXT_MAX_CHARS } from './briefing.js';
import { UI } from './context.js';
import { gitBlobSha } from './hooks.js';
import type { HookFacts } from './sessions.js';
import { expectDomainError, seedProject } from './test/fixtures.js';
import { makeDomain, type TestDomain } from './test/helpers.js';

let t: TestDomain;
afterEach(() => t?.cleanup());

const MIN = 60_000;
const REMOTE = 'git@github.com:Example/Spot-Welder.git';
const git = (head = 'h1', worktree = 'w1'): HookFacts => ({
  remote: REMOTE,
  cwd: '/work/spot',
  head,
  worktree,
});

function setup(overrides: Record<string, unknown> = {}) {
  t = makeDomain();
  const p = seedProject(t.d, { repos: ['example/spot-welder'], ...overrides });
  return { ...t, p };
}

/** A diary note written by Claude in a session, as log_progress does. */
const note = (d: TestDomain['d'], projectId: number, sessionId: string) =>
  d.diary.addNote(projectId, { body: 'Did things' }, { source: 'claude_code', sessionId });

describe('SessionStart', () => {
  it('links the session to the project of its repo and returns briefing + rules + session id', () => {
    const { d, p } = setup();
    const text = d.hooks.sessionStart('s1', git());
    expect(text).toContain('# Heph session start');
    expect(text).toContain('# Briefing: Spot Welder');
    expect(text).toContain('## Rules');
    expect(text).toContain('Pass session_id "s1" to every write tool.');
    expect(d.sessions.projectFor('s1')).toBe(p.id);
    const live = d.projects.get(p.id);
    expect(live.activityState).toBe('claude_working');
    expect(live.liveSessions.map((s) => s.repo)).toEqual(['example/spot-welder']);
  });

  it('accepts HTTPS remotes and is case-insensitive on owner/name', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', { remote: 'https://github.com/EXAMPLE/spot-welder' });
    expect(d.sessions.projectFor('s1')).toBe(p.id);
  });

  it('unlinked GitHub repo: rules plus a proposal to register it', () => {
    const { d } = setup();
    const text = d.hooks.sessionStart('s2', { remote: 'git@github.com:example/other.git' });
    expect(text).toContain('`example/other` is not linked');
    expect(text).toContain('create_project with repos: ["example/other"]');
    expect(text).toContain('## Rules');
    expect(text).toContain('Pass session_id "s2"');
    expect(d.sessions.projectFor('s2')).toBeNull();
  });

  it('non-GitHub remote and no remote ask the user which project, without leaking credentials', () => {
    const { d } = setup();
    const gitlab = d.hooks.sessionStart('s3', {
      remote: 'https://user:secret@gitlab.example.com/a/b.git',
    });
    expect(gitlab).toContain('not on GitHub');
    expect(gitlab).toContain('https://gitlab.example.com/a/b.git');
    expect(gitlab).not.toContain('secret');
    const none = d.hooks.sessionStart('s4', { remote: null });
    expect(none).toContain('no git remote');
    expect(none).toContain('## Rules');
  });

  it('linking the repo later attaches the open session', () => {
    const { d } = setup();
    d.hooks.sessionStart('s2', { remote: 'git@github.com:example/other.git' });
    const other = d.projects.create({ name: 'Other', repos: ['example/other'] }, UI);
    expect(d.sessions.projectFor('s2')).toBe(other.id);
    const q = d.projects.create({ name: 'Q' }, UI);
    d.hooks.sessionStart('s5', { remote: 'git@github.com:example/q.git' });
    d.projects.linkRepo(q.id, { fullName: 'example/q' }, UI);
    expect(d.sessions.projectFor('s5')).toBe(q.id);
  });

  it('stays within the hook context limit for a huge project', () => {
    const { d, p } = setup();
    const long = 'x'.repeat(900);
    for (let i = 0; i < 60; i++) {
      d.roadmap.addTask(p.phases[0]!.id, { title: `Task ${i} ${'y'.repeat(200)}` }, UI);
      d.diary.addNote(p.id, { body: `${long} ${i}` }, UI);
    }
    const full = d.briefing.build({ project: p.id, sessionId: 's1' });
    expect(full.length).toBeGreaterThan(HOOK_CONTEXT_MAX_CHARS);
    const text = d.hooks.sessionStart('s1', git());
    expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect(text).toContain('## Rules');
    expect(text).toContain('call get_briefing');
    expect(text).toContain('## Next task');
  });

  it('a resumed session reopens and keeps its project', () => {
    const { d, p, clock } = setup();
    d.hooks.sessionStart('s1', git());
    d.sessions.end('s1', 'prompt_input_exit');
    expect(d.projects.get(p.id).liveSessions).toHaveLength(0);
    clock.advance(5 * MIN);
    d.hooks.sessionStart('s1', git());
    expect(d.projects.get(p.id).liveSessions).toHaveLength(1);
  });
});

describe('live sessions and testing', () => {
  it('a test command marks testing until the same tool call ends', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git());
    d.sessions.toolStart('s1', 'tu1', 'cd app && npm test', git());
    expect(d.projects.get(p.id).activityState).toBe('claude_testing');
    expect(d.projects.get(p.id).liveSessions[0]?.testingSince).not.toBeNull();
    d.sessions.toolEnd('s1', 'other', git()); // a different tool call
    expect(d.projects.get(p.id).activityState).toBe('claude_testing');
    d.sessions.toolEnd('s1', 'tu1', git());
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
  });

  it('other commands only heartbeat', () => {
    const { d, p, clock } = setup();
    d.hooks.sessionStart('s1', git());
    clock.advance(29 * MIN);
    d.sessions.toolStart('s1', 'tu1', 'git status', git());
    clock.advance(29 * MIN);
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
  });

  it('Stop ends a test run whose PostToolUse never arrived', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git());
    d.sessions.toolStart('s1', 'tu1', 'pytest', git());
    d.hooks.stop('s1', false, git());
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
  });

  it('a session first seen by a tool hook (SessionStart missed) is created and linked', () => {
    const { d, p } = setup();
    d.sessions.toolStart('late', 'tu1', 'npm test', git());
    expect(d.projects.get(p.id).activityState).toBe('claude_testing');
  });

  it('SessionEnd closes; expiry closes after the window; a later hook reopens', () => {
    const { d, p, clock } = setup();
    d.hooks.sessionStart('s1', git());
    d.sessions.end('s1', 'clear');
    expect(d.projects.get(p.id).activityState).not.toBe('claude_working');
    d.sessions.end('unknown', 'clear'); // ignored
    d.hooks.sessionStart('s2', git());
    clock.advance(31 * MIN);
    expect(d.sessions.expireStale()).toBe(1);
    d.hooks.stop('s2', false, git());
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
  });

  it('MCP writes with a session id heartbeat an open session only', () => {
    const { d, p, clock } = setup();
    d.hooks.sessionStart('s1', git());
    clock.advance(25 * MIN);
    d.sessions.heartbeat('s1');
    clock.advance(25 * MIN);
    expect(d.projects.get(p.id).activityState).toBe('claude_working');
    d.sessions.heartbeat('never-started');
    expect(d.sessions.row('never-started')).toBeUndefined();
  });
});

describe('Stop: auto-diary nudge (D59)', () => {
  it('nudges once on a new commit, then waits; a note resets the baseline', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    expect(d.hooks.stop('s1', false, git('h1', 'w1'))).toBeNull();
    const block = d.hooks.stop('s1', false, git('h2', 'w1'));
    expect(block?.decision).toBe('block');
    expect(block?.reason).toContain('log_progress');
    expect(block?.reason).toContain('session_id "s1"');
    expect(block?.reason).toContain('Italian');
    // Claude continues: the next Stop has stop_hook_active and never blocks.
    expect(d.hooks.stop('s1', true, git('h2', 'w1'))).toBeNull();
    // Claude ignored the nudge: no new nudge for diaryNudgeTurns turns.
    for (let i = 0; i < 4; i++) expect(d.hooks.stop('s1', false, git('h3', 'w1'))).toBeNull();
    expect(d.hooks.stop('s1', false, git('h3', 'w1'))?.decision).toBe('block');
    // A note moves the baseline to the current git state.
    note(d, p.id, 's1');
    for (let i = 0; i < 8; i++) expect(d.hooks.stop('s1', false, git('h3', 'w1'))).toBeNull();
  });

  it('uncommitted changes nudge after diaryNudgeTurns turns or minutes', () => {
    const { d, clock } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    for (let i = 0; i < 4; i++) expect(d.hooks.stop('s1', false, git('h1', 'w2'))).toBeNull();
    expect(d.hooks.stop('s1', false, git('h1', 'w2'))).not.toBeNull();

    d.hooks.sessionStart('s2', git('h1', 'w1'));
    clock.advance(31 * MIN);
    expect(d.hooks.stop('s2', false, git('h1', 'w2'))).not.toBeNull();
  });

  it('a note written in the turn the nudge asked for clears the counters', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    expect(d.hooks.stop('s1', false, git('h2', 'w1'))).not.toBeNull();
    note(d, p.id, 's1');
    expect(d.hooks.stop('s1', true, git('h2', 'w1'))).toBeNull();
    const row = d.sessions.row('s1');
    expect(row?.turnsSinceDiary).toBe(0);
    expect(row?.lastHeadSha).toBe('h2');
  });

  it('settings change the thresholds', () => {
    const { d } = setup();
    d.settings.update({ diaryNudgeTurns: 2 }, UI);
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    expect(d.hooks.stop('s1', false, git('h1', 'w2'))).toBeNull();
    expect(d.hooks.stop('s1', false, git('h1', 'w2'))).not.toBeNull();
  });

  it('never nudges unlinked sessions or read-only projects', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('u', { remote: 'git@github.com:example/other.git', head: 'h1' });
    expect(
      d.hooks.stop('u', false, { remote: 'git@github.com:example/other.git', head: 'h2' }),
    ).toBeNull();
    d.projects.update(p.id, { claudeWriteEnabled: false }, UI);
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    expect(d.hooks.stop('s1', false, git('h2', 'w1'))).toBeNull();
  });

  it('events (task completed) do not count as a diary note', () => {
    const { d, p } = setup();
    d.hooks.sessionStart('s1', git('h1', 'w1'));
    d.roadmap.completeTask(p.phases[0]!.tasks[0]!.id, { source: 'claude_code', sessionId: 's1' });
    expect(d.sessions.row('s1')?.lastDiaryAt).toBeNull();
  });
});

describe('docs from the Stop hook', () => {
  it('stores the local docs file only when its hash changes', () => {
    const { d, p, clock } = setup();
    d.hooks.sessionStart('s1', git());
    expect(d.hooks.docsTarget('s1')).toEqual({ path: 'DECISIONS.md', hash: null });
    const v1 = Buffer.from('# Decisions\n\n## D1 — Use SQLite\n');
    expect(d.hooks.storeDocs('s1', 'DECISIONS.md', v1)).toBe(true);
    expect(d.hooks.docsTarget('s1')?.hash).toBe(gitBlobSha(v1));
    clock.advance(MIN);
    expect(d.hooks.storeDocs('s1', 'DECISIONS.md', v1)).toBe(false);
    const docs = d.projects.docs(p.id);
    expect(docs).toMatchObject({ source: 'repo' });
    const repo = d.projects.get(p.id).repoDetails[0];
    expect(repo?.docsOrigin).toBe('hook');
    expect(d.search.search({ q: 'SQLite' }).some((h) => h.kind === 'repo_docs')).toBe(true);
  });

  it('git blob hash matches git hash-object', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('refuses a wrong path, invalid UTF-8, sessions without a repo and internal-docs projects', () => {
    const { d } = setup();
    d.hooks.sessionStart('s1', git());
    expectDomainError(() => d.hooks.storeDocs('s1', 'OTHER.md', Buffer.from('x')), 'conflict');
    expectDomainError(
      () => d.hooks.storeDocs('s1', 'DECISIONS.md', Buffer.from([0xe0, 0x80])),
      'validation',
    );
    d.hooks.sessionStart('s2', { remote: null });
    expect(d.hooks.docsTarget('s2')).toBeNull();
    expectDomainError(() => d.hooks.storeDocs('s2', 'DECISIONS.md', Buffer.from('x')), 'not_found');
    const internal = d.projects.create(
      { name: 'Internal', repos: ['example/internal'], docsSource: 'internal' },
      UI,
    );
    d.hooks.sessionStart('s3', { remote: 'git@github.com:example/internal.git' });
    expect(d.sessions.projectFor('s3')).toBe(internal.id);
    expect(d.hooks.docsTarget('s3')).toBeNull();
  });

  it('a custom docs path is used', () => {
    const { d, p } = setup();
    const repoId = d.projects.get(p.id).repoDetails[0]!.id;
    d.projects.updateRepo(repoId, { docsPath: 'docs/ADR.md' }, UI);
    d.hooks.sessionStart('s1', git());
    expect(d.hooks.docsTarget('s1')).toEqual({ path: 'docs/ADR.md', hash: null });
  });
});
