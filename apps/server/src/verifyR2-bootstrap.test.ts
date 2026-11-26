import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Independent verification, round 2 of phase 7 (new-project bootstrap, D64, D54).
 * Invented data; git identity isolated through GIT_CONFIG_GLOBAL.
 */
const SCRIPT = path.resolve(
  import.meta.dirname,
  '../../../plugin/skills/new-project/scripts/bootstrap.sh',
);
const BASH = (() => {
  if (process.env.HEPH_TEST_BASH) return process.env.HEPH_TEST_BASH;
  if (process.platform !== 'win32') return 'bash';
  for (const p of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
})();

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-verifyR2-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function env(extra: Record<string, string>): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(e)) {
    if (/^GIT_(AUTHOR|COMMITTER)_/.test(k) || k === 'EMAIL' || k.startsWith('GIT_CONFIG'))
      delete e[k];
  }
  return { ...e, ...extra };
}

function run(args: string[], cwd: string, extra: Record<string, string>) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(
      BASH as string,
      [SCRIPT, ...args],
      { cwd, env: env(extra), timeout: 60_000 },
      (err, _out, stderr) =>
        resolve({
          code: err && typeof err.code === 'number' ? err.code : 0,
          stderr: String(stderr),
        }),
    );
  });
}

describe.skipIf(BASH === null)('verifyR2: bootstrap identity check', { timeout: 120_000 }, () => {
  it('run from inside another repo that has a local identity, no global one: rerunnable', async () => {
    const global = path.join(tempDir(), 'gitconfig');
    fs.writeFileSync(global, '');
    const cfg = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
    // The caller's cwd is an existing repo with a repo-local user (e.g. a work repo).
    const other = tempDir();
    const g = (...a: string[]) =>
      execFileSync('git', a, { cwd: other, env: env(cfg) as NodeJS.ProcessEnv });
    g('init', '-q');
    g('config', 'user.name', 'Invented Work');
    g('config', 'user.email', 'work@example.invalid');
    const dir = path.join(tempDir(), 'new-project');
    const args = [
      '--dir',
      dir,
      '--name',
      'Invented',
      '--visibility',
      'private',
      '--stack',
      'generic',
      '--no-github',
    ];
    const r = await run(args, other, cfg);
    if (r.code !== 0) {
      // Failing is fine, but then the folder must be untouched so a rerun is possible.
      const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      expect({ code: r.code, left }).toEqual({ code: r.code, left: [] });
    }
  });
});
