import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApps } from './test/app.js';

/**
 * The real plugin hook script (plugin/scripts/heph-hook.sh) against the agent
 * app on a real port, in temporary git repos with invented data (D58).
 * On Windows it needs Git Bash (not WSL's bash.exe); set HEPH_TEST_BASH to
 * override the path.
 */
const SCRIPT = path.resolve(import.meta.dirname, '../../../plugin/scripts/heph-hook.sh');
const BASH = findBash();
const REMOTE = 'git@github.com:example/spot-welder.git';

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

async function startServer() {
  const t = makeApps();
  const token = await t.setup();
  const server = serve({ fetch: t.agent.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    server.closeAllConnections?.();
    server.close();
    t.cleanup();
  });
  return { ...t, token, url };
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heph-plugin-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });

/** A git repo with one commit and the given origin remote. */
function repo(remote: string | null = REMOTE): string {
  const dir = tempDir();
  gitIn(dir, 'init', '-q');
  if (remote) gitIn(dir, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Spot welder (invented)\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

interface RunOpts {
  url?: string;
  token?: string;
  cwd: string;
}

/** Runs the hook script like Claude Code: JSON on stdin, plugin options in env. */
function run(event: string, input: Record<string, unknown>, o: RunOpts) {
  return new Promise<{ stdout: string; code: number; ms: number }>((resolve) => {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDE_PLUGIN_OPTION_HEPH_URL;
    delete env.CLAUDE_PLUGIN_OPTION_HEPH_TOKEN;
    if (o.url !== undefined) env.CLAUDE_PLUGIN_OPTION_HEPH_URL = o.url;
    if (o.token !== undefined) env.CLAUDE_PLUGIN_OPTION_HEPH_TOKEN = o.token;
    const child = execFile(
      BASH as string,
      [SCRIPT, event],
      { cwd: o.cwd, env, timeout: 30_000 },
      (err, stdout) => {
        resolve({
          stdout: stdout.toString(),
          code: err && typeof err.code === 'number' ? err.code : 0,
          ms: Date.now() - started,
        });
      },
    );
    child.stdin?.end(JSON.stringify({ hook_event_name: event, cwd: o.cwd, ...input }));
  });
}

// Each run starts bash, git and curl: seconds per test on Windows.
describe.skipIf(BASH === null)(
  'plugin hook script (bash + git + curl)',
  { timeout: 60_000 },
  () => {
    it('session-start in a linked repo prints the briefing and the project goes live', async () => {
      const s = await startServer();
      const p = await s.uiReq('POST', '/api/projects', {
        json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
      });
      const cwd = repo();
      const r = await run(
        'session-start',
        { session_id: 'sess-a', source: 'startup' },
        {
          url: `${s.url}/`, // a trailing slash is tolerated
          token: s.token,
          cwd,
        },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('# Briefing: Spot Welder');
      expect(r.stdout).toContain('Pass session_id "sess-a"');
      expect(s.d.projects.get(p.data.id).activityState).toBe('claude_working');
      const row = s.d.sessions.row('sess-a');
      expect(row?.lastHeadSha).toMatch(/^[0-9a-f]{40}$/);
      expect(row?.lastWorktreeHash).toMatch(/^[0-9a-f]{40}$/);
    });

    it('unlinked repo and folder without git get the rules and a hint', async () => {
      const s = await startServer();
      const unlinked = await run(
        'session-start',
        { session_id: 's1' },
        {
          url: s.url,
          token: s.token,
          cwd: repo('https://github.com/example/other.git'),
        },
      );
      expect(unlinked.stdout).toContain('`example/other` is not linked');
      // D66: the legacy escape reaches Claude through the real script.
      expect(unlinked.stdout).toContain('`Work state: legacy`');
      expect(unlinked.stdout).toContain('heph:migrate-project');
      const plain = await run(
        'session-start',
        { session_id: 's2' },
        {
          url: s.url,
          token: s.token,
          cwd: tempDir(),
        },
      );
      expect(plain.stdout).toContain('no git remote');
      expect(plain.stdout).toContain('## Rules');
    });

    it('not configured, wrong token or Heph down: one-line notice at start, silence elsewhere', async () => {
      const s = await startServer();
      const cwd = repo();
      const none = await run('session-start', { session_id: 's1' }, { cwd });
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('/plugin configure heph@heph');
      expect(none.stdout.trim().split('\n')).toHaveLength(1);
      const wrong = await run(
        'session-start',
        { session_id: 's1' },
        { url: s.url, token: 'nope', cwd },
      );
      expect(wrong.stdout).toContain('refused the API token');
      const down = await run(
        'session-start',
        { session_id: 's1' },
        {
          url: 'http://127.0.0.1:9',
          token: s.token,
          cwd,
        },
      );
      expect(down.code).toBe(0);
      expect(down.stdout).toContain('not reachable at http://127.0.0.1:9');
      for (const ev of ['stop', 'pre-tool-use', 'post-tool-use', 'session-end']) {
        const r = await run(
          ev,
          { session_id: 's1' },
          { url: 'http://127.0.0.1:9', token: s.token, cwd },
        );
        expect(r).toMatchObject({ code: 0, stdout: '' });
        const n = await run(ev, { session_id: 's1' }, { cwd });
        expect(n).toMatchObject({ code: 0, stdout: '' });
      }
    });

    it('stop prints the block decision after a commit, nothing when the hook is already active', async () => {
      const s = await startServer();
      await s.uiReq('POST', '/api/projects', {
        json: { name: 'Spot Welder', repos: ['example/spot-welder'], docsSource: 'internal' },
      });
      const cwd = repo();
      const o = { url: s.url, token: s.token, cwd };
      await run('session-start', { session_id: 's1' }, o);
      expect((await run('stop', { session_id: 's1', stop_hook_active: false }, o)).stdout).toBe('');
      fs.writeFileSync(path.join(cwd, 'case.scad'), 'cube(10);\n');
      gitIn(cwd, 'add', '.');
      gitIn(cwd, 'commit', '-q', '-m', 'Case');
      const block = await run('stop', { session_id: 's1', stop_hook_active: false }, o);
      const out = JSON.parse(block.stdout);
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('log_progress');
      const again = await run('stop', { session_id: 's1', stop_hook_active: true }, o);
      expect(again.stdout).toBe('');
    });

    it('stop uploads DECISIONS.md only when it changed, bytes as on disk (CRLF, accents)', async () => {
      const s = await startServer();
      const p = await s.uiReq('POST', '/api/projects', {
        json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
      });
      const cwd = repo();
      const o = { url: s.url, token: s.token, cwd };
      await run('session-start', { session_id: 's1' }, o);
      const docs = () => s.d.projects.get(p.data.id).repoDetails[0];
      await run('stop', { session_id: 's1' }, o);
      expect(docs()?.docsUpdatedAt).toBeNull(); // no file yet
      const content = '# Decisions\r\n\r\n## D1 — Saldatura a punti (dati inventati)\r\n';
      fs.writeFileSync(path.join(cwd, 'DECISIONS.md'), content); // uncommitted edit
      await run('stop', { session_id: 's1' }, o);
      expect(docs()?.docsOrigin).toBe('hook');
      const first = docs()?.docsUpdatedAt;
      const view = await s.uiReq('GET', `/api/projects/${p.data.id}/docs`);
      expect(JSON.stringify(view.data)).toContain('Saldatura a punti');
      s.clock.advance(60_000);
      await run('stop', { session_id: 's1' }, o);
      expect(docs()?.docsUpdatedAt).toBe(first); // unchanged file: no upload
      fs.appendFileSync(path.join(cwd, 'DECISIONS.md'), '\r\n## D2 — Rame\r\n');
      await run('stop', { session_id: 's1' }, o);
      expect(docs()?.docsUpdatedAt).not.toBe(first);
    });

    it('a docs path with spaces in a subfolder is found and uploaded', async () => {
      const s = await startServer();
      const p = await s.uiReq('POST', '/api/projects', {
        json: {
          name: 'Spot Welder',
          repos: [{ fullName: 'example/spot-welder', docsPath: 'docs/my decisions.md' }],
        },
      });
      const cwd = repo();
      fs.mkdirSync(path.join(cwd, 'docs'));
      fs.writeFileSync(path.join(cwd, 'docs', 'my decisions.md'), '# Decisions\n');
      const sub = path.join(cwd, 'docs');
      const o = { url: s.url, token: s.token, cwd: sub }; // Claude started in a subfolder
      await run('session-start', { session_id: 's1' }, o);
      await run('stop', { session_id: 's1' }, o);
      expect(s.d.projects.get(p.data.id).repoDetails[0]?.docsOrigin).toBe('hook');
    });

    it('pre/post-tool-use mark testing for PowerShell and Bash; session-end closes', async () => {
      const s = await startServer();
      const p = await s.uiReq('POST', '/api/projects', {
        json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
      });
      const cwd = repo();
      const o = { url: s.url, token: s.token, cwd };
      const state = () => s.d.projects.get(p.data.id).activityState;
      await run('session-start', { session_id: 's1' }, o);
      const tool = {
        session_id: 's1',
        tool_name: 'PowerShell',
        tool_use_id: 'tu1',
        tool_input: { command: 'npm test' },
      };
      expect((await run('pre-tool-use', tool, o)).stdout).toBe('');
      expect(state()).toBe('claude_testing');
      await run('post-tool-use', { ...tool, tool_response: { stdout: 'x'.repeat(200_000) } }, o);
      expect(state()).toBe('claude_working');
      await run('session-end', { session_id: 's1', reason: 'prompt_input_exit' }, o);
      expect(s.d.projects.get(p.data.id).liveSessions).toHaveLength(0);
    });
  },
);
