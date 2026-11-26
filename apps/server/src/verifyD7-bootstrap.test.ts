import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Independent verification, phase 7 (new-project skill, §9, D64, D54).
 * Runs plugin/skills/new-project/scripts/bootstrap.sh like
 * bootstrap.skill.test.ts does, with a fake `gh`. Invented data.
 */
/** Same as slugify() in packages/core/src/util.ts (not exported by @heph/core). */
function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (/^\d+$/.test(s)) return `p-${s}`;
  return s || 'project';
}

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-verifyD7-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
  remotes: string;
}

/** Env without the GIT_* identity overrides, for tests that set identity via a config file. */
function baseEnv(): Record<string, string | undefined> {
  const e = { ...process.env };
  for (const k of Object.keys(e)) {
    if (/^GIT_(AUTHOR|COMMITTER)_/.test(k) || k === 'EMAIL') delete e[k];
  }
  return e;
}

function run(
  args: string[],
  o: {
    gh?: boolean;
    env?: Record<string, string>;
    cwd?: string;
    identity?: boolean;
    remoteBase?: string;
  } = {},
): Promise<Run> {
  const remotes = tempDir();
  const bin = tempDir();
  if (o.gh !== false) fakeGh(bin);
  const sep = process.platform === 'win32' ? ';' : ':';
  const identity =
    o.identity === false
      ? {}
      : {
          GIT_AUTHOR_NAME: 'Invented Owner',
          GIT_AUTHOR_EMAIL: 'owner@example.invalid',
          GIT_COMMITTER_NAME: 'Invented Owner',
          GIT_COMMITTER_EMAIL: 'owner@example.invalid',
        };
  return new Promise((resolve) => {
    execFile(
      BASH as string,
      [SCRIPT, ...args],
      {
        timeout: 60_000,
        cwd: o.cwd,
        env: {
          ...baseEnv(),
          PATH: `${bin}${sep}${process.env.PATH}`,
          FAKE_GH_REMOTES: remotes,
          HEPH_BOOTSTRAP_REMOTE_BASE: o.remoteBase ?? `${remotes.replaceAll('\\', '/')}/`,
          ...identity,
          ...o.env,
        },
      },
      (err, stdout, stderr) => {
        const out = Object.fromEntries(
          String(stdout)
            .split('\n')
            .map((l) => l.replace(/\r$/, ''))
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

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** A git global config file (isolates the test from the machine's ~/.gitconfig). */
function gitConfig(text: string): Record<string, string> {
  const f = path.join(tempDir(), 'gitconfig');
  fs.writeFileSync(f, text);
  return { GIT_CONFIG_GLOBAL: f, GIT_CONFIG_NOSYSTEM: '1' };
}

const base = (dir: string, name = 'Invented') => [
  '--dir',
  dir,
  '--name',
  name,
  '--visibility',
  'private',
  '--stack',
  'generic',
];

describe.skipIf(BASH === null)('verifyD7: new-project bootstrap', { timeout: 120_000 }, () => {
  // --- Slugs: the script's slug is written into CLAUDE.md as the Heph project
  // slug and used as the GitHub repo name; Heph derives its own with slugify().
  it('slug of accented / numeric names matches the slug Heph will give the project', async () => {
    for (const name of ['Caffè Lùmière', 'Città del Sole', 'Orto 2026 à la carte']) {
      const dir = path.join(tempDir(), 'p');
      const r = await run([...base(dir, name), '--no-github']);
      expect(r.code).toBe(0);
      expect({ name, slug: r.out.HEPH_SLUG }).toEqual({ name, slug: slugify(name) });
    }
  });

  it('slug never ends with a dash when the name is cut at 60 characters', async () => {
    const name = `${'a'.repeat(59)} bcd`;
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir, name), '--no-github']);
    expect(r.code).toBe(0);
    expect(r.out.HEPH_SLUG).not.toMatch(/-$/);
    expect((r.out.HEPH_SLUG ?? '').length).toBeLessThanOrEqual(60);
  });

  it('a name with no ASCII letters falls back to a usable slug', async () => {
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir, '日本語'), '--no-github']);
    expect(r.code).toBe(0);
    expect(r.out.HEPH_SLUG).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  // --- Paths
  it('relative --design-dir is resolved against the caller cwd', async () => {
    const parent = tempDir();
    fs.mkdirSync(path.join(parent, 'designs'));
    fs.writeFileSync(path.join(parent, 'designs', 'DESIGN.md'), '# Invented design\n');
    const r = await run([...base('New Project'), '--design-dir', 'designs', '--no-github'], {
      cwd: parent,
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(parent, 'New Project', 'docs', 'design', 'DESIGN.md'))).toBe(
      true,
    );
  });

  it('relative --dir works and HEPH_DIR is absolute', async () => {
    const parent = tempDir();
    const r = await run([...base('My Project'), '--no-github'], { cwd: parent });
    expect(r.code).toBe(0);
    expect(path.isAbsolute(r.out.HEPH_DIR ?? '')).toBe(true);
    expect(fs.existsSync(path.join(parent, 'My Project', 'README.md'))).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows path with backslashes and spaces (D:\\Git\\My Project style)',
    async () => {
      const dir = path.join(tempDir(), 'My Project'); // backslashes on Windows
      const r = await run([...base(dir, 'My Project'), '--no-github']);
      expect(r.code).toBe(0);
      expect(path.resolve(r.out.HEPH_DIR ?? '')).toBe(path.resolve(dir));
      expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    },
  );

  it('an existing empty folder is used', async () => {
    const dir = tempDir();
    const r = await run([...base(dir), '--no-github']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  });

  it('a folder with only hidden files (e.g. .git) is refused and untouched', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'invented\n');
    const r = await run([...base(dir), '--no-github']);
    expect(r.code).toBe(2);
    expect(fs.readdirSync(dir)).toEqual(['.git']);
    expect(fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8')).toBe('invented\n');
  });

  it('a --dir that is a file is refused and the file is untouched', async () => {
    const f = path.join(tempDir(), 'notes.txt');
    fs.writeFileSync(f, 'keep\n');
    const r = await run([...base(f), '--no-github']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not a folder');
    expect(fs.readFileSync(f, 'utf8')).toBe('keep\n');
  });

  // --- git configuration of a realistic machine
  it('git without user.name/email: fails before touching the folder, so it can be rerun', async () => {
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir), '--no-github'], {
      identity: false,
      env: gitConfig('[user]\n\tuseConfigOnly = true\n'),
    });
    expect(r.code).not.toBe(0);
    // Rerunning after setting the identity must be possible (SKILL: never empty a folder).
    const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(leftovers).toEqual([]);
  });

  it('init.defaultBranch=master and core.autocrlf=true: main branch, LF files, clean tree', async () => {
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir), '--stack', 'node', '--no-github'], {
      identity: false,
      env: gitConfig(
        '[user]\n\tname = Undermix96\n\temail = owner@example.invalid\n[init]\n\tdefaultBranch = master\n[core]\n\tautocrlf = true\n',
      ),
    });
    expect(r.code).toBe(0);
    expect(git(dir, 'branch', '--show-current')).toBe('main');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    for (const f of ['README.md', 'CLAUDE.md', 'DECISIONS.md', '.gitignore', '.editorconfig']) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text, f).not.toContain('\r');
      expect(text.endsWith('\n'), f).toBe(true);
    }
    expect(git(dir, 'ls-files', '--eol', 'README.md')).toMatch(/^i\/lf\s+w\/lf/);
  });

  it('LICENSE holder defaults to git user.name, never another value', async () => {
    const dir = path.join(tempDir(), 'p');
    const r = await run(
      ['--dir', dir, '--name', 'P', '--visibility', 'public', '--stack', 'generic', '--no-github'],
      {
        identity: false,
        env: gitConfig('[user]\n\tname = Undermix96\n\temail = owner@example.invalid\n'),
      },
    );
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toMatch(
      /^Copyright \(c\) \d{4} Undermix96$/m,
    );
  });

  // --- Content
  it('description with newlines, Markdown, backslashes, & and $ is inserted verbatim', async () => {
    const description =
      'First line & more\n\n- item *bold*\n- C:\\Users\\x \\n $HOME `code` "q" it\'s';
    const name = 'L\'orto "di" Nonna & Co. \\ $PATH';
    const dir = path.join(tempDir(), 'p');
    const r = await run([
      '--dir',
      dir,
      '--name',
      name,
      '--visibility',
      'public',
      '--stack',
      'generic',
      '--description',
      description,
      '--holder',
      'Undermix96 & co',
      '--no-github',
    ]);
    expect(r.code).toBe(0);
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    expect(readme.startsWith(`# ${name}\n`)).toBe(true);
    expect(readme).toContain(description);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(description);
    expect(fs.readFileSync(path.join(dir, 'DECISIONS.md'), 'utf8')).toContain(`Start ${name} as`);
    expect(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')).toContain('Undermix96 & co');
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).not.toContain('{{');
  });

  it('DECISIONS.md D1 follows the owner format with an ISO date', async () => {
    const dir = path.join(tempDir(), 'p');
    await run([...base(dir), '--no-github']);
    const d = fs.readFileSync(path.join(dir, 'DECISIONS.md'), 'utf8');
    expect(d).toMatch(/^## D1 — .+ \(\d{4}-\d{2}-\d{2}\)$/m);
    expect(d).toMatch(/^Decision: /m);
    expect(d).toMatch(/^Why: /m);
    expect(d).toMatch(/^Alternatives rejected:/m);
  });

  it('.gitignore keeps secrets and private/ out but lets .env.example in', async () => {
    for (const stack of ['node', 'python', 'platformio', 'generic']) {
      const dir = path.join(tempDir(), stack);
      const r = await run([...base(dir), '--stack', stack, '--no-github']);
      expect(r.code).toBe(0);
      const ignored = (p: string) => {
        try {
          execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: dir });
          return true;
        } catch {
          return false;
        }
      };
      expect(ignored('.env'), stack).toBe(true);
      expect(ignored('.env.local'), stack).toBe(true);
      expect(ignored('.env.example'), stack).toBe(false);
      expect(ignored('private/data.csv'), stack).toBe(true);
    }
  });

  it('platformio: .vscode/extensions.json is not ignored (the template re-includes it)', async () => {
    const dir = path.join(tempDir(), 'pio');
    const r = await run([...base(dir), '--stack', 'platformio', '--no-github']);
    expect(r.code).toBe(0);
    fs.mkdirSync(path.join(dir, '.vscode'));
    fs.writeFileSync(path.join(dir, '.vscode', 'extensions.json'), '{}\n');
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), '{}\n');
    const status = git(dir, 'status', '--porcelain', '--untracked-files=all');
    expect(status).toContain('.vscode/extensions.json');
    expect(status).not.toContain('settings.json');
  });

  it('design docs: empty design folder gives no extra commit and exit 0', async () => {
    const design = tempDir();
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir), '--design-dir', design, '--no-github']);
    expect(r.code).toBe(0);
    expect(git(dir, 'log', '--format=%s')).toBe('Initial commit');
  });

  it('design docs: a design folder that is itself a git repo is committed as files', async () => {
    const design = tempDir();
    execFileSync('git', ['init', '-q'], { cwd: design });
    fs.writeFileSync(path.join(design, 'DESIGN.md'), '# Invented\n');
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir), '--design-dir', design, '--no-github']);
    expect(r.code).toBe(0);
    expect(git(dir, 'ls-files', 'docs/design')).toContain('docs/design/DESIGN.md');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('design docs are in the pushed history too', async () => {
    const design = tempDir();
    fs.writeFileSync(path.join(design, 'DESIGN.md'), '# Invented\n');
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir, 'Pushed'), '--design-dir', design]);
    expect(r.out).toMatchObject({ HEPH_GITHUB: 'created', HEPH_PUSHED: 'true' });
    const bare = path.join(r.remotes, 'invented-owner', 'pushed.git');
    expect(git(bare, 'log', '--format=%s', 'main').split('\n')).toEqual([
      'Docs: add design documents',
      'Initial commit',
    ]);
  });

  // --- GitHub
  it('default remote is SSH git@github.com:owner/name.git (never HTTPS), push failure reported', async () => {
    const dir = path.join(tempDir(), 'p');
    const r = await run(base(dir, 'Ssh Check'), {
      remoteBase: '',
      env: { HEPH_BOOTSTRAP_REMOTE_BASE: '', GIT_SSH_COMMAND: 'false' },
    });
    expect(r.code).toBe(0);
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(
      'git@github.com:invented-owner/ssh-check.git',
    );
    expect(r.out.HEPH_PUSHED).toBe('false');
    expect(r.out.HEPH_GITHUB).toMatch(/^created, push failed/);
    expect(r.out.HEPH_REPO).toBe('invented-owner/ssh-check');
  });

  it('--repo-name is used for gh repo create and the remote', async () => {
    const dir = path.join(tempDir(), 'p');
    const r = await run([...base(dir, 'Name Taken'), '--repo-name', 'name-taken-2']);
    expect(r.out).toMatchObject({ HEPH_REPO: 'invented-owner/name-taken-2', HEPH_PUSHED: 'true' });
    expect(git(dir, 'remote', 'get-url', 'origin')).toMatch(/invented-owner\/name-taken-2\.git$/);
  });

  it('gh create failing (name taken) leaves no origin remote and a clean local repo', async () => {
    const dir = path.join(tempDir(), 'p');
    const r = await run(base(dir), { env: { FAKE_GH_CREATE: 'no' } });
    expect(r.code).toBe(0);
    expect(git(dir, 'remote')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('a missing option value is a clear argument error (exit 2)', async () => {
    const r = await run(['--name', 'X', '--visibility', 'private', '--stack', 'generic', '--dir']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--dir/);
  });
});
