import {
  type GhCommit,
  type GhCommitPage,
  type GhContent,
  type GhRelease,
  GitHubError,
  type GitHubPort,
  gitBlobSha,
} from '@heph/core';

/** GitHub REST API version this adapter is written for (checked 2026-11-26, D61). */
export const GITHUB_API_VERSION = '2022-11-28';
const PER_PAGE = 100;
/** ETag cache entries kept per client, least recently used dropped first (verification B6). */
const MAX_CACHED = 200;

export interface HttpGitHubOptions {
  /** null only for the opt-in smoke test on public repos (no polling without a token, D62). */
  token: string | null;
  /** `https://api.github.com`, or a fake in tests and e2e (`HEPH_GITHUB_API_URL`). */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface Cached {
  etag: string;
  body: unknown;
  link: string | null;
}

/**
 * GitHubPort over the REST API (D61): bearer token, pinned API version,
 * conditional requests with ETags (a 304 is cheap), `Link` pagination, and
 * every failure mapped to a GitHubError code. Never logs the token.
 */
export class HttpGitHub implements GitHubPort {
  private readonly etags = new Map<string, Cached>();
  private readonly fetch: typeof fetch;
  private readonly base: string;

  constructor(private readonly o: HttpGitHubOptions) {
    this.fetch = o.fetch ?? fetch;
    this.base = o.baseUrl.replace(/\/+$/, '');
  }

  async repo(fullName: string) {
    const r = (await this.json(`/repos/${repoPath(fullName)}`)).body as {
      default_branch: string;
      html_url: string;
    };
    return { defaultBranch: r.default_branch, htmlUrl: r.html_url };
  }

  async commits(
    fullName: string,
    o: { branch: string; since: string; stopAt: string | null; max: number },
  ): Promise<GhCommitPage> {
    const out: GhCommit[] = [];
    let url: string | null =
      `/repos/${repoPath(fullName)}/commits?` +
      new URLSearchParams({ sha: o.branch, since: o.since, per_page: String(PER_PAGE) });
    while (url) {
      let page: { body: unknown; link: string | null };
      try {
        page = await this.json(url);
      } catch (err) {
        // An empty repository answers 409 on /commits.
        if (err instanceof EmptyRepo) return { commits: [], reachedStop: false, truncated: false };
        throw err;
      }
      for (const c of page.body as RawCommit[]) {
        if (o.stopAt && c.sha === o.stopAt)
          return { commits: out, reachedStop: true, truncated: false };
        if (out.length === o.max) return { commits: out, reachedStop: false, truncated: true };
        out.push(toCommit(c));
      }
      url = nextLink(page.link);
    }
    return { commits: out, reachedStop: false, truncated: false };
  }

  async releases(fullName: string, max: number): Promise<GhRelease[]> {
    const r = await this.json(
      `/repos/${repoPath(fullName)}/releases?per_page=${Math.min(max, PER_PAGE)}`,
    );
    return (r.body as RawRelease[]).slice(0, max).map((x) => ({
      id: String(x.id),
      tag: x.tag_name,
      name: x.name ?? x.tag_name,
      draft: x.draft,
      prerelease: x.prerelease,
      url: x.html_url,
      publishedAt: x.published_at,
    }));
  }

  async content(fullName: string, path: string): Promise<GhContent | null> {
    // The raw media type returns the bytes of any size; the blob SHA is computed
    // locally and equals GitHub's (D61, spike 2026-11-26).
    const url = `/repos/${repoPath(fullName)}/contents/${filePath(path)}`;
    const res = await this.request(url, 'application/vnd.github.raw');
    if (res.status === 404) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      sha: gitBlobSha(bytes),
      bytes,
      htmlUrl: `https://github.com/${fullName}/blob/HEAD/${filePath(path)}`,
    };
  }

  async pathCommits(fullName: string, path: string, n: number): Promise<GhCommit[]> {
    const r = await this.json(
      `/repos/${repoPath(fullName)}/commits?` +
        new URLSearchParams({ path, per_page: String(Math.min(n, PER_PAGE)) }),
    );
    return (r.body as RawCommit[]).slice(0, n).map(toCommit);
  }

  async whoami() {
    const user = (await this.json('/user')).body as { login: string };
    const repos = await this.json('/user/repos?per_page=1');
    const last = /[?&]page=(\d+)>; rel="last"/.exec(repos.link ?? '');
    const repoCount = last ? Number(last[1]) : (repos.body as unknown[]).length;
    return { login: user.login, repoCount };
  }

  // ------------------------------------------------------------ HTTP

  private async json(url: string): Promise<{ body: unknown; link: string | null }> {
    const cached = this.etags.get(url);
    const res = await this.request(url, 'application/vnd.github+json', cached?.etag);
    if (res.status === 304 && cached) {
      this.etags.delete(url);
      this.etags.set(url, cached);
      return { body: cached.body, link: cached.link };
    }
    if (res.status === 409) throw new EmptyRepo();
    if (res.status === 404) throw new GitHubError('not_found', `GitHub: ${url} not found`);
    const body = (await res.json()) as unknown;
    const link = res.headers.get('link');
    const etag = res.headers.get('etag');
    if (etag) {
      this.etags.delete(url);
      this.etags.set(url, { etag, body, link });
      // Map keeps insertion order: the first key is the least recently stored.
      while (this.etags.size > MAX_CACHED) {
        const oldest = this.etags.keys().next().value;
        if (oldest === undefined) break;
        this.etags.delete(oldest);
      }
    }
    return { body, link };
  }

  /** Any non-2xx except 304/404/409 becomes a GitHubError. */
  private async request(url: string, accept: string, etag?: string): Promise<Response> {
    const full = url.startsWith('http') ? url : `${this.base}${url}`;
    let res: Response;
    try {
      res = await this.fetch(full, {
        headers: {
          accept,
          ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}),
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': 'heph',
          ...(etag ? { 'if-none-match': etag } : {}),
        },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch {
      throw new GitHubError('unavailable', 'GitHub could not be reached');
    }
    if (res.ok || res.status === 304 || res.status === 404 || res.status === 409) return res;
    const now = this.o.now?.() ?? Date.now();
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = res.headers.get('retry-after');
    // Secondary rate limits can come as a 403 with quota left and only a message (GitHub docs).
    const secondary =
      res.status === 403 &&
      /rate limit/i.test(
        await res
          .clone()
          .text()
          .catch(() => ''),
      );
    if (
      res.status === 429 ||
      (res.status === 403 && (remaining === '0' || retryAfter !== null || secondary))
    ) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const after = Number(retryAfter);
      const resetAt =
        retryAfter !== null && Number.isFinite(after) && after >= 0
          ? now + after * 1000
          : Number.isFinite(reset) && reset > 0
            ? reset * 1000
            : now + (secondary ? 60_000 : 15 * 60_000);
      throw new GitHubError('rate_limited', 'GitHub rate limit reached', resetAt);
    }
    if (res.status === 401) throw new GitHubError('unauthorized', 'GitHub refused the token');
    // 403 without rate limit: the token has no access to this resource.
    if (res.status === 403) throw new GitHubError('not_found', `GitHub: no access to ${url}`);
    throw new GitHubError('unavailable', `GitHub answered ${res.status}`);
  }
}

class EmptyRepo extends Error {}

interface RawCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
    committer: { date?: string } | null;
  };
  author: { login?: string } | null;
}

interface RawRelease {
  id: number | string;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string | null;
}

function toCommit(c: RawCommit): GhCommit {
  return {
    sha: c.sha,
    message: (c.commit.message.split('\n')[0] ?? '').slice(0, 300),
    author: c.commit.author?.name ?? c.author?.login ?? null,
    // The committer date is when the commit landed on the branch (what `since` filters on).
    date: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(),
    url: c.html_url,
  };
}

/** `owner/name` with each part URL-encoded. */
function repoPath(fullName: string): string {
  return fullName
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
}

/** A repo file path with each segment URL-encoded, slashes kept. */
function filePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((p) => encodeURIComponent(p))
    .join('/');
}

function nextLink(link: string | null): string | null {
  return /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;
}
