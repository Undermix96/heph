import { gitBlobSha } from '@heph/core';
import { describe, expect, it, vi } from 'vitest';
import { startApi } from '../test/api.js';

const REMOTE = 'git@github.com:example/spot-welder.git';
const gitHeaders = (head = 'h1', worktree = 'w1') => ({
  'x-heph-remote': REMOTE,
  'x-heph-head': head,
  'x-heph-worktree': worktree,
});

async function linked() {
  const api = await startApi();
  const p = await api.seed({ repos: ['example/spot-welder'] });
  const hook = (event: string, json: Record<string, unknown>, headers = gitHeaders()) =>
    api.agentReq('POST', `/hooks/v1/${event}`, { json, headers });
  return { ...api, p, hook };
}

describe('/hooks/v1 (agent port, D58)', () => {
  it('needs the API token and refuses cross-origin browsers', async () => {
    const api = await startApi();
    const anon = await api.agent.request('/hooks/v1/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"session_id":"s1"}',
    });
    expect(anon.status).toBe(401);
    const cross = await api.agentReq('POST', '/hooks/v1/session-start', {
      json: { session_id: 's1' },
      headers: { origin: 'http://evil.example' },
    });
    expect(cross.status).toBe(403);
    // Not served on the UI port (Cloudflare Access would block curl anyway, D24).
    const ui = await api.agentReq('POST', '/hooks/v1/session-start', { json: {} }, 'ui');
    expect(ui.status).toBe(404);
  });

  it('session-start returns the context as plain text and the project goes live', async () => {
    const { hook, uiReq, p } = await linked();
    const r = await hook('session-start', {
      session_id: 'abc',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: 'D:\\Git\\spot',
      model: 'x',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(r.data).toContain('# Briefing: Spot Welder');
    expect(r.data).toContain('Pass session_id "abc"');
    const detail = await uiReq('GET', `/api/projects/${p.id}`);
    expect(detail.data.activityState).toBe('claude_working');
  });

  it('pre/post-tool-use toggle testing for Bash and PowerShell test commands', async () => {
    const { hook, uiReq, p } = await linked();
    await hook('session-start', { session_id: 's1' });
    const state = async () => (await uiReq('GET', `/api/projects/${p.id}`)).data.activityState;
    for (const tool of ['Bash', 'PowerShell']) {
      const id = `tu-${tool}`;
      const pre = await hook('pre-tool-use', {
        session_id: 's1',
        tool_name: tool,
        tool_use_id: id,
        tool_input: { command: 'npm test' },
      });
      expect(pre.status).toBe(204);
      expect(await state()).toBe('claude_testing');
      const post = await hook('post-tool-use', {
        session_id: 's1',
        tool_name: tool,
        tool_use_id: id,
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'ok', stderr: '', interrupted: false },
      });
      expect(post.status).toBe(204);
      expect(await state()).toBe('claude_working');
    }
    await hook('pre-tool-use', {
      session_id: 's1',
      tool_name: 'Read',
      tool_use_id: 'x',
      tool_input: { command: 'npm test' },
    });
    expect(await state()).toBe('claude_working');
  });

  it('stop returns 204 or a block decision; session-end closes', async () => {
    const { hook, uiReq, p } = await linked();
    await hook('session-start', { session_id: 's1' });
    const quiet = await hook('stop', { session_id: 's1', stop_hook_active: false });
    expect(quiet.status).toBe(204);
    expect(quiet.data).toBeNull();
    const block = await hook(
      'stop',
      { session_id: 's1', stop_hook_active: false, last_assistant_message: 'done' },
      gitHeaders('h2'),
    );
    expect(block.status).toBe(200);
    expect(block.data.decision).toBe('block');
    expect(block.data.reason).toContain('log_progress');
    const end = await hook('session-end', { session_id: 's1', reason: 'prompt_input_exit' });
    expect(end.status).toBe(204);
    const detail = await uiReq('GET', `/api/projects/${p.id}`);
    expect(detail.data.liveSessions).toHaveLength(0);
  });

  it('a log_progress over REST with the session header counts as a diary note', async () => {
    const { hook, agentReq, p, d } = await linked();
    await hook('session-start', { session_id: 's1' });
    const r = await agentReq('POST', `/api/projects/${p.id}/diary`, {
      json: { body: 'Wrote the tests' },
      headers: { 'x-heph-session-id': 's1' },
    });
    expect(r.status).toBe(201);
    expect(d.sessions.row('s1')?.lastDiaryAt).not.toBeNull();
  });

  it('docs: GET gives path and hash, PUT stores raw bytes once', async () => {
    const { hook, agentReq, uiReq, p } = await linked();
    await hook('session-start', { session_id: 's1' });
    const empty = await agentReq('GET', '/hooks/v1/docs?session_id=s1');
    expect(empty.data).toBe('DECISIONS.md\t\n');
    const content = '# Decisions\r\n\r\n## D1 — Résumé\r\n'; // CRLF and accents kept as bytes
    const put = await agentReq('PUT', '/hooks/v1/docs?session_id=s1&path=DECISIONS.md', {
      body: content,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.status).toBe(200);
    expect(put.data).toEqual({ changed: true });
    const again = await agentReq('PUT', '/hooks/v1/docs?session_id=s1&path=DECISIONS.md', {
      body: content,
    });
    expect(again.data).toEqual({ changed: false });
    const hash = gitBlobSha(Buffer.from(content));
    expect((await agentReq('GET', '/hooks/v1/docs?session_id=s1')).data).toBe(
      `DECISIONS.md\t${hash}\n`,
    );
    const docs = await uiReq('GET', `/api/projects/${p.id}/docs`);
    expect(JSON.stringify(docs.data)).toContain('Résumé');
    const wrong = await agentReq('PUT', '/hooks/v1/docs?session_id=s1&path=README.md', {
      body: 'x',
    });
    expect(wrong.status).toBe(409);
    const unknown = await agentReq('GET', '/hooks/v1/docs?session_id=nope');
    expect(unknown.status).toBe(200);
    expect(unknown.data ?? '').toBe(''); // empty body: nothing to sync
  });

  it('rejects bodies without a session id', async () => {
    const { hook } = await linked();
    expect((await hook('session-start', {})).status).toBe(400);
    expect((await hook('stop', { session_id: '' })).status).toBe(400);
  });

  it('a token call is recorded for the Connect page, throttled', async () => {
    const { hook, d, clock } = await linked();
    expect(d.settings.lastAgentCallAt()).toBeNull();
    await hook('session-start', { session_id: 's1' });
    const first = d.settings.lastAgentCallAt();
    expect(first).toBe(clock.now);
    clock.advance(5_000);
    await hook('stop', { session_id: 's1' });
    expect(d.settings.lastAgentCallAt()).toBe(first);
    clock.advance(6_000);
    await hook('stop', { session_id: 's1' });
    expect(d.settings.lastAgentCallAt()).toBe(clock.now);
  });
});

describe('GET /api/settings/connect', () => {
  it('gives the public agent URL and the last agent call, UI only', async () => {
    const api = await startApi();
    vi.stubEnv('HEPH_PUBLIC_AGENT_URL', 'http://192.168.1.10:8081/');
    try {
      const before = await api.uiReq('GET', '/api/settings/connect');
      expect(before.data).toEqual({ agentUrl: 'http://192.168.1.10:8081', lastAgentCallAt: null });
      await api.agentReq('GET', '/api/projects');
      const after = await api.uiReq('GET', '/api/settings/connect');
      expect(after.data.lastAgentCallAt).toBe(new Date(api.clock.now).toISOString());
      expect((await api.agentReq('GET', '/api/settings/connect', {}, 'ui')).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await api.uiReq('GET', '/api/settings/connect')).data.agentUrl).toBeNull();
  });
});
