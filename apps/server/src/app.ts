import fs from 'node:fs';
import path from 'node:path';
import type { Domain } from '@heph/core';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Logger } from 'pino';
import { authenticate } from './http/auth.js';
import { type AppEnv, errorHandler } from './http/common.js';
import { mcpRoutes } from './mcp/route.js';
import { apiRoutes } from './routes/api.js';
import { authRoutes, LoginLimiter } from './routes/auth.js';
import { uploadRoutes } from './routes/upload.js';

export interface AppOptions {
  domain: Domain;
  log: Logger;
  /** Built web UI directory; when null the UI port serves only the API. */
  webDir: string | null;
  limiter?: LoginLimiter;
}

const notFoundJson = (c: { json: (b: unknown, s: 404) => Response }) =>
  c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);

/**
 * UI/REST app (published through the tunnel): web UI, auth routes and the REST
 * API, authenticated by session cookie or bearer token.
 */
export function createUiApp(opts: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(opts.log));
  app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false }));
  app.get('/health', (c) =>
    c.json({ ok: true, port: 'ui', version: process.env.HEPH_VERSION || 'dev' }),
  );

  app.route('/api', authRoutes(opts.domain, opts.limiter ?? new LoginLimiter()));
  const api = new Hono<AppEnv>();
  api.use('*', authenticate(opts.domain, { allowCookie: true }));
  api.route('/', apiRoutes(opts.domain));
  app.route('/api', api);
  app.all('/api/*', notFoundJson);

  if (opts.webDir && fs.existsSync(path.join(opts.webDir, 'index.html'))) {
    const root = path.relative(process.cwd(), opts.webDir) || '.';
    const index = fs.readFileSync(path.join(opts.webDir, 'index.html'), 'utf8');
    app.use('/assets/*', serveStatic({ root }));
    app.use('*', serveStatic({ root }));
    // SPA fallback: client-side routes get index.html.
    app.get('*', (c) => c.html(index));
  }
  app.notFound(notFoundJson);
  return app;
}

/**
 * Agent app (LAN only): REST API with the bearer token, one-time uploads,
 * and later MCP and hook endpoints.
 */
export function createAgentApp(opts: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(opts.log));
  app.get('/health', (c) =>
    c.json({ ok: true, port: 'agent', version: process.env.HEPH_VERSION || 'dev' }),
  );
  app.route('/upload', uploadRoutes(opts.domain));
  app.route('/mcp', mcpRoutes(opts.domain));
  const api = new Hono<AppEnv>();
  api.use('*', authenticate(opts.domain, { allowCookie: false }));
  api.route('/', apiRoutes(opts.domain));
  app.route('/api', api);
  app.notFound(notFoundJson);
  return app;
}
