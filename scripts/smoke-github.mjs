// Opt-in smoke test of the GitHub adapter against the real API (D61): reads the
// public sample repo octocat/Hello-World without a token. Not part of CI.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', 'apps/server/src/github/live.smoke.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, HEPH_GITHUB_SMOKE: '1' },
});
process.exit(r.status ?? 1);
