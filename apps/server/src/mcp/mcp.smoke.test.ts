import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApps } from '../test/app.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function start() {
  const t = makeApps();
  const token = await t.setup();
  const server = serve({ fetch: t.agent.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => {
    server.close();
    t.cleanup();
  });
  return { t, token, base };
}

describe('MCP smoke', () => {
  it('lists tools and runs a briefing with the official client', async () => {
    const { token, base } = await start();
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    closers.push(() => void client.close());
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name)).toEqual(
      expect.arrayContaining([
        'get_briefing',
        'log_progress',
        'restructure_roadmap',
        'request_upload',
      ]),
    );
    const created = await client.callTool({
      name: 'create_project',
      arguments: {
        name: 'Lamp',
        repos: ['me/lamp'],
        phases: [{ title: 'Build', tasks: ['Solder'] }],
      },
    });
    expect(JSON.stringify(created.content)).toContain('Created project #1');
    const brief = await client.callTool({
      name: 'get_briefing',
      arguments: { repo: 'me/lamp', session_id: 's-1' },
    });
    expect(JSON.stringify(brief.content)).toContain('Solder');
    const bad = await client.callTool({ name: 'get_briefing', arguments: { repo: 'me/unknown' } });
    expect(bad.isError).toBe(true);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['heph_overview', 'heph_resume']);
  });

  it('serves a 2025-era client (legacy initialize) and requires the token', async () => {
    const { token, base } = await start();
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'legacy', version: '0' },
      },
    };
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const noAuth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(init),
    });
    expect(noAuth.status).toBe(401);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token}` },
      body: JSON.stringify(init),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"protocolVersion":"2025-06-18"');
    expect(body).toContain('"name":"heph"');
  });
});
