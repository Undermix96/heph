import {
  type GhCommit,
  type GhContent,
  type GhRelease,
  GitHubError,
  type GitHubPort,
} from '../github.js';
import { gitBlobSha } from '../hooks.js';

/** An invented repo kept in memory by FakeGitHub. */
export interface FakeRepo {
  defaultBranch: string;
  /** Per branch, newest first. */
  commits: Record<string, GhCommit[]>;
  /** Newest first. */
  releases: GhRelease[];
  files: Record<string, { text: string | Buffer; commits: GhCommit[] }>;
}

/**
 * In-memory GitHubPort for tests (invented data). `fail` makes the next calls
 * throw; `calls` counts requests per method.
 */
export class FakeGitHub implements GitHubPort {
  repos = new Map<string, FakeRepo>();
  fail: GitHubError | null = null;
  calls: Record<string, number> = {};

  add(fullName: string, repo: Partial<FakeRepo> = {}): FakeRepo {
    const r: FakeRepo = {
      defaultBranch: 'main',
      commits: { main: [] },
      releases: [],
      files: {},
      ...repo,
    };
    this.repos.set(fullName.toLowerCase(), r);
    return r;
  }

  /** Pushes a commit (newest first) on a branch of a repo. */
  push(fullName: string, c: Partial<GhCommit> & { date: string }, branch?: string): GhCommit {
    const r = this.get(fullName);
    const b = branch ?? r.defaultBranch;
    const n = (r.commits[b]?.length ?? 0) + 1;
    const commit: GhCommit = {
      sha: c.sha ?? `${b}${n}`.padEnd(40, '0').slice(0, 40),
      message: c.message ?? `Commit ${n}`,
      author: c.author ?? 'Invented Dev',
      date: c.date,
      url: `https://github.com/${fullName}/commit/${c.sha ?? n}`,
    };
    r.commits[b] = [commit, ...(r.commits[b] ?? [])];
    return commit;
  }

  private get(fullName: string): FakeRepo {
    const r = this.repos.get(fullName.toLowerCase());
    if (!r) throw new GitHubError('not_found', `${fullName} not found`);
    return r;
  }

  private call(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (this.fail) throw this.fail;
  }

  async repo(fullName: string) {
    this.call('repo');
    const r = this.get(fullName);
    return { defaultBranch: r.defaultBranch, htmlUrl: `https://github.com/${fullName}` };
  }

  async commits(
    fullName: string,
    o: { branch: string; since: string; stopAt: string | null; max: number },
  ) {
    this.call('commits');
    const list = this.get(fullName).commits[o.branch] ?? [];
    const out: GhCommit[] = [];
    let reachedStop = false;
    for (const c of list) {
      if (o.stopAt && c.sha === o.stopAt) {
        reachedStop = true;
        break;
      }
      if (c.date < o.since) break;
      if (out.length === o.max) return { commits: out, reachedStop, truncated: true };
      out.push(c);
    }
    return { commits: out, reachedStop, truncated: false };
  }

  async releases(fullName: string, max: number) {
    this.call('releases');
    return this.get(fullName).releases.slice(0, max);
  }

  async content(fullName: string, path: string): Promise<GhContent | null> {
    this.call('content');
    const f = this.get(fullName).files[path];
    if (!f) return null;
    const bytes = Buffer.isBuffer(f.text) ? f.text : Buffer.from(f.text);
    return {
      sha: gitBlobSha(bytes),
      bytes,
      htmlUrl: `https://github.com/${fullName}/blob/x/${path}`,
    };
  }

  async pathCommits(fullName: string, path: string, n: number) {
    this.call('pathCommits');
    return (this.get(fullName).files[path]?.commits ?? []).slice(0, n);
  }

  async whoami() {
    this.call('whoami');
    return { login: 'invented-user', repoCount: this.repos.size };
  }
}
