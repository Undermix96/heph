/**
 * GitHub as seen by the domain (§10, D61): a port the server implements over
 * the REST API (apps/server/src/github/http.ts) and tests implement in memory.
 * The domain never makes HTTP calls itself.
 */

export interface GhRepo {
  defaultBranch: string;
  htmlUrl: string;
}

export interface GhCommit {
  sha: string;
  /** First line of the commit message. */
  message: string;
  author: string | null;
  /** Commit date, ISO 8601. */
  date: string;
  url: string;
}

export interface GhRelease {
  id: string;
  tag: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  url: string;
  /** ISO 8601; null for drafts. */
  publishedAt: string | null;
}

export interface GhContent {
  /** Git blob SHA-1 of the file (same as `git hash-object`). */
  sha: string;
  bytes: Buffer;
  htmlUrl: string;
}

export interface GhCommitPage {
  /** Newest first. */
  commits: GhCommit[];
  /** The walk reached `stopAt` (which is not included). */
  reachedStop: boolean;
  /** More commits existed than `max`. */
  truncated: boolean;
}

export interface GitHubPort {
  repo(fullName: string): Promise<GhRepo>;
  /**
   * Commits of `branch`, newest first, not older than `since` (ISO), stopping
   * before `stopAt` when given, at most `max`.
   */
  commits(
    fullName: string,
    opts: { branch: string; since: string; stopAt: string | null; max: number },
  ): Promise<GhCommitPage>;
  /** Releases newest first, at most `max`. */
  releases(fullName: string, max: number): Promise<GhRelease[]>;
  /** A file on the default branch, or null when it does not exist. */
  content(fullName: string, path: string): Promise<GhContent | null>;
  /** The last `n` commits that touched `path`, newest first. */
  pathCommits(fullName: string, path: string, n: number): Promise<GhCommit[]>;
  /** The token's user and how many repositories it can read. */
  whoami(): Promise<{ login: string; repoCount: number }>;
}

export type GitHubErrorCode = 'unauthorized' | 'not_found' | 'rate_limited' | 'unavailable';

/** What a GitHub call can fail with; the sync turns these into states, never crashes. */
export class GitHubError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    /** For rate_limited: unix ms when calls are allowed again. */
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Groups commits (any order) by local day; days oldest first, commits newest first. */
export function commitsByDay(
  commits: GhCommit[],
  timeZone: string,
): { day: string; commits: GhCommit[] }[] {
  const by = new Map<string, GhCommit[]>();
  // By instant, not by string: precision and offsets vary (verification A6).
  for (const c of [...commits].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))) {
    const day = localDay(c.date, timeZone);
    by.set(day, [...(by.get(day) ?? []), c]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({ day, commits: list }));
}
