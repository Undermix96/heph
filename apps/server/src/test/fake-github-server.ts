import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local fake of the GitHub REST endpoints Heph uses (D61), shaped like the
 * real responses seen in the 2026-11-26 spike: repo, commits (since, sha,
 * path, pagination with Link), releases, contents (raw media type), user and
 * user repos, ETags with 304. Invented data only. Used by adapter tests and,
 * through `main()`, by the e2e server (HEPH_GITHUB_API_URL).
 */
export interface FakeCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  /** Files this commit touched (for `?path=`). */
  files?: string[];
}

export interface FakeRepoModel {
  defaultBranch: string;
  /** Per branch, newest first. */
  commits: Record<string, FakeCommit[]>;
  releases: {
    id: number;
    tag_name: string;
    name: string | null;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }[];
  files: Record<string, string | Buffer>;
  empty?: boolean;
}

export interface FakeGitHubState {
  repos: Map<string, FakeRepoModel>;
  /** Forces every response to this status (401, 403 rate limit, 500...). */
  forceStatus: number | null;
  /** Remaining quota reported on every response. */
  rateRemaining: number;
  token: string;
  requests: { path: string; auth: boolean; conditional: boolean; status: number }[];
  perPageCap: number;
}

export async function startFakeGitHub(port = 0, host = '127.0.0.1') {
  const state: FakeGitHubState = {
    repos: new Map(),
    forceStatus: null,
    rateRemaining: 4999,
    token: 'invented-gh-token',
    requests: [],
    perPageCap: 100,
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const auth = req.headers.authorization === `Bearer ${state.token}`;
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const etag = `W/"${crypto.createHash('sha256').update(raw).digest('hex')}"`;
      const conditional = req.headers['if-none-match'] === etag;
      const final = status === 200 && conditional ? 304 : status;
      state.requests.push({ path: url.pathname + url.search, auth, conditional, status: final });
      res.writeHead(final, {
        'content-type': Buffer.isBuffer(body) ? 'application/vnd.github.raw' : 'application/json',
        'x-ratelimit-remaining': String(state.rateRemaining),
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        ...(status === 200 ? { etag } : {}),
        ...headers,
      });
      res.end(final === 304 ? undefined : raw);
    };
    if (state.forceStatus) {
      const s = state.forceStatus;
      return send(s, { message: 'forced' }, s === 403 ? { 'x-ratelimit-remaining': '0' } : {});
    }
    if (!auth) return send(401, { message: 'Bad credentials' });

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.pathname === '/user') return send(200, { login: 'invented-user' });
    if (url.pathname === '/user/repos') {
      const n = state.repos.size;
      return send(
        200,
        n ? [{}] : [],
        n > 1 ? { link: `<${url.origin}/user/repos?per_page=1&page=${n}>; rel="last"` } : {},
      );
    }
    if (parts[0] !== 'repos' || parts.length < 3) return send(404, { message: 'Not Found' });
    const fullName = `${parts[1]}/${parts[2]}`.toLowerCase();
    const repo = state.repos.get(fullName);
    if (!repo) return send(404, { message: 'Not Found' });
    const html = `https://github.com/${fullName}`;
    const rest = parts.slice(3);

    if (rest.length === 0) return send(200, { default_branch: repo.defaultBranch, html_url: html });
    if (rest[0] === 'commits') {
      if (repo.empty) return send(409, { message: 'Git Repository is empty.' });
      const path = url.searchParams.get('path');
      const since = url.searchParams.get('since');
      const branch = url.searchParams.get('sha') ?? repo.defaultBranch;
      let list = repo.commits[branch] ?? [];
      if (path) list = list.filter((c) => c.files?.includes(path));
      if (since) list = list.filter((c) => c.date >= since);
      const per = Math.min(Number(url.searchParams.get('per_page') ?? 30), state.perPageCap);
      const page = Number(url.searchParams.get('page') ?? 1);
      const slice = list.slice((page - 1) * per, page * per);
      const next = new URL(url.pathname + url.search, `http://${req.headers.host}`);
      next.searchParams.set('page', String(page + 1));
      const link: Record<string, string> =
        page * per < list.length ? { link: `<${next}>; rel="next"` } : {};
      return send(
        200,
        slice.map((c) => ({
          sha: c.sha,
          html_url: `${html}/commit/${c.sha}`,
          commit: {
            message: c.message,
            author: { name: c.author, date: c.date },
            committer: { date: c.date },
          },
          author: { login: c.author.toLowerCase().replace(/\s+/g, '-') },
        })),
        link,
      );
    }
    if (rest[0] === 'releases') {
      return send(
        200,
        repo.releases.map((r) => ({ ...r, html_url: `${html}/releases/tag/${r.tag_name}` })),
      );
    }
    if (rest[0] === 'contents') {
      const file = repo.files[rest.slice(1).join('/')];
      if (file === undefined) return send(404, { message: 'Not Found' });
      return send(200, Buffer.isBuffer(file) ? file : Buffer.from(file));
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(port, host, () => r()));
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    state,
    url,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
