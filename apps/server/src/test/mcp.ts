import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach } from 'vitest';
import { makeApps } from './app.js';

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };

export interface CallResult {
  /** All text blocks joined with a blank line. */
  text: string;
  isError: boolean;
  content: McpContent[];
}

const closers: (() => Promise<void> | void)[] = [];

/** Registers an afterEach that closes every client and server started by `startMcp`. */
export function useMcpCleanup() {
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });
}

/** Connects an official MCP client to `base`/mcp with the given headers. */
export async function connectClient(base: string, headers: Record<string, string>) {
  const client = new Client({ name: 'heph-e2e', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }),
  );
  closers.push(() => client.close());
  return client;
}

/**
 * Agent app on a real ephemeral port over a fresh in-memory domain, with a
 * connected official MCP client. Call `useMcpCleanup()` once per test file.
 */
export async function startMcp() {
  const t = makeApps();
  const token = await t.setup();
  const server = serve({ fetch: t.agent.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => {
    server.closeAllConnections?.();
    server.close();
    t.cleanup();
  });
  const client = await connectClient(base, { authorization: `Bearer ${token}` });

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
    const r = await client.callTool({ name, arguments: args });
    const content = (r.content ?? []) as McpContent[];
    const text = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n\n');
    return { text, isError: r.isError === true, content };
  };

  /** Like `call`, but fails the test when the tool returns an error. */
  const ok = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.text;
  };

  /** Raw POST to /mcp (JSON-RPC body) with optional extra headers. */
  const rawPost = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  return { t, d: t.d, token, base, client, call, ok, rawPost };
}

export type Mcp = Awaited<ReturnType<typeof startMcp>>;

/** Parses a JSON-RPC response that may be plain JSON or a single SSE `data:` event. */
// biome-ignore lint/suspicious/noExplicitAny: test convenience
export async function rpcBody(res: Response): Promise<any> {
  const body = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = body
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data.at(-1) ?? 'null');
  }
  return body ? JSON.parse(body) : null;
}

/** Creates the standard seed project (two phases of two tasks) over MCP and returns its ids. */
export async function seedProject(m: Mcp, extra: Record<string, unknown> = {}) {
  const text = await m.ok('create_project', {
    name: 'Spot Welder',
    phases: [
      { title: 'Design', tasks: ['Schematic', 'BOM'] },
      { title: 'Build', tasks: ['Case', 'Wiring'] },
    ],
    ...extra,
  });
  const id = Number(/Created project #(\d+)/.exec(text)?.[1]);
  const detail = m.d.projects.get(id);
  const [design, build] = detail.phases;
  return {
    project: detail,
    id: detail.id,
    slug: detail.slug,
    design: design!,
    build: build!,
    tasks: {
      schematic: design!.tasks[0]!,
      bom: design!.tasks[1]!,
      case: build!.tasks[0]!,
      wiring: build!.tasks[1]!,
    },
  };
}
