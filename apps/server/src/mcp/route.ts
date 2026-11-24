import type { Domain } from '@heph/core';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { authenticate, sameOrigin } from '../http/auth.js';
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
        process.env.HEPH_PUBLIC_AGENT_URL ||
        (req.requestInfo ? new URL(req.requestInfo.url).origin : 'http://localhost:8081'),
    }),
  );

  const r = new Hono<AppEnv>();
  r.use('*', authenticate(domain, { allowCookie: false }));
  r.use('*', async (c, next) => {
    // Browsers must not drive the agent endpoint from other origins.
    const origin = c.req.header('origin');
    if (origin && !sameOrigin(c)) {
      return c.json({ error: { code: 'forbidden', message: 'Cross-origin request refused' } }, 403);
    }
    if (origin && c.req.method === 'GET') {
      // sameOrigin() only checks unsafe methods; for GET compare explicitly.
      const host = c.req.header('host');
      try {
        if (new URL(origin).host !== host) {
          return c.json(
            { error: { code: 'forbidden', message: 'Cross-origin request refused' } },
            403,
          );
        }
      } catch {
        return c.json({ error: { code: 'forbidden', message: 'Bad Origin header' } }, 403);
      }
    }
    return next();
  });
  r.all('/', (c) => handler.fetch(c.req.raw));
  return r;
}
