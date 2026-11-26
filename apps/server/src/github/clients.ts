import { type Domain, GitHubError, type SyncRun } from '@heph/core';
import { HttpGitHub } from './http.js';

export type VerifyResult =
  | { ok: true; login: string; repoCount: number }
  | { ok: false; error: 'no_token' | 'unauthorized' | 'rate_limited' | 'unavailable' };

/**
 * The server's GitHub access (D61): one HttpGitHub per configured token (its
 * ETag cache survives between polls) and one sync at a time, so the periodic
 * poll and "Sync now" never run against the same repo concurrently.
 */
export class GitHubClients {
  private cached: { token: string; port: HttpGitHub } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly domain: Domain,
    private readonly baseUrl: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** The client for the current token, or null when no token is set (no polling, D62). */
  port(): HttpGitHub | null {
    const token = this.domain.settings.get().githubToken;
    if (!token) return null;
    if (this.cached?.token !== token) {
      this.cached = {
        token,
        port: new HttpGitHub({
          token,
          baseUrl: this.baseUrl,
          fetch: this.fetchImpl,
          now: this.domain.now,
        }),
      };
    }
    return this.cached.port;
  }

  /** Periodic poll: repos due by `githubPollMinutes`. */
  syncDue(): Promise<SyncRun> {
    return this.serial(async () => {
      const port = this.port();
      return port ? this.domain.github.syncDue(port) : { skipped: 'no_token', repos: [] };
    });
  }

  /** "Sync now" for one project. */
  syncProject(projectId: number): Promise<SyncRun> {
    return this.serial(async () => {
      const port = this.port();
      return port
        ? this.domain.github.syncProject(projectId, port)
        : { skipped: 'no_token', repos: [] };
    });
  }

  /** Settings > GitHub > Verify: who the token is and how many repos it reads. */
  async verify(): Promise<VerifyResult> {
    const port = this.port();
    if (!port) return { ok: false, error: 'no_token' };
    try {
      return { ok: true, ...(await port.whoami()) };
    } catch (err) {
      const code = err instanceof GitHubError ? err.code : 'unavailable';
      return { ok: false, error: code === 'not_found' ? 'unauthorized' : code };
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
