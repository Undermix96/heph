import {
  type ClaudeQueueView,
  type LiveSessionView,
  type QueueItemView,
  QueueQuery,
  RepoFullName,
} from '@heph/schema';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { diaryDue, isTestCommand } from './autodiary.js';
import { claudeSessions, diaryEntries, projectRepos, projects } from './db/schema.js';
import type { Domain } from './domain.js';
import { iso, parse } from './util.js';

type SessionRow = typeof claudeSessions.$inferSelect;

/** Most ended sessions listed in Claude's queue. */
export const QUEUE_ENDED_MAX = 20;

/** What a hook script reports from the machine Claude Code runs on (§9). */
export interface HookFacts {
  /** `git remote get-url origin`, as printed; null outside a repo or without a remote. */
  remote?: string | null;
  cwd?: string | null;
  /** `git rev-parse HEAD`; null outside a git work tree or before the first commit. */
  head?: string | null;
  /** Hash of `git status --porcelain`: changes when the work tree changes. */
  worktree?: string | null;
}

export interface StopResult {
  /** Claude should be asked to write a diary note (D59). */
  nudge: boolean;
  projectId: number | null;
}

/**
 * Live Claude Code sessions (§5, §9). The plugin hooks open, update and close
 * them (D58); stale ones expire server-side after `sessionExpiryMinutes`.
 * Every hook call upserts the session, so a session whose SessionStart was
 * missed (Heph down at the time) still appears once Heph is reachable.
 */
export class SessionsService {
  constructor(private readonly d: Domain) {}

  /** Open sessions with a heartbeat within the expiry window, by project. */
  liveFor(projectIds: number[]): Map<number, LiveSessionView[]> {
    const out = new Map<number, LiveSessionView[]>();
    if (projectIds.length === 0) return out;
    const cutoff = this.d.now() - this.d.settings.get().sessionExpiryMinutes * 60_000;
    const rows = this.d.db
      .select()
      .from(claudeSessions)
      .where(
        and(
          inArray(claudeSessions.projectId, projectIds),
          isNull(claudeSessions.endedAt),
          gt(claudeSessions.lastHeartbeatAt, cutoff),
        ),
      )
      .all();
    for (const r of rows) {
      if (r.projectId === null) continue;
      out.set(r.projectId, [
        ...(out.get(r.projectId) ?? []),
        {
          sessionId: r.sessionId,
          repo: r.repo,
          startedAt: iso(r.startedAt),
          lastHeartbeatAt: iso(r.lastHeartbeatAt),
          isTesting: r.isTesting,
          testingSince: iso(r.testingSince),
        },
      ]);
    }
    return out;
  }

  /**
   * Claude's queue on the dashboard (D76): sessions linked to a project that are
   * running, and those that ended (or went silent) since `since` — the start of
   * the viewer's local day — when they wrote at least one diary entry.
   */
  queue(query: unknown): ClaudeQueueView {
    const { since } = parse(QueueQuery, query);
    const cutoff = this.d.now() - this.d.settings.get().sessionExpiryMinutes * 60_000;
    const rows = this.d.db
      .select({ s: claudeSessions, slug: projects.slug, name: projects.name })
      .from(claudeSessions)
      .innerJoin(projects, eq(projects.id, claudeSessions.projectId))
      .where(
        or(
          isNull(claudeSessions.endedAt),
          and(isNotNull(claudeSessions.endedAt), gte(claudeSessions.endedAt, since)),
        ),
      )
      .all();
    const running: QueueItemView[] = [];
    const ended: QueueItemView[] = [];
    for (const { s, slug, name } of rows) {
      const live = s.endedAt === null && s.lastHeartbeatAt > cutoff;
      // A session closed by expireStale() ended at its last heartbeat, not when the
      // housekeeping ran (verification C9).
      const endedAt = live
        ? null
        : s.endedAt === null || s.endReason === 'expired'
          ? s.lastHeartbeatAt
          : s.endedAt;
      if (endedAt !== null && endedAt < since) continue;
      const last = this.lastEntry(s.sessionId);
      if (!live && last === null) continue;
      const item: QueueItemView = {
        sessionId: s.sessionId,
        projectId: s.projectId as number,
        projectSlug: slug,
        projectName: name,
        state: live ? (s.isTesting ? 'testing' : 'working') : 'ended',
        startedAt: iso(s.startedAt),
        endedAt: iso(endedAt),
        lastEntry: last,
      };
      (live ? running : ended).push(item);
    }
    running.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    ended.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
    return { running, ended: ended.slice(0, QUEUE_ENDED_MAX) };
  }

  /** The session's newest diary entry, cut to 300 characters (D76). */
  private lastEntry(sessionId: string): QueueItemView['lastEntry'] {
    const e = this.d.db
      .select({ body: diaryEntries.body, occurredAt: diaryEntries.occurredAt })
      .from(diaryEntries)
      .where(eq(diaryEntries.sessionId, sessionId))
      .orderBy(desc(diaryEntries.occurredAt), desc(diaryEntries.id))
      .limit(1)
      .get();
    if (!e) return null;
    // Cut by code points, so a character outside the BMP is never split (C9).
    const chars = Array.from(e.body.trim());
    return {
      body: chars.length > 300 ? `${chars.slice(0, 299).join('')}…` : chars.join(''),
      occurredAt: iso(e.occurredAt),
    };
  }

  /** Project a Claude Code session is linked to (set by the hooks). */
  projectFor(sessionId: string): number | null {
    return this.row(sessionId)?.projectId ?? null;
  }

  row(sessionId: string): SessionRow | undefined {
    return this.d.db
      .select()
      .from(claudeSessions)
      .where(eq(claudeSessions.sessionId, sessionId))
      .get();
  }

  /** SessionStart: opens (or reopens) the session and links it to the repo's project. */
  start(sessionId: string, facts: HookFacts): SessionRow {
    return this.d.tx(() => {
      const row = this.upsert(sessionId, facts);
      return this.update(row, { isTesting: false, testingSince: null, testingToolUseId: null });
    });
  }

  /**
   * PreToolUse on a shell tool: a test command marks the session as testing.
   * Several runs can overlap (background or parallel tool calls): their tool
   * call ids are kept, space-separated, in `testingToolUseId`.
   */
  toolStart(sessionId: string, toolUseId: string | null, command: string, facts: HookFacts): void {
    this.d.tx(() => {
      const row = this.upsert(sessionId, facts);
      if (!isTestCommand(command, this.d.settings.get().testCommandPatterns)) return;
      const ids = runIds(row);
      if (toolUseId && !ids.includes(toolUseId)) ids.push(toolUseId);
      this.update(row, {
        isTesting: true,
        testingSince: row.isTesting ? row.testingSince : this.d.now(),
        testingToolUseId: ids.length ? ids.join(' ') : null,
      });
    });
  }

  /** PostToolUse on a shell tool: testing ends when the last run that started it is over. */
  toolEnd(sessionId: string, toolUseId: string | null, facts: HookFacts): void {
    this.d.tx(() => {
      const row = this.upsert(sessionId, facts);
      const ids = runIds(row);
      if (!row.isTesting || toolUseId === null || !ids.includes(toolUseId)) return;
      const rest = ids.filter((id) => id !== toolUseId);
      this.update(
        row,
        rest.length
          ? { testingToolUseId: rest.join(' ') }
          : { isTesting: false, testingSince: null, testingToolUseId: null },
      );
    });
  }

  /**
   * Stop (end of a turn): heartbeat, end any test run, count the turn and
   * decide whether a diary note is due (D59). A note written since the last
   * Stop moves the "work changed" baseline to the current git state.
   */
  stop(sessionId: string, stopHookActive: boolean, facts: HookFacts): StopResult {
    return this.d.tx(() => {
      const row = this.upsert(sessionId, facts);
      const now = this.d.now();
      // noteWritten() clears lastStopAt, so "a note since the last Stop" needs no clock comparison.
      const noteSinceLastStop = row.lastDiaryAt !== null && row.lastStopAt === null;
      const counted = stopHookActive ? 0 : 1;
      let baselineHead = row.lastHeadSha;
      let baselineWorktree = row.lastWorktreeHash;
      let turnsSinceDiary = row.turnsSinceDiary + counted;
      // A session first seen by a hook without git facts (SessionStart missed)
      // takes its baseline from the first git state it reports.
      if (baselineHead === null && baselineWorktree === null) {
        baselineHead = facts.head ?? null;
        baselineWorktree = facts.worktree ?? null;
      }
      if (noteSinceLastStop) {
        baselineHead = facts.head ?? null;
        baselineWorktree = facts.worktree ?? null;
        turnsSinceDiary = 0;
      }
      let turnsSinceNudge = row.turnsSinceNudge === null ? null : row.turnsSinceNudge + counted;
      const settings = this.d.settings.get();
      const nudge = diaryDue(
        {
          stopHookActive,
          // Read-only projects (Claude write off) are never nudged: Claude could not write.
          linked: row.projectId !== null && this.writable(row.projectId),
          head: facts.head ?? null,
          worktree: facts.worktree ?? null,
          baselineHead,
          baselineWorktree,
          turnsSinceDiary,
          turnsSinceNudge,
          minutesSinceDiary: (now - (row.lastDiaryAt ?? row.startedAt)) / 60_000,
        },
        settings,
      );
      if (nudge) turnsSinceNudge = 0;
      this.update(row, {
        isTesting: false,
        testingSince: null,
        testingToolUseId: null,
        lastHeadSha: baselineHead,
        lastWorktreeHash: baselineWorktree,
        turnsSinceDiary,
        turnsSinceNudge,
        lastStopAt: now,
      });
      if (row.projectId !== null) this.d.projects.touch(row.projectId, now);
      return { nudge, projectId: row.projectId };
    });
  }

  /** SessionEnd: closes the session. Unknown sessions are ignored. */
  end(sessionId: string, reason: string | null): void {
    const row = this.row(sessionId);
    if (!row || row.endedAt !== null) return;
    this.update(row, {
      endedAt: this.d.now(),
      endReason: (reason ?? 'other').slice(0, 100),
      isTesting: false,
      testingSince: null,
      testingToolUseId: null,
    });
  }

  /** An MCP write within a session counts as a heartbeat of an open session. */
  heartbeat(sessionId: string): void {
    const now = this.d.now();
    this.d.db
      .update(claudeSessions)
      .set({ lastHeartbeatAt: now, updatedAt: now })
      .where(and(eq(claudeSessions.sessionId, sessionId), isNull(claudeSessions.endedAt)))
      .run();
  }

  /** A diary note was written in this session: the auto-diary counters restart at the next Stop. */
  noteWritten(sessionId: string, at: number): void {
    this.d.db
      .update(claudeSessions)
      .set({ lastDiaryAt: at, lastStopAt: null, updatedAt: this.d.now() })
      .where(eq(claudeSessions.sessionId, sessionId))
      .run();
  }

  /**
   * A repo was linked: open sessions on it now belong to that project, also
   * when they were on another one (the repo was moved; a repo belongs to at
   * most one project).
   */
  attachRepo(fullName: string, projectId: number): void {
    this.d.db
      .update(claudeSessions)
      .set({ projectId, updatedAt: this.d.now() })
      .where(and(eq(claudeSessions.repo, fullName.toLowerCase()), isNull(claudeSessions.endedAt)))
      .run();
  }

  /** Closes sessions without events for longer than the expiry window. Returns how many. */
  expireStale(): number {
    const now = this.d.now();
    const cutoff = now - this.d.settings.get().sessionExpiryMinutes * 60_000;
    return this.d.db
      .update(claudeSessions)
      .set({
        endedAt: now,
        endReason: 'expired',
        isTesting: false,
        testingSince: null,
        testingToolUseId: null,
        updatedAt: now,
      })
      .where(and(isNull(claudeSessions.endedAt), lte(claudeSessions.lastHeartbeatAt, cutoff)))
      .run().changes;
  }

  // ------------------------------------------------------------ internals

  /**
   * Creates the session, or records a heartbeat and reopens it if it had
   * ended (a session idle past the expiry window that comes back). Links it
   * to a project when its repo is linked and it has none yet.
   */
  private upsert(sessionId: string, facts: HookFacts): SessionRow {
    const now = this.d.now();
    const repo = repoOf(facts.remote);
    const projectId = repo ? this.projectOfRepo(repo) : null;
    const existing = this.row(sessionId);
    if (!existing) {
      return this.d.db
        .insert(claudeSessions)
        .values({
          sessionId,
          projectId,
          repo,
          cwd: facts.cwd ?? null,
          startedAt: now,
          lastHeartbeatAt: now,
          lastHeadSha: facts.head ?? null,
          lastWorktreeHash: facts.worktree ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    }
    return this.update(existing, {
      lastHeartbeatAt: now,
      endedAt: null,
      endReason: null,
      ...(repo !== null && repo !== existing.repo ? { repo } : {}),
      ...(facts.cwd ? { cwd: facts.cwd } : {}),
      ...(projectId !== null && projectId !== existing.projectId ? { projectId } : {}),
    });
  }

  private update(row: SessionRow, set: Partial<typeof claudeSessions.$inferInsert>): SessionRow {
    return this.d.db
      .update(claudeSessions)
      .set({ ...set, updatedAt: this.d.now() })
      .where(eq(claudeSessions.id, row.id))
      .returning()
      .get() as SessionRow;
  }

  private writable(projectId: number): boolean {
    return (
      this.d.db
        .select({ w: projects.claudeWriteEnabled })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()?.w ?? false
    );
  }

  private projectOfRepo(fullName: string): number | null {
    return (
      this.d.db
        .select({ projectId: projectRepos.projectId })
        .from(projectRepos)
        .where(eq(projectRepos.fullName, fullName))
        .get()?.projectId ?? null
    );
  }
}

/** Lower-cased `owner/name` of a GitHub remote, or null for anything else. */
export function repoOf(remote: string | null | undefined): string | null {
  if (!remote?.trim()) return null;
  const r = RepoFullName.safeParse(remote);
  return r.success ? r.data.toLowerCase() : null;
}

/** Tool call ids of the test runs in progress. */
function runIds(row: SessionRow): string[] {
  return row.testingToolUseId ? row.testingToolUseId.split(' ').filter(Boolean) : [];
}
