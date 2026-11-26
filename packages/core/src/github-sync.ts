import { asc, eq } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { type DocsCommit, projectRepos, projects } from './db/schema.js';
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

  private async run(port: GitHubPort, rows: RepoRow[]): Promise<SyncRun> {
    if (!this.d.settings.get().githubToken) return { skipped: 'no_token', repos: [] };
    const st = this.status();
    if (st.error === 'rate_limited' && st.resetAt && Date.parse(st.resetAt) > this.d.now()) {
      return { skipped: 'rate_limited', repos: [] };
    }
    const results: RepoSyncResult[] = [];
    for (const row of rows) {
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
    const page = await port.commits(fullName, {
      branch,
      since: iso(first ? now - BACKFILL_MS : (row.lastSeenCommitAt ?? now - BACKFILL_MS)),
      stopAt: first || !sameBranch ? null : row.lastSeenCommitSha,
      max: MAX_COMMITS,
    });
    let commits = page.commits;
    if (!first && !page.reachedStop && row.lastSeenCommitAt !== null) {
      // The last seen commit is gone (force push or branch change): keep only newer ones.
      const seenAt = row.lastSeenCommitAt;
      commits = commits.filter((c) => Date.parse(c.date) > seenAt);
    }
    if (!first && row.lastSeenCommitSha) {
      commits = commits.filter((c) => c.sha !== row.lastSeenCommitSha);
    }

    // Releases: the last year on the first sync, then the ones newer than the last seen.
    const all = (await port.releases(fullName, MAX_RELEASES)).filter(
      (r) => !r.draft && r.publishedAt,
    );
    let releases: GhRelease[];
    if (first) {
      releases = all.filter((r) => Date.parse(r.publishedAt as string) >= now - BACKFILL_MS);
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
      keepLocal: boolean;
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
          const pushedAt = touched[0] ? Date.parse(touched[0].date) : null;
          const keepLocal =
            row.docsOrigin === 'hook' &&
            row.docsUpdatedAt !== null &&
            pushedAt !== null &&
            pushedAt < row.docsUpdatedAt;
          docs = {
            content,
            sha: file.sha,
            hash: gitBlobSha(file.bytes),
            commits: touched,
            keepLocal,
          };
        } catch (err) {
          if (err instanceof GitHubError) throw err;
          docsError = 'docs_not_utf8';
        }
      }
    }

    const newest = page.commits[0];
    let commitEvents = 0;
    this.d.tx(() => {
      if (row.showCommits) {
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
        ...(docs && !docs.keepLocal
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
      docsUpdated: docs !== null && !docs.keepLocal,
      error: docsError,
    };
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
