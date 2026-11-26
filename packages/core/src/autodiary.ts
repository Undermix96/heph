/**
 * Pure rules behind the Claude Code hooks (§9): test-command recognition and
 * the auto-diary nudge (D59). No I/O; the sessions service feeds them.
 */

/** Characters that separate shell commands in a Bash or PowerShell line. */
const SEPARATOR = /&&|\|\||[;|\n&]/;

/**
 * True when one of the commands in `command` starts with a test pattern
 * (e.g. `npm test`, `cd app && npx vitest run`, `pytest -k x; echo done`).
 * Patterns are plain text, compared case-sensitively at the start of a
 * command, followed by the end or whitespace. Leading `VAR=value` assignments,
 * the PowerShell call operator `&` and `npx` are skipped, so `npx playwright
 * test` matches the pattern `playwright test`.
 */
export function isTestCommand(command: string, patterns: readonly string[]): boolean {
  const parts = command.split(SEPARATOR).map((p) => p.trim());
  const candidates = parts.flatMap((p) => {
    const bare = stripPrefix(p);
    return bare === p ? [p] : [p, bare];
  });
  return candidates.some((part) =>
    patterns.some((raw) => {
      const pattern = raw.trim();
      if (!pattern || !part.startsWith(pattern)) return false;
      const next = part.charAt(pattern.length);
      return next === '' || /\s/.test(next);
    }),
  );
}

/** Drops leading env assignments (`CI=1 npm test`), a PowerShell call operator and `npx`. */
function stripPrefix(part: string): string {
  let rest = part.replace(/^&\s*/, '');
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest.replace(/^npx\s+/, '');
}

/** What a session knows when its turn ends (Stop hook). */
export interface StopSnapshot {
  /** A Stop hook already made Claude continue this turn. */
  stopHookActive: boolean;
  /** The session is linked to a project. */
  linked: boolean;
  /** Git state now; null outside a git work tree. */
  head: string | null;
  worktree: string | null;
  /** Git state at the last diary note (or at session start). */
  baselineHead: string | null;
  baselineWorktree: string | null;
  /** Turns ended since the last diary note, this one included. */
  turnsSinceDiary: number;
  /** Turns ended since the last nudge, this one included; null if never nudged. */
  turnsSinceNudge: number | null;
  /** Minutes since the last diary note, or since the session started. */
  minutesSinceDiary: number;
}

export interface NudgeThresholds {
  diaryNudgeTurns: number;
  diaryNudgeMinutes: number;
}

/**
 * D59 "changes + threshold": ask for a diary note when work changed since the
 * last note and a commit was made, or enough turns or minutes passed. Never
 * twice in a row: after a nudge, wait `diaryNudgeTurns` turns.
 */
export function diaryDue(s: StopSnapshot, t: NudgeThresholds): boolean {
  if (s.stopHookActive || !s.linked) return false;
  if (s.turnsSinceNudge !== null && s.turnsSinceNudge < t.diaryNudgeTurns) return false;
  const enough =
    s.turnsSinceDiary >= t.diaryNudgeTurns || s.minutesSinceDiary >= t.diaryNudgeMinutes;
  if (s.head === null && s.worktree === null) return enough; // not a git repo
  const committed = s.head !== null && s.baselineHead !== null && s.head !== s.baselineHead;
  const changed = committed || (s.worktree !== null && s.worktree !== s.baselineWorktree);
  return changed && (committed || enough);
}
