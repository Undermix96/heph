import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import pino from 'pino';
import { loadConfig } from './config.js';

const config = loadConfig();
const log = pino({ level: config.logLevel });

const ui = new Hono();
ui.get('/health', (c) => c.json({ ok: true, port: 'ui' }));

const agent = new Hono();
agent.get('/health', (c) => c.json({ ok: true, port: 'agent' }));

const servers = [
  serve({ fetch: ui.fetch, port: config.uiPort, hostname: config.host }, (i) =>
    log.info({ port: i.port }, 'UI/REST listening'),
  ),
  serve({ fetch: agent.fetch, port: config.agentPort, hostname: config.host }, (i) =>
    log.info({ port: i.port }, 'Agent (MCP/hooks) listening'),
  ),
];

function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down');
  for (const s of servers) s.close();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
