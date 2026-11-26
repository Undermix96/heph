import { GitHubError } from '@heph/core';
import { describe, expect, it } from 'vitest';
import { HttpGitHub } from './github/http.js';

// Independent verification, round 2 of the phase 6 adapter fixes (D61, D54). Invented data.

/**
 * A fake GitHub: every URL has a body and an ETag; a matching If-None-Match gets a 304.
 * `version` changes the body (and the ETag) of one URL.
 */
function etagFetch() {
  const version = new Map<string, number>();
  const calls: { url: string; inm: string | undefined; status: number }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const h = (init?.headers ?? {}) as Record<string, string>;
    const v = version.get(u) ?? 1;
    const etag = `"${u}#${v}"`;
    if (h['if-none-match'] === etag) {
      calls.push({ url: u, inm: h['if-none-match'], status: 304 });
      return new Response(null, { status: 304, headers: { etag } });
    }
    calls.push({ url: u, inm: h['if-none-match'], status: 200 });
    return new Response(JSON.stringify({ default_branch: `b-${u}-${v}`, html_url: u }), {
      status: 200,
      headers: { etag, 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { f, calls, version };
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `example/repo-${i}`);

describe('verifyR2: bounded ETag cache', () => {
  it('data stays correct after eviction and after a change of an evicted URL', async () => {
    const { f, calls, version } = etagFetch();
    const gh = new HttpGitHub({ token: 't', baseUrl: 'http://x', fetch: f });
    for (const n of names(250)) await gh.repo(n);
    // repo-0 was evicted: no conditional request, fresh 200 with the new body.
    version.set('http://x/repos/example/repo-0', 2);
    calls.length = 0;
    const r0 = await gh.repo('example/repo-0');
    expect(r0.defaultBranch).toBe('b-http://x/repos/example/repo-0-2');
    expect(calls[0]).toMatchObject({ inm: undefined, status: 200 });
    // repo-249 is cached: 304 returns the cached body.
    const r249 = await gh.repo('example/repo-249');
    expect(r249.defaultBranch).toBe('b-http://x/repos/example/repo-249-1');
    expect(calls[1]?.status).toBe(304);
    // A cached URL whose body changed: the new body, not the cached one.
    version.set('http://x/repos/example/repo-249', 2);
    expect((await gh.repo('example/repo-249')).defaultBranch).toBe(
      'b-http://x/repos/example/repo-249-2',
    );
  });

  it('a URL answered with 304 on every poll is not evicted ahead of URLs stored once (LRU)', async () => {
    const { f, calls } = etagFetch();
    const gh = new HttpGitHub({ token: 't', baseUrl: 'http://x', fetch: f });
    await gh.repo('example/hot');
    // 200 other URLs, while the hot one is polled (304) between them.
    for (const n of names(200)) {
      await gh.repo(n);
      await gh.repo('example/hot');
    }
    const hot = calls.filter((c) => c.url.endsWith('/example/hot'));
    // Only the very first request is a full 200; every poll after it is a 304.
    expect(hot.filter((c) => c.status === 200)).toHaveLength(1);
  });

  it('Retry-After as an HTTP date (allowed by RFC 9110) uses that date', async () => {
    const now = Date.UTC(2026, 10, 26, 12);
    const date = new Date(now + 120_000).toUTCString();
    const f = (async () =>
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': date },
      })) as unknown as typeof fetch;
    const gh = new HttpGitHub({ token: 't', baseUrl: 'http://x', fetch: f, now: () => now });
    const err = await gh.repo('example/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).code).toBe('rate_limited');
    // At least not earlier than the server asked.
    expect((err as GitHubError).resetAt ?? 0).toBeGreaterThanOrEqual(now + 120_000);
  });
});
