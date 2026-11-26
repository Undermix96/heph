import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The new-project skill script (plugin/skills/new-project/scripts/bootstrap.sh,
 * §9, D64) in temporary folders, with a fake `gh` on PATH that creates a local
 * bare repo instead of a GitHub one. Invented data. On Windows it needs Git
 * Bash (HEPH_TEST_BASH overrides the path).
 */
const SCRIPT = path.resolve(
  import.meta.dirname,
  '../../../plugin/skills/new-project/scripts/bootstrap.sh',
);
const BASH = findBash();

function findBash(): string | null {
  if (process.env.HEPH_TEST_BASH) return process.env.HEPH_TEST_BASH;
  if (process.platform !== 'win32') return 'bash';
  for (const p of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-bootstrap-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake `gh`: auth status from FAKE_GH_AUTH, repo create makes a bare repo under FAKE_GH_REMOTES. */
function fakeGh(binDir: string): void {
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    [
      '#!/usr/bin/env bash',
      'echo "$*" >> "$FAKE_GH_REMOTES/calls.txt"',
      'case "$1 $2" in',
      '  "auth status") [ "${FAKE_GH_AUTH:-yes}" = yes ] && exit 0 || exit 1 ;;',
      '  "repo create") [ "${FAKE_GH_CREATE:-yes}" = yes ] || exit 1',
      '    git init -q --bare "$FAKE_GH_REMOTES/invented-owner/$3.git"; exit 0 ;;',
      '  "repo view") echo "invented-owner/$3"; exit 0 ;;',
      'esac',
      'exit 1',
    ].join('\n'),
    { mode: 0o755 },
  );
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  out: Record<string, string>;
}

function run(
  args: string[],
  o: { gh?: boolean; env?: Record<string, string> } = {},
): Promise<Run & { remotes: string }> {
  const remotes = tempDir();
  const bin = tempDir();
  if (o.gh !== false) fakeGh(bin);
  const sep = process.platform === 'win32' ? ';' : ':';
  return new Promise((resolve) => {
    execFile(
      BASH as string,
      [SCRIPT, ...args],
      {
        timeout: 60_000,
        env: {
          ...process.env,
          // A PATH where `gh` is the fake, or missing.
          PATH:
            o.gh === false
              ? withoutGh(process.env.PATH ?? '', sep)
              : `${bin}${sep}${process.env.PATH}`,
          FAKE_GH_REMOTES: remotes,
          HEPH_BOOTSTRAP_REMOTE_BASE: `${remotes.replaceAll('\\', '/')}/`,
          GIT_AUTHOR_NAME: 'Invented Owner',
          GIT_AUTHOR_EMAIL: 'owner@example.invalid',
          GIT_COMMITTER_NAME: 'Invented Owner',
          GIT_COMMITTER_EMAIL: 'owner@example.invalid',
          ...o.env,
        },
      },
      (err, stdout, stderr) => {
        const out = Object.fromEntries(
          String(stdout)
            .split('\n')
            .filter((l) => l.startsWith('HEPH_'))
            .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
        );
        resolve({
          code: err && typeof err.code === 'number' ? err.code : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          out,
          remotes,
        });
      },
    );
  });
}

/** PATH without any folder that has a `gh` (the real one on this machine, if installed). */
function withoutGh(p: string, sep: string): string {
  return p
    .split(sep)
    .filter((d) => !['gh', 'gh.exe'].some((f) => fs.existsSync(path.join(d, f))))
    .join(sep);
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe.skipIf(BASH === null)('new-project bootstrap script', { timeout: 90_000 }, () => {
  it('public node project: files, LICENSE, .nvmrc, commit, GitHub repo created and pushed', async () => {
    const dir = path.join(tempDir(), 'Stazione Meteo');
    const r = await run([
      '--dir',
      dir,
      '--name',
      'Stazione Meteo',
      '--visibility',
      'public',
      '--stack',
      'node',
      '--description',
      'Misura & invia a/b (dati inventati)',
      '--node-version',
      '26.13.1',
      '--holder',
      'Undermix96',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({
      HEPH_SLUG: 'stazione-meteo',
      HEPH_REPO: 'invented-owner/stazione-meteo',
      HEPH_GITHUB: 'created',
      HEPH_PUSHED: 'true',
    });
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(
      [
        '.editorconfig',
        '.git',
        '.gitattributes',
        '.gitignore',
        '.nvmrc',
        'CLAUDE.md',
        'DECISIONS.md',
        'LICENSE',
        'README.md',
      ].sort(),
    );
    expect(fs.readFileSync(path.join(dir, '.nvmrc'), 'utf8')).toBe('26.13.1\n');
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain(
      'Misura & invia a/b (dati inventati)',
    );
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(
      /Copyright \(c\) \d{4} Undermix96/,
    );
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('node_modules/');
    expect(fs.readFileSync(path.join(dir, 'DECISIONS.md'), 'utf8')).toMatch(
      /## D1 — Project bootstrap \(\d{4}-\d{2}-\d{2}\)/,
    );
    expect(git(dir, 'branch', '--show-current')).toBe('main');
    expect(git(dir, 'log', '--format=%s')).toBe('Initial commit');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // SSH-style remote (here the test base) and the push reached the bare repo.
    expect(git(dir, 'remote', 'get-url', 'origin')).toContain('invented-owner/stazione-meteo.git');
    const bare = path.join(r.remotes, 'invented-owner', 'stazione-meteo.git');
    expect(git(bare, 'log', '--format=%s', 'main')).toBe('Initial commit');
    expect(fs.readFileSync(path.join(r.remotes, 'calls.txt'), 'utf8')).toContain(
      'repo create stazione-meteo --public',
    );
  });

  it('private python project: no LICENSE, private repo, README says so', async () => {
    const dir = path.join(tempDir(), 'scanner');
    const r = await run([
      '--dir',
      dir,
      '--name',
      'Scanner',
      '--visibility',
      'private',
      '--stack',
      'python',
    ]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'LICENSE'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.python-version'))).toBe(false); // no version given
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain('Private repository');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('__pycache__/');
    expect(fs.readFileSync(path.join(r.remotes, 'calls.txt'), 'utf8')).toContain('--private');
  });

  it('platformio and generic stacks get their .gitignore', async () => {
    const pio = path.join(tempDir(), 'pio');
    await run([
      '--dir',
      pio,
      '--name',
      'Pio',
      '--visibility',
      'private',
      '--stack',
      'platformio',
      '--no-github',
    ]);
    expect(fs.readFileSync(path.join(pio, '.gitignore'), 'utf8')).toContain('.pio/');
    const gen = path.join(tempDir(), 'gen');
    await run([
      '--dir',
      gen,
      '--name',
      'Gen',
      '--visibility',
      'private',
      '--stack',
      'generic',
      '--no-github',
    ]);
    const gi = fs.readFileSync(path.join(gen, '.gitignore'), 'utf8');
    expect(gi).toContain('.env');
    expect(gi).not.toContain('node_modules');
  });

  it('gh missing, not signed in, or create failing: local repo only, with the reason', async () => {
    const a = await run(
      [
        '--dir',
        path.join(tempDir(), 'a'),
        '--name',
        'A',
        '--visibility',
        'private',
        '--stack',
        'generic',
      ],
      { gh: false },
    );
    expect(a).toMatchObject({ code: 0 });
    expect(a.out.HEPH_GITHUB).toBe('skipped: gh is not installed');
    const b = await run(
      [
        '--dir',
        path.join(tempDir(), 'b'),
        '--name',
        'B',
        '--visibility',
        'private',
        '--stack',
        'generic',
      ],
      { env: { FAKE_GH_AUTH: 'no' } },
    );
    expect(b.out.HEPH_GITHUB).toBe('skipped: gh is not signed in (run gh auth login)');
    const c = await run(
      [
        '--dir',
        path.join(tempDir(), 'c'),
        '--name',
        'C',
        '--visibility',
        'private',
        '--stack',
        'generic',
      ],
      { env: { FAKE_GH_CREATE: 'no' } },
    );
    expect(c.out.HEPH_GITHUB).toMatch(/^failed: gh repo create/);
    expect(c.out).toMatchObject({ HEPH_REPO: '', HEPH_PUSHED: 'false' });
  });

  it('design docs are copied into docs/design in their own commit', async () => {
    const design = tempDir();
    fs.mkdirSync(path.join(design, 'mockups'));
    fs.writeFileSync(path.join(design, 'DESIGN.md'), '# Design (invented)\n');
    fs.writeFileSync(path.join(design, 'mockups', '01.html'), '<p>x</p>\n');
    const dir = path.join(tempDir(), 'd');
    const r = await run([
      '--dir',
      dir,
      '--name',
      'D',
      '--visibility',
      'public',
      '--stack',
      'generic',
      '--design-dir',
      design,
    ]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'docs', 'design', 'mockups', '01.html'))).toBe(true);
    expect(git(dir, 'log', '--format=%s').split('\n')).toEqual([
      'Docs: add design documents',
      'Initial commit',
    ]);
  });

  it('refuses a non-empty folder and bad arguments, touching nothing', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'existing work\n');
    const r = await run(['--dir', dir, '--name', 'X', '--visibility', 'public', '--stack', 'node']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not empty');
    expect(fs.readdirSync(dir)).toEqual(['keep.txt']);
    const bad = await run([
      '--dir',
      path.join(tempDir(), 'n'),
      '--name',
      'X',
      '--visibility',
      'team',
      '--stack',
      'node',
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--visibility');
    const noName = await run([
      '--dir',
      path.join(tempDir(), 'n2'),
      '--visibility',
      'public',
      '--stack',
      'node',
    ]);
    expect(noName.code).toBe(2);
  });
});
