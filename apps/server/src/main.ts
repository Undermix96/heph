import fs from 'node:fs';
import path from 'node:path';
import { createDomain, openDb } from '@heph/core';
import { serve } from '@hono/node-server';
import pino from 'pino';
import { createAgentApp, createUiApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const log = pino({ level: config.logLevel });

fs.mkdirSync(config.filesDir, { recursive: true });
const db = openDb({
  file: path.join(config.dbDir, 'heph.db'),
  migrationsDir: config.migrationsDir,
});
const domain = createDomain({ db, filesDir: config.filesDir });
log.info(
  { dbDir: config.dbDir, filesDir: config.filesDir, setupDone: domain.auth.isSetupDone() },
  'Database ready',
);

const opts = { domain, log, webDir: config.webDir };
const servers = [
  serve({ fetch: createUiApp(opts).fetch, port: config.uiPort, hostname: config.host }, (i) =>
    log.info({ port: i.port }, 'UI/REST listening'),
  ),
  serve({ fetch: createAgentApp(opts).fetch, port: config.agentPort, hostname: config.host }, (i) =>
    log.info({ port: i.port }, 'Agent (REST/uploads, MCP later) listening'),
  ),
];

/** Periodic housekeeping: stale Claude sessions, expired logins, leftover temp uploads. */
function housekeeping() {
  try {
    const expired = domain.sessions.expireStale();
    const purged = domain.auth.purgeExpiredSessions();
    const tmp = path.join(config.filesDir, 'tmp');
    let removed = 0;
    if (fs.existsSync(tmp)) {
      for (const f of fs.readdirSync(tmp)) {
        const p = path.join(tmp, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 3_600_000) {
          fs.rmSync(p, { force: true });
          removed++;
        }
      }
    }
    if (expired || purged || removed) log.info({ expired, purged, removed }, 'Housekeeping');
  } catch (err) {
    log.error({ err }, 'Housekeeping failed');
  }
}
housekeeping();
const timer = setInterval(housekeeping, 60_000);
timer.unref();

function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down');
  clearInterval(timer);
  for (const s of servers) s.close();
  db.$client.close();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
