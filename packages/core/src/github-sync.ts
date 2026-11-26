import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { type DocsCommit, diaryEntries, projectRepos, projects } from './db/schema.js';
import type { Domain } from './domain.js';
import {
  commitsByDay,
  type GhCommit,
  type GhRelease,
  GitHubError,
  type GitHubPort,
} from './github.js';
import { gitBlobSha } from './hooks.js';
import { DAY_MS, iso } from './util.js';

type RepoRow = typeof projectRepos.$inferSelect;

const GITHUB: Ctx = { source: 'github' };
/** D62: linking a repo imports this much history. */
const BACKFILL_MS = 365 * DAY_MS;
const MAX_COMMITS = 2_000;
const MAX_RELEASES = 100;
const COMMITS_IN_EVENT = 50;
const DOCS_COMMITS = 5;

/** Global sync state shown in Settings and on the dashboard (D61). */
export interface GitHubStatus {
  /** Last run that reached GitHub without a global error. */
  lastSyncAt: string | null;
  /** A problem that stops every sync until fixed. */
  error: 'token_invalid' | 'rate_limited' | null;
  /** For rate_limited: when calls are allowed again. */
  resetAt: string | null;
}

export interface RepoSyncResult {
  repo: string;
  /** New diary events: commit days and releases. */
  commitEvents: number;
  releaseEvents: number;
  docsUpdated: boolean;
  error: string | null;
}

export interface SyncRun {
  /** Why nothing ran: no token, or calls blocked until the rate limit resets. */
  skipped: 'no_token' | 'rate_limited' | null;
  repos: RepoSyncResult[];
}

/**
 * GitHub polling (§10, D61-D63): commits of the default branch grouped per
 * local day and releases become diary events; the docs file is cached. The
 * first sync of a repo imports the last year (D62). GitHub failures never
 * escape: they become a repo error or the global status.
 */
export class GitHubSyncService {
  constructor(private readonly d: Domain) {}

  status(): GitHubStatus {
    return this.d.settings.githubStatus() ?? { lastSyncAt: null, error: null, resetAt: null };
  }

  /** Repos whose last poll is older than `githubPollMinutes` (or never polled). */
  async syncDue(port: GitHubPort): Promise<SyncRun> {
    const settings = this.d.settings.get();
    const cutoff = this.d.now() - settings.githubPollMinutes * 60_000;
    const due = this.d.db
      .select()
      .from(projectRepos)
      .orderBy(asc(projectRepos.id))
      .all()
      .filter((r) => r.lastPolledAt === null || r.lastPolledAt <= cutoff);
    return this.run(port, due);
  }

  /** "Sync now" for one project: all its repos, whatever their last poll. */
  async syncProject(projectId: number, port: GitHubPort): Promise<SyncRun> {
    const rows = this.d.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, projectId))
      .orderBy(asc(projectRepos.id))
      .all();
    return this.run(port, rows);
  }

  /** Runs never overlap: a Sync now during a poll waits, so nothing is imported twice. */
  private lock: Promise<unknown> = Promise.resolve();

  private run(port: GitHubPort, rows: RepoRow[]): Promise<SyncRun> {
    const next = this.lock.then(() => this.runNow(port, rows));
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async runNow(port: GitHubPort, rows: RepoRow[]): Promise<SyncRun> {
    if (!this.d.settings.get().githubToken) return { skipped: 'no_token', repos: [] };
    const st = this.status();
    if (st.error === 'rate_limited' && st.resetAt && Date.parse(st.resetAt) > this.d.now()) {
      return { skipped: 'rate_limited', repos: [] };
    }
    const results: RepoSyncResult[] = [];
    for (const listed of rows) {
      // Re-read: the row may have changed while an earlier run waited for GitHub.
      const row = this.repoRow(listed.id);
      if (!row) continue;
      if (
        rows.length > 1 &&
        listed.lastPolledAt !== row.lastPolledAt &&
        row.lastPolledAt !== null
      ) {
        // Polled meanwhile by a run that held the lock: not due anymore.
        if (this.d.now() - row.lastPolledAt < this.d.settings.get().githubPollMinutes * 60_000) {
          continue;
        }
      }
      try {
        results.push(await this.syncRepo(row, port));
      } catch (err) {
        if (err instanceof GitHubError && err.code === 'unauthorized') {
          this.setStatus({ ...this.status(), error: 'token_invalid', resetAt: null });
          return { skipped: null, repos: results };
        }
        if (err instanceof GitHubError && err.code === 'rate_limited') {
          this.setStatus({
            ...this.status(),
            error: 'rate_limited',
            resetAt: iso(err.resetAt ?? this.d.now() + 15 * 60_000),
          });
          return { skipped: null, repos: results };
        }
        const code = err instanceof GitHubError ? err.code : 'unavailable';
        this.markRepo(row.id, { lastSyncError: code, lastPolledAt: this.d.now() });
        results.push({
          repo: row.fullName,
          commitEvents: 0,
          releaseEvents: 0,
          docsUpdated: false,
          error: code,
        });
      }
    }
    this.setStatus({ lastSyncAt: iso(this.d.now()), error: null, resetAt: null });
    return { skipped: null, repos: results };
  }

  /** Syncs one repo; throws GitHubError for the caller to classify. */
  private async syncRepo(row: RepoRow, port: GitHubPort): Promise<RepoSyncResult> {
    const fullName = `${row.owner}/${row.name}`;
    const now = this.d.now();
    const first = row.backfilledAt === null;
    const info = await port.repo(fullName);
    const branch = info.defaultBranch;

    // Commits (D62): a year on the first sync, then everything after the last seen commit.
    // A branch change (new default branch) restarts from the last seen time.
    const sameBranch = row.defaultBranch === null || row.defaultBranch === branch;
    // A repo linked again after an unlink: continue from what the diary already has.
    const prior = first ? this.priorImport(row.projectId, fullName) : null;
    const seenSha = first ? (prior?.sha ?? null) : row.lastSeenCommitSha;
    const seenAt = first ? (prior?.at ?? null) : row.lastSeenCommitAt;
    const stopAt = sameBranch || first ? seenSha : null;
    const page = await port.commits(fullName, {
      branch,
      // With a known stop commit, walk back to it (merged commits can be older than it);
      // the year bound only caps the walk (D62, verification A6).
      since: iso(stopAt || seenAt === null ? now - BACKFILL_MS : seenAt),
      stopAt,
      max: MAX_COMMITS,
    });
    let commits = page.commits;
    if (seenAt !== null && !page.reachedStop) {
      // The last seen commit is gone (force push or branch change): keep only newer ones.
      commits = commits.filter((c) => Date.parse(c.date) > seenAt);
    }
    if (seenSha) commits = commits.filter((c) => c.sha !== seenSha);

    // Releases: the last year on the first sync, then the ones newer than the last seen.
    const all = (await port.releases(fullName, MAX_RELEASES)).filter(
      (r) => !r.draft && r.publishedAt,
    );
    let releases: GhRelease[];
    if (first) {
      const known = prior?.tags ?? new Set<string>();
      releases = all.filter(
        (r) => Date.parse(r.publishedAt as string) >= now - BACKFILL_MS && !known.has(r.tag),
      );
    } else {
      const at = all.findIndex((r) => r.id === row.lastReleaseId);
      releases =
        at === -1 && row.lastReleaseId !== null
          ? all.filter((r) => isNewer(r, row))
          : all.slice(0, at === -1 ? all.length : at);
    }

    // Docs (D63): only when GitHub's copy changed since we last read it.
    const project = this.d.db
      .select({ docsSource: projects.docsSource })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .get();
    let docs: {
      content: string;
      sha: string;
      hash: string;
      commits: DocsCommit[];
      pushedAt: number | null;
    } | null = null;
    let docsError: string | null = null;
    if (project?.docsSource === 'repo') {
      const file = await port.content(fullName, row.docsPath);
      if (file && file.sha !== row.docsGithubSha) {
        try {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
          const touched = await port.pathCommits(fullName, row.docsPath, DOCS_COMMITS);
          // D63, most recent change wins: a local copy from the Stop hook saved after
          // GitHub's last change to the file stays; only the GitHub bookkeeping moves.
          docs = {
            content,
            sha: file.sha,
            hash: gitBlobSha(file.bytes),
            commits: touched,
            pushedAt: touched[0] ? Date.parse(touched[0].date) : null,
          };
        } catch (err) {
          if (err instanceof GitHubError) throw err;
          docsError = 'docs_not_utf8';
        }
      }
    }

    const newest = page.commits[0];
    let commitEvents = 0;
    let docsWritten = false;
    this.d.tx(() => {
      // Re-read inside the transaction: the UI or a Stop hook may have changed the repo
      // while this sync waited for GitHub (verification A6).
      const fresh = this.repoRow(row.id);
      if (!fresh || fresh.projectId !== row.projectId) return; // unlinked meanwhile
      if (fresh.docsPath !== row.docsPath) docs = null; // the path changed: that copy is stale
      // D63, most recent change wins: a local copy from the Stop hook saved after
      // GitHub's last change to the file stays; only the GitHub bookkeeping moves.
      const keepLocal =
        docs !== null &&
        fresh.docsOrigin === 'hook' &&
        fresh.docsUpdatedAt !== null &&
        docs.pushedAt !== null &&
        docs.pushedAt < fresh.docsUpdatedAt;
      docsWritten = docs !== null && !keepLocal;
      if (fresh.showCommits) {
        for (const g of commitsByDay(commits, this.d.timeZone)) {
          this.d.diary.event(
            row.projectId,
            'commits',
            commitBody(g.commits, branch),
            {
              repo: fullName,
              branch,
              day: g.day,
              count: g.commits.length,
              commits: g.commits.slice(0, COMMITS_IN_EVENT),
              url: `${info.htmlUrl}/commits/${encodeURIComponent(branch)}`,
            },
            GITHUB,
            Date.parse(g.commits[0]?.date ?? iso(now)),
          );
          commitEvents++;
        }
      }
      for (const r of [...releases].reverse()) {
        this.d.diary.event(
          row.projectId,
          'release',
          `Release ${r.tag}${r.name && r.name !== r.tag ? `: ${r.name}` : ''}${r.prerelease ? ' (pre-release)' : ''}`,
          { repo: fullName, tag: r.tag, name: r.name, prerelease: r.prerelease, url: r.url },
          GITHUB,
          Date.parse(r.publishedAt as string),
        );
      }
      this.markRepo(row.id, {
        defaultBranch: branch,
        lastPolledAt: now,
        lastSyncError: docsError,
        ...(first ? { backfilledAt: now } : {}),
        ...(newest
          ? { lastSeenCommitSha: newest.sha, lastSeenCommitAt: Date.parse(newest.date) }
          : {}),
        ...(all[0] ? { lastReleaseId: all[0].id } : {}),
        ...(docs ? { docsGithubSha: docs.sha, docsCommits: docs.commits } : {}),
        ...(docs && docsWritten
          ? {
              docsContent: docs.content,
              docsHash: docs.hash,
              docsOrigin: 'github' as const,
              docsUpdatedAt: now,
            }
          : {}),
      });
    });
    return {
      repo: fullName,
      commitEvents,
      releaseEvents: releases.length,
      docsUpdated: docsWritten,
      error: docsError,
    };
  }

  private repoRow(id: number): RepoRow | undefined {
    return this.d.db.select().from(projectRepos).where(eq(projectRepos.id, id)).get();
  }

  /**
   * What an earlier link of the same repo already put in this project's diary:
   * the newest imported commit and the release tags, so a relink does not
   * import the year again (verification A6).
   */
  private priorImport(
    projectId: number,
    fullName: string,
  ): { sha: string; at: number; tags: Set<string> } | null {
    const repoIs = sql`lower(json_extract(${diaryEntries.data}, '$.repo')) = ${fullName.toLowerCase()}`;
    const last = this.d.db
      .select({ data: diaryEntries.data })
      .from(diaryEntries)
      .where(
        and(eq(diaryEntries.projectId, projectId), eq(diaryEntries.eventKind, 'commits'), repoIs),
      )
      .orderBy(desc(diaryEntries.occurredAt), desc(diaryEntries.id))
      .get();
    const tags = new Set(
      this.d.db
        .select({ data: diaryEntries.data })
        .from(diaryEntries)
        .where(
          and(eq(diaryEntries.projectId, projectId), eq(diaryEntries.eventKind, 'release'), repoIs),
        )
        .all()
        .map((r) => String(r.data?.tag ?? '')),
    );
    const c = (last?.data?.commits as { sha?: string; date?: string }[] | undefined)?.[0];
    if (!c?.sha || !c.date) return tags.size ? { sha: '', at: 0, tags } : null;
    return { sha: c.sha, at: Date.parse(c.date), tags };
  }

  private markRepo(id: number, set: Partial<typeof projectRepos.$inferInsert>): void {
    this.d.db
      .update(projectRepos)
      .set({ ...set, updatedAt: this.d.now() })
      .where(eq(projectRepos.id, id))
      .run();
  }

  private setStatus(s: GitHubStatus): void {
    this.d.settings.setGithubStatus(s);
  }
}

/** Releases newer than the last seen one, when that one is no longer listed. */
function isNewer(r: GhRelease, row: RepoRow): boolean {
  return row.lastPolledAt === null || Date.parse(r.publishedAt as string) > row.lastPolledAt;
}

/** "3 commits on main: <latest message>" (events are English, like the other events). */
function commitBody(commits: GhCommit[], branch: string): string {
  const n = commits.length;
  const latest = commits[0]?.message ?? '';
  return `${n} ${n === 1 ? 'commit' : 'commits'} on ${branch}${latest ? `: ${latest}` : ''}`;
}
