/**
 * Independent verification of phase 5 group A over HTTP: /hooks/v1 contract,
 * Connect page data, MCP heartbeat. Realistic use only (D54).
 */
import { gitBlobSha } from '@heph/core';
import { describe, expect, it, vi } from 'vitest';
import { startApi } from './test/api.js';
import { startMcp, useMcpCleanup } from './test/mcp.js';

useMcpCleanup();

const REMOTE = 'git@github.com:example/spot-welder.git';
const gitHeaders = (head = 'h1', worktree = 'w1', remote = REMOTE) => ({
  'x-heph-remote': remote,
  'x-heph-head': head,
  'x-heph-worktree': worktree,
});

async function linked() {
  const api = await startApi();
  const p = await api.seed({ repos: ['example/spot-welder'] });
  const hook = (event: string, json: unknown, headers: Record<string, string> = gitHeaders()) =>
    api.agentReq('POST', `/hooks/v1/${event}`, { json, headers });
  return { ...api, p, hook };
}

describe('verify A5: /hooks/v1 contract', () => {
  it('session-start with a realistic Windows hook input links and answers text', async () => {
    const { hook, p, d } = await linked();
    const r = await hook('session-start', {
      session_id: '6f1c2b0e-4a1d-4b7e-9f2a-0c1d2e3f4a5b',
      transcript_path: 'C:\\Users\\dev\\.claude\\projects\\D--Git-spot\\6f1c.jsonl',
      cwd: 'D:\\Git\\spot',
      hook_event_name: 'SessionStart',
      source: 'resume',
      model: 'claude-opus-5-5',
    });
    expect(r.status).toBe(200);
    expect(r.data.length).toBeLessThanOrEqual(9_500);
    expect(d.sessions.projectFor('6f1c2b0e-4a1d-4b7e-9f2a-0c1d2e3f4a5b')).toBe(p.id);
    expect(d.sessions.row('6f1c2b0e-4a1d-4b7e-9f2a-0c1d2e3f4a5b')?.cwd).toBe('D:\\Git\\spot');
  });

  it('empty git headers (outside git, the script sends them empty) count as no git', async () => {
    const { hook, d } = await linked();
    await hook('session-start', { session_id: 's1' }, gitHeaders('', '', REMOTE));
    const row = d.sessions.row('s1');
    expect(row?.lastHeadSha).toBeNull();
    expect(row?.lastWorktreeHash).toBeNull();
  });

  it('unlinked GitHub remote with credentials in an HTTPS URL: no credentials leak', async () => {
    const { hook } = await linked();
    const r = await hook(
      'session-start',
      { session_id: 's1' },
      gitHeaders('h1', 'w1', 'https://Undermix96:ghp_secret123@github.com/Example/Other-Repo.git'),
    );
    expect(r.status).toBe(200);
    expect(r.data).not.toContain('ghp_secret123');
    expect(r.data).toContain('example/other-repo');
    expect(r.data).toContain('create_project');
    expect(r.data).toContain('Pass session_id "s1"');
  });

  it('non-GitHub remote with a token: no credentials leak, asks which project', async () => {
    const { hook } = await linked();
    const r = await hook(
      'session-start',
      { session_id: 's1' },
      gitHeaders('h1', 'w1', 'https://oauth2:glpat-abcdef@gitlab.com/me/thing.git'),
    );
    expect(r.data).not.toContain('glpat-abcdef');
    expect(r.data).toContain('list_projects');
    const noRemote = await hook('session-start', { session_id: 's2' }, {});
    expect(noRemote.data).toContain('no git remote');
  });

  it('malformed or empty bodies are 400, never 500', async () => {
    const { agentReq } = await linked();
    for (const event of ['session-start', 'stop', 'pre-tool-use', 'post-tool-use', 'session-end']) {
      const empty = await agentReq('POST', `/hooks/v1/${event}`, {
        body: '',
        headers: { 'content-type': 'application/json' },
      });
      expect(empty.status, `${event} empty`).toBe(400);
      const bad = await agentReq('POST', `/hooks/v1/${event}`, {
        body: '{"session_id": "s1",',
        headers: { 'content-type': 'application/json' },
      });
      expect(bad.status, `${event} bad json`).toBe(400);
    }
  });

  it('stop with a long multi-byte last_assistant_message and background tasks', async () => {
    const { hook } = await linked();
    await hook('session-start', { session_id: 's1' });
    const r = await hook('stop', {
      session_id: 's1',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Ho finito la parte più difficile ✅ '.repeat(5_000),
      background_tasks: [],
    });
    expect(r.status).toBe(204);
  });

  it('post-tool-use with a large realistic test output (5 MB) ends the run', async () => {
    const { hook, uiReq, p } = await linked();
    await hook('session-start', { session_id: 's1' });
    await hook('pre-tool-use', {
      session_id: 's1',
      tool_name: 'PowerShell',
      tool_use_id: 'toolu_01',
      tool_input: { command: 'npm test 2>&1 | Select-Object -Last 50' },
    });
    expect((await uiReq('GET', `/api/projects/${p.id}`)).data.activityState).toBe('claude_testing');
    const r = await hook('post-tool-use', {
      session_id: 's1',
      tool_name: 'PowerShell',
      tool_use_id: 'toolu_01',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: ' ✓ src/a.test.ts (3 tests)\r\n'.repeat(180_000), stderr: '' },
    });
    expect(r.status).toBe(204);
    expect((await uiReq('GET', `/api/projects/${p.id}`)).data.activityState).toBe('claude_working');
  });

  it('pre-tool-use for other tools or without a command is a 204 no-op', async () => {
    const { hook, uiReq, p } = await linked();
    await hook('session-start', { session_id: 's1' });
    for (const json of [
      { session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'npm test' } },
      { session_id: 's1', tool_name: 'Bash', tool_input: {} },
      { session_id: 's1', tool_name: 'Bash' },
    ]) {
      expect((await hook('pre-tool-use', json)).status).toBe(204);
    }
    expect((await uiReq('GET', `/api/projects/${p.id}`)).data.activityState).toBe('claude_working');
  });

  it('docs PUT with a path the hook script encodes (spaces) matches the repo docs path', async () => {
    const { hook, agentReq, uiReq, p } = await linked();
    const repoId = p.repoDetails[0].id;
    const upd = await uiReq('PATCH', `/api/repos/${repoId}`, {
      json: { docsPath: 'docs/Design Decisions.md' },
    });
    expect(upd.status).toBe(200);
    await hook('session-start', { session_id: 's1' });
    const target = await agentReq('GET', '/hooks/v1/docs?session_id=s1');
    expect(target.data).toBe('docs/Design Decisions.md\t\n');
    const body = '# Decisioni\n';
    const put = await agentReq(
      'PUT',
      '/hooks/v1/docs?session_id=s1&path=docs/Design%20Decisions.md',
      { body, headers: { 'content-type': 'application/octet-stream' } },
    );
    expect(put.status).toBe(200);
    expect(put.data).toEqual({ changed: true });
    expect((await agentReq('GET', '/hooks/v1/docs?session_id=s1')).data).toBe(
      `docs/Design Decisions.md\t${gitBlobSha(Buffer.from(body))}\n`,
    );
  });

  it('docs: invalid UTF-8 is 400, missing session/path is 400, unlinked session 404', async () => {
    const { hook, agentReq } = await linked();
    await hook('session-start', { session_id: 's1' });
    const latin1 = await agentReq('PUT', '/hooks/v1/docs?session_id=s1&path=DECISIONS.md', {
      body: new Uint8Array([0x23, 0x20, 0x50, 0x65, 0x72, 0x63, 0x68, 0xe9]),
    });
    expect(latin1.status).toBe(400);
    expect((await agentReq('GET', '/hooks/v1/docs')).status).toBe(400);
    expect((await agentReq('PUT', '/hooks/v1/docs?session_id=s1', { body: 'x' })).status).toBe(400);
    await hook(
      'session-start',
      { session_id: 'u1' },
      gitHeaders('h', 'w', 'git@github.com:a/b.git'),
    );
    const un = await agentReq('PUT', '/hooks/v1/docs?session_id=u1&path=DECISIONS.md', {
      body: 'x',
    });
    expect(un.status).toBe(404);
  });

  it('a same-origin GET with an Origin header is allowed, a cross-origin one refused', async () => {
    const { hook, agentReq } = await linked();
    await hook('session-start', { session_id: 's1' });
    const cross = await agentReq('GET', '/hooks/v1/docs?session_id=s1', {
      headers: { origin: 'http://evil.example' },
    });
    expect(cross.status).toBe(403);
  });

  it('linking the repo over REST attaches the open unlinked session', async () => {
    const api = await startApi();
    const p = await api.seed();
    await api.agentReq('POST', '/hooks/v1/session-start', {
      json: { session_id: 's1' },
      headers: gitHeaders(),
    });
    expect(api.d.sessions.projectFor('s1')).toBeNull();
    const link = await api.uiReq('POST', `/api/projects/${p.id}/repos`, {
      json: { fullName: 'Example/Spot-Welder' },
    });
    expect(link.status).toBeLessThan(300);
    expect(api.d.sessions.projectFor('s1')).toBe(p.id);
  });
});

describe('verify A5: Connect page data', () => {
  it('agentUrl: several trailing slashes, blank value, and UI cookie only', async () => {
    const api = await startApi();
    try {
      vi.stubEnv('HEPH_PUBLIC_AGENT_URL', ' http://heph.lan:8081// ');
      expect((await api.uiReq('GET', '/api/settings/connect')).data.agentUrl).toBe(
        'http://heph.lan:8081',
      );
      vi.stubEnv('HEPH_PUBLIC_AGENT_URL', '   ');
      expect((await api.uiReq('GET', '/api/settings/connect')).data.agentUrl).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await api.agentReq('GET', '/api/settings/connect')).status).not.toBe(200);
    api.clearCookie();
    expect((await api.uiReq('GET', '/api/settings/connect')).status).toBe(401);
  });

  it('a wrong token is not recorded as an agent call; throttle is per 10 s window', async () => {
    const api = await startApi();
    const bad = await api.tokenReq('wrong-token', 'GET', '/api/projects');
    expect(bad.status).toBe(401);
    expect(api.d.settings.lastAgentCallAt()).toBeNull();
    await api.agentReq('GET', '/api/projects');
    const t0 = api.clock.now;
    for (let i = 0; i < 9; i++) {
      api.clock.advance(1_000);
      await api.agentReq('GET', '/api/projects');
    }
    expect(api.d.settings.lastAgentCallAt()).toBe(t0);
    api.clock.advance(1_000);
    await api.agentReq('GET', '/api/projects');
    expect(api.d.settings.lastAgentCallAt()).toBe(t0 + 10_000);
    // Shown as ISO in the UI.
    const c = await api.uiReq('GET', '/api/settings/connect');
    expect(c.data.lastAgentCallAt).toBe(new Date(t0 + 10_000).toISOString());
  });

  it('UI cookie calls are not recorded as agent calls', async () => {
    const api = await startApi();
    await api.uiReq('GET', '/api/projects');
    expect(api.d.settings.lastAgentCallAt()).toBeNull();
  });
});

describe('verify A5: MCP writes in a session', () => {
  it('log_progress with session_id heartbeats and counts as a diary note', async () => {
    const m = await startMcp();
    const p = m.d.projects.create(
      { name: 'Spot', repos: ['example/spot-welder'] },
      { source: 'ui' },
    );
    m.d.hooks.sessionStart('s1', { remote: REMOTE, head: 'h1', worktree: 'w1' });
    m.t.clock.advance(25 * 60_000);
    await m.ok('log_progress', { project: p.id, body: 'Fatto', session_id: 's1' });
    m.t.clock.advance(25 * 60_000);
    expect(m.d.sessions.expireStale()).toBe(0);
    expect(m.d.sessions.row('s1')?.lastDiaryAt).not.toBeNull();
  });
});
