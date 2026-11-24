import { describe, expect, it } from 'vitest';
import { connectClient, rpcBody, startMcp, useMcpCleanup } from '../test/mcp.js';

useMcpCleanup();

const READ_TOOLS = [
  'get_briefing',
  'list_projects',
  'needs_attention',
  'get_project',
  'get_diary',
  'search',
  'get_file',
  'get_docs',
  'list_proposals',
];
const WRITE_TOOLS = [
  'create_project',
  'update_project',
  'link_repo',
  'log_progress',
  'set_status',
  'update_docs',
  'add_phase',
  'update_phase',
  'move_phase',
  'add_task',
  'update_task',
  'move_task',
  'complete_task',
  'reopen_task',
  'set_next_task',
  'delete_phase',
  'delete_task',
  'restructure_roadmap',
  'add_material',
  'update_material',
  'request_upload',
];
const DESTRUCTIVE = ['delete_phase', 'delete_task', 'restructure_roadmap', 'set_status'];

const INIT_2025 = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'legacy', version: '0' },
  },
};

describe('MCP protocol: tools, prompts, instructions', () => {
  it('lists every tool with a title, description and object input schema', async () => {
    const m = await startMcp();
    const { tools } = await m.client.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining([...READ_TOOLS, ...WRITE_TOOLS]));
    // The server currently registers exactly these 30 tools.
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(READ_TOOLS.length + WRITE_TOOLS.length);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description!.length, tool.name).toBeGreaterThan(10);
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
    const brief = tools.find((x) => x.name === 'get_briefing')!;
    expect(Object.keys(brief.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['project', 'repo', 'session_id']),
    );
    const log = tools.find((x) => x.name === 'log_progress')!;
    expect(log.inputSchema.required).toEqual(expect.arrayContaining(['project', 'body']));
  });

  it('annotates reads as read-only and destructive tools as destructive', async () => {
    const m = await startMcp();
    const { tools } = await m.client.listTools();
    const byName = new Map(tools.map((x) => [x.name, x]));
    for (const name of READ_TOOLS) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of WRITE_TOOLS) {
      const a = byName.get(name)?.annotations;
      expect(a?.readOnlyHint, name).toBe(false);
      expect(a?.destructiveHint, name).toBe(DESTRUCTIVE.includes(name));
      expect(a?.openWorldHint, name).toBe(false);
    }
  });

  it('every write tool accepts an optional session_id', async () => {
    const m = await startMcp();
    const { tools } = await m.client.listTools();
    for (const name of WRITE_TOOLS) {
      const s = tools.find((x) => x.name === name)!.inputSchema;
      expect(Object.keys(s.properties ?? {}), name).toContain('session_id');
      expect(s.required ?? [], name).not.toContain('session_id');
    }
  });

  it('exposes the prompts and renders heph_resume with its argument', async () => {
    const m = await startMcp();
    const { prompts } = await m.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['heph_overview', 'heph_resume']);
    const resume = prompts.find((p) => p.name === 'heph_resume')!;
    expect(resume.arguments?.map((a) => a.name)).toEqual(['project']);

    const r = await m.client.getPrompt({ name: 'heph_resume', arguments: { project: 'me/lamp' } });
    expect(r.messages).toHaveLength(1);
    const msg = r.messages[0]!;
    expect(msg.role).toBe('user');
    expect(msg.content.type).toBe('text');
    const text = (msg.content as { text: string }).text;
    expect(text).toContain('get_briefing');
    expect(text).toContain('"me/lamp"');

    const o = await m.client.getPrompt({ name: 'heph_overview' });
    expect((o.messages[0]!.content as { text: string }).text).toContain('needs_attention');
  });

  it('getPrompt heph_resume without its required argument is rejected', async () => {
    const m = await startMcp();
    await expect(m.client.getPrompt({ name: 'heph_resume', arguments: {} })).rejects.toThrow();
  });

  it('provides server info and instructions after connect', async () => {
    const m = await startMcp();
    const info = m.client.getServerVersion();
    expect(info?.name).toBe('heph');
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+$/);
    const instructions = m.client.getInstructions();
    expect(instructions).toContain('get_briefing');
    expect(instructions).toContain('confirmed: true');
    expect(instructions).toContain('1-based');
    const caps = m.client.getServerCapabilities();
    expect(caps?.tools).toBeTruthy();
    expect(caps?.prompts).toBeTruthy();
  });
});

describe('MCP protocol: authentication and origin', () => {
  it('refuses requests without a token, with a wrong token, or with a cookie alone', async () => {
    const m = await startMcp();
    expect((await m.rawPost(INIT_2025)).status).toBe(401);
    expect((await m.rawPost(INIT_2025, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await m.rawPost(INIT_2025, { authorization: `Bearer ${m.token}x` })).status).toBe(401);
    // A valid UI session cookie must not authenticate the agent endpoint.
    const cookie = m.t.getCookie();
    expect(cookie).toMatch(/^heph_session=/);
    const withCookie = await m.rawPost(INIT_2025, { cookie });
    expect(withCookie.status).toBe(401);
    // GET is refused as well.
    const get = await fetch(`${m.base}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(get.status).toBe(401);
  });

  it('the official client fails to connect with a wrong token', async () => {
    const m = await startMcp();
    await expect(connectClient(m.base, { authorization: 'Bearer wrong' })).rejects.toThrow();
  });

  it('refuses a foreign Origin with 403 but accepts its own origin', async () => {
    const m = await startMcp();
    const auth = { authorization: `Bearer ${m.token}` };
    const foreign = await m.rawPost(INIT_2025, { ...auth, origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    const bad = await m.rawPost(INIT_2025, { ...auth, origin: 'not a url' });
    expect(bad.status).toBe(403);
    const foreignGet = await fetch(`${m.base}/mcp`, {
      headers: { ...auth, origin: 'http://evil.example', accept: 'text/event-stream' },
    });
    expect(foreignGet.status).toBe(403);
    const same = await m.rawPost(INIT_2025, { ...auth, origin: m.base });
    expect(same.status).toBe(200);
  });
});

describe('MCP protocol: 2025-era client over raw JSON-RPC', () => {
  it('initialize, tools/list and tools/call get_briefing work without the SDK client', async () => {
    const m = await startMcp();
    await m.ok('create_project', {
      name: 'Lamp',
      repos: ['me/lamp'],
      phases: [{ title: 'Build', tasks: ['Solder'] }],
    });
    const auth = { authorization: `Bearer ${m.token}` };

    const initRes = await m.rawPost(INIT_2025, auth);
    expect(initRes.status).toBe(200);
    const init = await rpcBody(initRes);
    expect(init.id).toBe(1);
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('heph');
    expect(init.result.instructions).toContain('get_briefing');
    expect(init.result.capabilities.tools).toBeTruthy();
    const session = initRes.headers.get('mcp-session-id');
    const followHeaders: Record<string, string> = {
      ...auth,
      'mcp-protocol-version': '2025-06-18',
      ...(session ? { 'mcp-session-id': session } : {}),
    };

    const initialized = await m.rawPost(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      followHeaders,
    );
    expect(initialized.status).toBeLessThan(300);

    const listRes = await m.rawPost(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      followHeaders,
    );
    expect(listRes.status).toBe(200);
    const list = await rpcBody(listRes);
    expect(list.id).toBe(2);
    const names = list.result.tools.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['get_briefing', 'restructure_roadmap']));

    const callRes = await m.rawPost(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_briefing', arguments: { repo: 'me/lamp' } },
      },
      followHeaders,
    );
    expect(callRes.status).toBe(200);
    const call = await rpcBody(callRes);
    expect(call.id).toBe(3);
    expect(call.result.isError ?? false).toBe(false);
    expect(call.result.content[0].type).toBe('text');
    expect(call.result.content[0].text).toContain('# Briefing: Lamp');
    expect(call.result.content[0].text).toContain('Solder');
  });

  it('raw tools/call with an unknown repo returns an isError result', async () => {
    const m = await startMcp();
    const auth = { authorization: `Bearer ${m.token}`, 'mcp-protocol-version': '2025-06-18' };
    await rpcBody(await m.rawPost(INIT_2025, auth));
    const res = await m.rawPost(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_briefing', arguments: { repo: 'me/nothing' } },
      },
      auth,
    );
    const body = await rpcBody(res);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('create_project');
  });
});

describe('MCP protocol: stateless transport', () => {
  it('GET and DELETE are 405 (no SSE stream or session); malformed bodies are 400', async () => {
    const m = await startMcp();
    const auth = { authorization: `Bearer ${m.token}` };
    const get = await fetch(`${m.base}/mcp`, { headers: { ...auth, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    await get.text();
    const del = await fetch(`${m.base}/mcp`, { method: 'DELETE', headers: auth });
    expect(del.status).toBe(405);
    await del.text();
    const notRpc = await m.rawPost('garbage', auth);
    expect(notRpc.status).toBe(400);
    expect((await rpcBody(notRpc)).error.code).toBe(-32600);
    const badJson = await fetch(`${m.base}/mcp`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect((await rpcBody(badJson)).error.code).toBe(-32700);
  });

  it('two clients share the same domain state', async () => {
    const m = await startMcp();
    const other = await connectClient(m.base, { authorization: `Bearer ${m.token}` });
    await m.ok('create_project', { name: 'Shared' });
    const r = await other.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.stringify(r.content)).toContain('**Shared**');
  });
});

describe('MCP protocol: argument validation', () => {
  it('wrong types and missing required arguments surface as tool errors', async () => {
    const m = await startMcp();
    const cases: [string, Record<string, unknown>][] = [
      ['get_project', {}],
      ['get_project', { project: { nested: true } }],
      ['get_project', { project: -3 }],
      ['log_progress', { project: 1 }],
      ['log_progress', { project: 1, body: 42 }],
      ['add_phase', { project: 1, title: 'x', position: 0 }],
      ['add_task', { phase_id: 'one', title: 'x' }],
      ['set_status', { project: 1, status: 'exploded' }],
      ['set_next_task', { project: 1 }],
      ['get_diary', { project: 1, limit: 1000 }],
      ['search', { query: '   ' }],
      ['restructure_roadmap', { project: 1, operations: [] }],
      ['restructure_roadmap', { project: 1, operations: [{ op: 'explode' }] }],
      ['add_material', { project: 1, name: 'Wire', price: -1 }],
      ['create_project', { name: '' }],
    ];
    for (const [name, args] of cases) {
      const r = await m.call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text, name).toContain('Input validation error');
    }
  });

  it('a validation error names the offending argument', async () => {
    const m = await startMcp();
    const r = await m.call('log_progress', { project: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid arguments for tool log_progress');
    expect(r.text).toContain('body');
  });

  it('calling an unknown tool is a JSON-RPC error (the client throws)', async () => {
    const m = await startMcp();
    await expect(m.call('no_such_tool', {})).rejects.toThrow(/no_such_tool not found/);
  });
});
