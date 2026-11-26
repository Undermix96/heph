import { describe, expect, it } from 'vitest';
import { HttpGitHub } from './http.js';

/**
 * Opt-in smoke test against the real GitHub API (D61): `npm run smoke:github`.
 * Reads the public sample repo octocat/Hello-World without a token (60
 * requests per hour per address), so it is skipped in normal test runs and CI.
 */
const LIVE = process.env.HEPH_GITHUB_SMOKE === '1';
const REPO = 'octocat/Hello-World';

describe.skipIf(!LIVE)('real GitHub API (public repo, no token)', { timeout: 60_000 }, () => {
  const gh = new HttpGitHub({ token: null, baseUrl: 'https://api.github.com' });

  it('reads repo, commits, releases, a file and its commits as the adapter expects', async () => {
    const repo = await gh.repo(REPO);
    expect(repo.defaultBranch).toBe('master');
    const page = await gh.commits(REPO, {
      branch: repo.defaultBranch,
      since: '2000-01-01T00:00:00Z',
      stopAt: null,
      max: 5,
    });
    expect(page.commits.length).toBeGreaterThan(0);
    expect(page.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(page.commits[0]?.date ?? '')).toBeGreaterThan(0);
    expect(Array.isArray(await gh.releases(REPO, 5))).toBe(true);
    const readme = await gh.content(REPO, 'README');
    // GitHub's blob SHA of README, as returned by the contents API on 2026-11-26.
    expect(readme?.sha).toBe('980a0d5f19a64b4b30a87d4206aade58726b60e3');
    expect(await gh.content(REPO, 'DECISIONS.md')).toBeNull();
    expect((await gh.pathCommits(REPO, 'README', 2)).length).toBeGreaterThan(0);
  });
});
