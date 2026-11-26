/**
 * Independent verification of phase 5 group B: the plugin hook script
 * (plugin/scripts/heph-hook.sh), hooks.json and the plugin manifests (D57,
 * D58). Realistic use only (D54): Heph down or slow, misconfigured URL,
 * Windows/Git Bash quirks, unusual but normal repos, two sessions at once.
 * All data is invented.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApps } from './test/app.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SCRIPT = path.join(ROOT, 'plugin/scripts/heph-hook.sh');
const HOOKS_JSON = path.join(ROOT, 'plugin/hooks/hooks.json');
const REMOTE = 'git@github.com:example/spot-welder.git';
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

/** Hook timeouts from hooks.json, in ms, by script event. */
const TIMEOUT_MS: Record<string, number> = (() => {
  const j = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const out: Record<string, number> = {};
  for (const groups of Object.values(j.hooks) as {
    hooks: { command: string; timeout: number }[];
  }[][]) {
    for (const g of groups)
      for (const h of g.hooks) out[h.command.split(' ').at(-1) as string] = h.timeout * 1000;
  }
  return out;
})();

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

interface Seen {
  method: string;
  url: string;
  bytes: number;
}

/** A hand-written HTTP server: `handler` decides; requests are recorded. */
async function fakeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? '', url: req.url ?? '', bytes: body.length });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Accepts TCP connections and never answers: Heph hung or very slow. */
async function blackHole() {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
    s.resume();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function tempDir(prefix = 'heph-vb5-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });

function repo(remote: string | null = REMOTE, commit = true, prefix?: string): string {
  const dir = tempDir(prefix);
  gitIn(dir, 'init', '-q');
  if (remote) gitIn(dir, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Spot welder (invented)\n');
  if (commit) {
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

interface RunOpts {
  url?: string;
  token?: string;
  cwd: string;
  /** Raw stdin instead of the JSON built from the input. */
  stdin?: string | Buffer;
  env?: Record<string, string>;
  /** argv for bash instead of [SCRIPT, event]. */
  argv?: string[];
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  ms: number;
  stdinError: string | null;
}

function run(event: string, input: Record<string, unknown>, o: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env ?? {}) };
    delete env.CLAUDE_PLUGIN_OPTION_HEPH_URL;
    delete env.CLAUDE_PLUGIN_OPTION_HEPH_TOKEN;
    if (o.url !== undefined) env.CLAUDE_PLUGIN_OPTION_HEPH_URL = o.url;
    if (o.token !== undefined) env.CLAUDE_PLUGIN_OPTION_HEPH_TOKEN = o.token;
    let stdinError: string | null = null;
    const child = execFile(
      BASH as string,
      o.argv ?? [SCRIPT, event],
      { cwd: o.cwd, env, timeout: 40_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          ms: Date.now() - started,
          stdinError,
        });
      },
    );
    child.stdin?.on('error', (e: NodeJS.ErrnoException) => {
      stdinError = e.code ?? e.message;
    });
    child.stdin?.end(o.stdin ?? JSON.stringify({ hook_event_name: event, cwd: o.cwd, ...input }));
  });
}

const EVENTS = ['session-start', 'stop', 'pre-tool-use', 'post-tool-use', 'session-end'];
const toolInput = (id: string, command = 'npm test') => ({
  session_id: 's1',
  tool_name: 'Bash',
  tool_use_id: id,
  tool_input: { command },
});

describe('verify B5: hooks.json and manifests (D57)', () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks as Record<
    string,
    { matcher?: string; hooks: Record<string, unknown>[] }[]
  >;

  it('every event is a shell-form command hook on the script, no exec-form args', () => {
    const expected: Record<string, string> = {
      SessionStart: 'session-start',
      Stop: 'stop',
      PreToolUse: 'pre-tool-use',
      PostToolUse: 'post-tool-use',
      SessionEnd: 'session-end',
    };
    expect(Object.keys(hooks).sort()).toEqual(Object.keys(expected).sort());
    for (const [ev, groups] of Object.entries(hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.type).toBe('command');
          expect(h.args).toBeUndefined();
          expect(h.command).toBe(
            `bash "\${CLAUDE_PLUGIN_ROOT}/scripts/heph-hook.sh" ${expected[ev]}`,
          );
        }
      }
    }
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Bash|PowerShell');
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('Bash|PowerShell');
  });

  it('timeouts are 15 / 25 / 5 s and every curl --max-time chain fits inside them', () => {
    expect(TIMEOUT_MS).toEqual({
      'session-start': 15_000,
      stop: 25_000,
      'pre-tool-use': 5_000,
      'post-tool-use': 5_000,
      'session-end': 5_000,
    });
    const script = fs.readFileSync(SCRIPT, 'utf8');
    // Every curl call is bounded.
    const curls = script.match(/\bcurl -sS[^\n]*/g) ?? [];
    expect(curls.length).toBeGreaterThan(0);
    for (const c of curls) expect(c).toMatch(/--max-time/);
  });

  it('plugin.json options match the env vars the script reads and .mcp.json', () => {
    const pj = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8'),
    );
    expect(pj.version).toBeUndefined(); // D57: SHA versioning
    expect(Object.keys(pj.userConfig).sort()).toEqual(['heph_token', 'heph_url']);
    expect(pj.userConfig.heph_token.sensitive).toBe(true);
    const script = fs.readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('CLAUDE_PLUGIN_OPTION_HEPH_URL');
    expect(script).toContain('CLAUDE_PLUGIN_OPTION_HEPH_TOKEN');
    const mcp = fs.readFileSync(path.join(ROOT, 'plugin/.mcp.json'), 'utf8');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder of .mcp.json
    expect(mcp).toContain('${user_config.heph_url}/mcp');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder of .mcp.json
    expect(mcp).toContain('Bearer ${user_config.heph_token}');
    const mk = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'),
    );
    expect(mk.plugins[0]).toMatchObject({ name: 'heph', source: './plugin' });
    expect(mk.name).toBe('heph'); // `/plugin configure heph@heph`
  });

  it('the script is stored with LF line endings (bash breaks on CRLF)', () => {
    expect(fs.readFileSync(SCRIPT).includes(Buffer.from('\r'))).toBe(false);
    const attr = execFileSync('git', ['check-attr', 'eol', '--', 'plugin/scripts/heph-hook.sh'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(attr).toContain('eol: lf');
  });
});

describe.skipIf(BASH === null)('verify B5: hook script', { timeout: 120_000 }, () => {
  it('Heph hung (TCP accepted, no answer): every event exits 0, silent except start, within its timeout', async () => {
    const url = await blackHole();
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, 'DECISIONS.md'), '# Decisions\n');
    const results = await Promise.all(
      EVENTS.map((ev) => run(ev, toolInput('t1'), { url, token: 'tok', cwd })),
    );
    results.forEach((r, i) => {
      const ev = EVENTS[i] as string;
      expect.soft(r.code, ev).toBe(0);
      expect.soft(r.ms, `${ev} took ${r.ms} ms`).toBeLessThan((TIMEOUT_MS[ev] as number) - 1000);
      if (ev === 'session-start') {
        expect.soft(r.stdout.trim().split('\n'), ev).toHaveLength(1);
        expect.soft(r.stdout).toContain('not reachable');
      } else expect.soft(r.stdout, ev).toBe('');
    });
  });

  it('stop worst case (stop hangs, docs GET answers, PUT hangs) stays within 25 s', async () => {
    const f = await fakeServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('DECISIONS.md\t\n');
      }
      // POST stop and PUT docs never answer.
    });
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, 'DECISIONS.md'), '# Decisions\n');
    const r = await run('stop', { session_id: 's1' }, { url: f.url, token: 'tok', cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(24_000);
    expect(f.seen.map((s) => s.method).sort()).toEqual(['GET', 'POST', 'PUT']);
  });

  it('Heph answers 500 everywhere: one-line notice at start, silence elsewhere', async () => {
    const f = await fakeServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal"}');
    });
    const cwd = repo();
    for (const ev of EVENTS) {
      const r = await run(ev, toolInput('t1'), { url: f.url, token: 'tok', cwd });
      expect(r.code).toBe(0);
      if (ev === 'session-start') {
        expect(r.stdout.trim().split('\n')).toHaveLength(1);
        expect(r.stdout).not.toContain('internal');
      } else expect(r.stdout).toBe('');
    }
  });

  it('a URL with a path prefix (reverse proxy) and a trailing slash is used as a base', async () => {
    const f = await fakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('# Heph session start (fake)');
    });
    const cwd = repo();
    const r = await run(
      'session-start',
      { session_id: 's1' },
      { url: `${f.url}/heph/`, token: 'tok', cwd },
    );
    expect(r.stdout).toBe('# Heph session start (fake)\n');
    expect(f.seen[0]?.url).toBe('/heph/hooks/v1/session-start');
  });

  it('PostToolUse with 8 MB of test output: Heph up ends the run, Heph down never breaks the pipe', async () => {
    const s = await startServer();
    const p = await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
    });
    const cwd = repo();
    const o = { url: s.url, token: s.token, cwd };
    await run('session-start', { session_id: 's1' }, o);
    await run('pre-tool-use', toolInput('big'), o);
    expect(s.d.projects.get(p.data.id).activityState).toBe('claude_testing');
    const big = {
      ...toolInput('big'),
      tool_response: { stdout: 'ok 1 - test è\n'.repeat(600_000), stderr: '' },
    };
    const up = await run('post-tool-use', big, o);
    expect(up).toMatchObject({ code: 0, stdout: '', stdinError: null });
    expect(up.ms).toBeLessThan(5000);
    expect(s.d.projects.get(p.data.id).activityState).toBe('claude_working');
    const down = await run('post-tool-use', big, { ...o, url: 'http://127.0.0.1:9' });
    expect(down).toMatchObject({ code: 0, stdout: '', stdinError: null });
  });

  it('git missing from PATH: session-start still works, as outside git', async () => {
    const s = await startServer();
    const cwd = repo();
    // PATH holds only wrappers for the non-git tools the script uses.
    const argv = [
      '-c',
      'd=$(mktemp -d); for t in cat sed head curl; do printf \'#!/bin/sh\\nexec "%s" "$@"\\n\' "$(command -v $t)" > "$d/$t"; chmod +x "$d/$t"; done; ' +
        'b=$(command -v bash); PATH="$d"; "$b" "$1" "$2"; rc=$?; /usr/bin/rm -rf "$d" 2>/dev/null; exit $rc',
      '_',
      SCRIPT,
      'session-start',
    ];
    const r = await run(
      'session-start',
      { session_id: 's1' },
      { url: s.url, token: s.token, cwd, argv },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no git remote');
    expect(r.stdout).toContain('Pass session_id "s1"');
    const stop = await run(
      'stop',
      { session_id: 's1' },
      {
        url: s.url,
        token: s.token,
        cwd,
        argv: [...argv.slice(0, 3), SCRIPT, 'stop'],
      },
    );
    expect(stop).toMatchObject({ code: 0, stdout: '' });
  });

  it('SHELLOPTS=nounset in the environment does not break any event', async () => {
    const s = await startServer();
    await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
    });
    const cwd = repo();
    const env = { SHELLOPTS: 'nounset' };
    const start = await run(
      'session-start',
      { session_id: 's1' },
      { url: s.url, token: s.token, cwd, env },
    );
    expect(start.stdout).toContain('# Briefing: Spot Welder');
    expect(start.stderr).toBe('');
    for (const ev of EVENTS.slice(1)) {
      const r = await run(ev, toolInput('t1'), { url: s.url, token: s.token, cwd, env });
      expect(r).toMatchObject({ code: 0, stdout: '' });
      expect(r.stderr, ev).toBe('');
    }
    const none = await run('session-start', { session_id: 's1' }, { cwd, env });
    expect(none.stdout).toContain('/plugin configure heph@heph');
  });

  it('repo without commits, then the first commit: briefing at start, a nudge after the commit', async () => {
    const s = await startServer();
    await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'], docsSource: 'internal' },
    });
    const cwd = repo(REMOTE, false);
    const o = { url: s.url, token: s.token, cwd };
    const start = await run('session-start', { session_id: 's1' }, o);
    expect(start.stdout).toContain('# Briefing: Spot Welder');
    expect(s.d.sessions.row('s1')?.lastHeadSha ?? null).toBeNull();
    expect((await run('stop', { session_id: 's1' }, o)).stdout).toBe('');
    gitIn(cwd, 'add', '.');
    gitIn(cwd, 'commit', '-q', '-m', 'init');
    const block = await run('stop', { session_id: 's1' }, o);
    expect(JSON.parse(block.stdout).decision).toBe('block');
  });

  it('detached HEAD and a single non-origin remote: linked project, head recorded', async () => {
    const s = await startServer();
    await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
    });
    const cwd = repo(null);
    gitIn(cwd, 'remote', 'add', 'upstream', 'https://github.com/example/spot-welder.git');
    gitIn(cwd, 'checkout', '-q', '--detach');
    const r = await run('session-start', { session_id: 's1' }, { url: s.url, token: s.token, cwd });
    expect(r.stdout).toContain('# Briefing: Spot Welder');
    expect(s.d.sessions.row('s1')?.lastHeadSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a dirty tree seen from the root and then from a subfolder is the same state: no nudge', async () => {
    const s = await startServer();
    await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'], docsSource: 'internal' },
    });
    const cwd = repo();
    fs.mkdirSync(path.join(cwd, 'firmware', 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'firmware', 'src', 'main.c'), 'int main(void){return 0;}\n');
    fs.appendFileSync(path.join(cwd, 'README.md'), 'Uncommitted line\n');
    await run('session-start', { session_id: 's1' }, { url: s.url, token: s.token, cwd });
    const sub = { url: s.url, token: s.token, cwd: path.join(cwd, 'firmware', 'src') };
    for (let i = 0; i < 7; i++) {
      expect((await run('stop', { session_id: 's1', stop_hook_active: false }, sub)).stdout).toBe(
        '',
      );
    }
  });

  it('Stop finds the session id in a realistic input (key order, quotes and backslashes in the message)', async () => {
    const s = await startServer();
    const p = await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
    });
    const cwd = repo(REMOTE, true, 'heph vb5 with spaces ');
    const o = { url: s.url, token: s.token, cwd };
    await run('session-start', { session_id: '3f9c2a10-1111-4abc-9def-000000000001' }, o);
    fs.writeFileSync(
      path.join(cwd, 'DECISIONS.md'),
      '# Decisions\r\n\r\n## D1 — Rame (inventato)\r\n',
    );
    const stdin = JSON.stringify({
      session_id: '3f9c2a10-1111-4abc-9def-000000000001',
      transcript_path: 'C:\\Users\\dev\\.claude\\projects\\x\\3f9c.jsonl',
      cwd,
      permission_mode: 'default',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message:
        'Ho aggiornato il file. Nel JSON il campo "session_id": "altro-id" non va toccato.\nPercorso: C:\\tmp\\"x"',
      background_tasks: [],
    });
    await run('stop', {}, { ...o, stdin });
    // The docs upload only happens when the right session id was read.
    const d = s.d.projects.get(p.data.id).repoDetails[0];
    expect(d?.docsOrigin).toBe('hook');
  });

  it('docs paths with accents and brackets are uploaded', async () => {
    for (const docsPath of ['docs/decisioni è.md', 'docs/DECISIONS [v2].md']) {
      const s = await startServer();
      const p = await s.uiReq('POST', '/api/projects', {
        json: { name: 'Spot Welder', repos: [{ fullName: 'example/spot-welder', docsPath }] },
      });
      expect(p.status).toBe(201);
      const cwd = repo();
      fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(cwd, docsPath), '# Decisioni (inventate)\n');
      const o = { url: s.url, token: s.token, cwd };
      await run('session-start', { session_id: 's1' }, o);
      const r = await run('stop', { session_id: 's1' }, o);
      expect(r.code).toBe(0);
      expect.soft(s.d.projects.get(p.data.id).repoDetails[0]?.docsOrigin, docsPath).toBe('hook');
    }
  });

  it('two sessions in the same repo at once: both live, ending one keeps the other', async () => {
    const s = await startServer();
    const p = await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
    });
    const cwd = repo();
    const o = { url: s.url, token: s.token, cwd };
    await Promise.all([
      run('session-start', { session_id: 'a' }, o),
      run('session-start', { session_id: 'b' }, o),
    ]);
    await Promise.all([
      run('stop', { session_id: 'a' }, o),
      run('stop', { session_id: 'b' }, o),
      run('pre-tool-use', { ...toolInput('ta'), session_id: 'a' }, o),
      run('post-tool-use', { ...toolInput('tb', 'git status'), session_id: 'b' }, o),
    ]);
    expect(s.d.projects.get(p.data.id).liveSessions).toHaveLength(2);
    await run('session-end', { session_id: 'a', reason: 'prompt_input_exit' }, o);
    expect(s.d.projects.get(p.data.id).liveSessions).toHaveLength(1);
  });

  it('Stop and SessionStart do not take the index lock (another session may be running git)', async () => {
    const s = await startServer();
    await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'], docsSource: 'internal' },
    });
    const cwd = repo();
    const o = { url: s.url, token: s.token, cwd };
    await run('session-start', { session_id: 's1' }, o);
    // Same content, older mtime: `git status` refreshes the index and, unless
    // told not to (--no-optional-locks / GIT_OPTIONAL_LOCKS=0), rewrites it
    // under .git/index.lock, which makes a concurrent `git add` / `git commit`
    // of the other session fail with "index.lock: File exists".
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(cwd, 'README.md'), old, old);
    const index = path.join(cwd, '.git', 'index');
    const before = fs.readFileSync(index);
    await run('stop', { session_id: 's1' }, o);
    expect(fs.readFileSync(index).equals(before)).toBe(true);
  });

  it('per-event cost on this machine with Heph up (informative, no hard bound beyond the timeouts)', async () => {
    const s = await startServer();
    await s.uiReq('POST', '/api/projects', {
      json: { name: 'Spot Welder', repos: ['example/spot-welder'] },
    });
    const cwd = repo();
    const o = { url: s.url, token: s.token, cwd };
    const ms: Record<string, number> = {};
    for (const ev of EVENTS) ms[ev] = (await run(ev, toolInput('t1'), o)).ms;
    console.log('hook script ms per event:', ms);
    for (const ev of EVENTS) expect(ms[ev]).toBeLessThan((TIMEOUT_MS[ev] as number) / 2);
  });
});
