import path from 'node:path';

/** Runtime configuration, read from environment variables. */
export interface ServerConfig {
  /** Directory holding the SQLite database (`/data/db` in the container). */
  dbDir: string;
  /** Directory holding uploaded files and thumbnails (`/data/files` in the container). */
  filesDir: string;
  /** Port for the web UI and REST API (published through the tunnel). */
  uiPort: number;
  /** Port for MCP, hooks and agent uploads (LAN only). */
  agentPort: number;
  /** Host to bind both ports to. */
  host: string;
  /** Directory with the built web UI; served as static files when present. */
  webDir: string | null;
  /** Directory with SQL migrations. */
  migrationsDir: string;
  logLevel: string;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // INIT_CWD: the directory npm was invoked from (repo root for `npm run dev`).
  const dataDir = env.HEPH_DATA_DIR ?? path.resolve(env.INIT_CWD ?? process.cwd(), 'data');
  return {
    dbDir: env.HEPH_DB_DIR ?? path.join(dataDir, 'db'),
    filesDir: env.HEPH_FILES_DIR ?? path.join(dataDir, 'files'),
    uiPort: intEnv(env, 'HEPH_UI_PORT', 8080),
    agentPort: intEnv(env, 'HEPH_AGENT_PORT', 8081),
    host: env.HEPH_HOST ?? '0.0.0.0',
    webDir: env.HEPH_WEB_DIR ?? null,
    migrationsDir:
      env.HEPH_MIGRATIONS_DIR ??
      path.resolve(import.meta.dirname, '../../../packages/core/drizzle'),
    logLevel: env.HEPH_LOG_LEVEL ?? 'info',
  };
}

/**
 * Base URL agents use for the agent port as seen from their machine
 * (`HEPH_PUBLIC_AGENT_URL`, e.g. `http://192.168.1.10:8081`): the server cannot
 * know the host port Docker publishes. Read at call time; null when unset.
 */
export function publicAgentUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.HEPH_PUBLIC_AGENT_URL?.trim().replace(/\/+$/, '');
  return v || null;
}
