import type { Domain } from '@heph/core';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { publicAgentUrl } from '../config.js';
import { authenticate, refuseCrossOrigin } from '../http/auth.js';
import type { AppEnv } from '../http/common.js';
import { createHephMcpServer } from './server.js';

/**
 * MCP endpoint (Streamable HTTP, stateless) for the agent port.
 * Serves the 2026-07-28 protocol and, through the SDK's fallback, 2025-era clients.
 */
export function mcpRoutes(domain: Domain) {
  const handler = createMcpHandler((req) =>
    createHephMcpServer(domain, {
      agentOrigin:
        publicAgentUrl() ??
        (req.requestInfo ? new URL(req.requestInfo.url).origin : 'http://localhost:8081'),
    }),
  );

  const r = new Hono<AppEnv>();
  r.use('*', authenticate(domain, { allowCookie: false }));
  r.use('*', refuseCrossOrigin);
  r.all('/', (c) => handler.fetch(c.req.raw));
  return r;
}
