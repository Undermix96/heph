import { DEFAULT_SETTINGS } from '@heph/schema';
import { describe, expect, it } from 'vitest';
import { diaryDue, isTestCommand, type StopSnapshot } from './autodiary.js';

const P = DEFAULT_SETTINGS.testCommandPatterns;

describe('isTestCommand', () => {
  it.each([
    'npm test',
    'npm test -- --run',
    'npm run test',
    'cd apps/web && npx vitest run src',
    'pytest -k smoke; echo done',
    'git pull || pytest',
    'CI=1 npm test',
    'FOO="a b" BAR=1 go test ./...',
    'npx playwright test --trace off',
    'npm run build\nnpm test',
    '& npm test', // PowerShell call operator
    'npm run lint | tee x && cargo test',
  ])('recognises %j', (cmd) => {
    expect(isTestCommand(cmd, P)).toBe(true);
  });

  it.each([
    'npm install',
    'npm run testing-tools', // not followed by end or whitespace
    'echo npm test', // the pattern is not at the start of a command
    'git commit -m "fix vitest config"',
    'grep -r pytest .',
    'NPM TEST', // case-sensitive
    '',
  ])('ignores %j', (cmd) => {
    expect(isTestCommand(cmd, P)).toBe(false);
  });

  it('uses only the configured patterns, trimmed, skipping empty ones', () => {
    expect(isTestCommand('make check', ['make check'])).toBe(true);
    expect(isTestCommand('make check', ['  make check  '])).toBe(true);
    expect(isTestCommand('npm test', ['make check', ' '])).toBe(false);
    expect(isTestCommand('npm test', [])).toBe(false);
  });
});

const T = { diaryNudgeTurns: 5, diaryNudgeMinutes: 30 };

function snap(over: Partial<StopSnapshot> = {}): StopSnapshot {
  return {
    stopHookActive: false,
    linked: true,
    head: 'h1',
    worktree: 'w1',
    baselineHead: 'h1',
    baselineWorktree: 'w1',
    turnsSinceDiary: 1,
    turnsSinceNudge: null,
    minutesSinceDiary: 1,
    ...over,
  };
}

describe('diaryDue (D59: changes + threshold)', () => {
  it('nothing changed: never due, however long', () => {
    expect(diaryDue(snap({ turnsSinceDiary: 50, minutesSinceDiary: 600 }), T)).toBe(false);
  });

  it('a new commit is due at once', () => {
    expect(diaryDue(snap({ head: 'h2' }), T)).toBe(true);
  });

  it('uncommitted changes wait for the turn or minute threshold', () => {
    const changed = { worktree: 'w2' };
    expect(diaryDue(snap({ ...changed, turnsSinceDiary: 4 }), T)).toBe(false);
    expect(diaryDue(snap({ ...changed, turnsSinceDiary: 5 }), T)).toBe(true);
    expect(diaryDue(snap({ ...changed, minutesSinceDiary: 29.9 }), T)).toBe(false);
    expect(diaryDue(snap({ ...changed, minutesSinceDiary: 30 }), T)).toBe(true);
  });

  it('never while a Stop hook already made Claude continue, nor for unlinked sessions', () => {
    expect(diaryDue(snap({ head: 'h2', stopHookActive: true }), T)).toBe(false);
    expect(diaryDue(snap({ head: 'h2', linked: false }), T)).toBe(false);
  });

  it('after a nudge, waits diaryNudgeTurns turns', () => {
    expect(diaryDue(snap({ head: 'h2', turnsSinceNudge: 0 }), T)).toBe(false);
    expect(diaryDue(snap({ head: 'h2', turnsSinceNudge: 4 }), T)).toBe(false);
    expect(diaryDue(snap({ head: 'h2', turnsSinceNudge: 5 }), T)).toBe(true);
  });

  it('outside git only the thresholds count', () => {
    const noGit = { head: null, worktree: null, baselineHead: null, baselineWorktree: null };
    expect(diaryDue(snap({ ...noGit, turnsSinceDiary: 4 }), T)).toBe(false);
    expect(diaryDue(snap({ ...noGit, turnsSinceDiary: 5 }), T)).toBe(true);
  });

  it('a repo without commits counts work tree changes only', () => {
    const fresh = { head: null, baselineHead: null };
    expect(diaryDue(snap({ ...fresh, worktree: 'w2', turnsSinceDiary: 5 }), T)).toBe(true);
    expect(diaryDue(snap({ ...fresh, turnsSinceDiary: 5 }), T)).toBe(false);
  });
});
