import { schema } from '@heph/core';
import { makeApps } from './app.js';

/** A logged-in UI client and the API token over a fresh in-memory domain. */
export async function startApi() {
  const t = makeApps();
  const token = await t.setup();
  /** Bearer request on the agent port (or the UI port with app = 'ui'). */
  const agentReq = (
    method: string,
    path: string,
    opts: Parameters<typeof t.tokenReq>[3] = {},
    app: 'ui' | 'agent' = 'agent',
  ) => t.tokenReq(token, method, path, opts, app);

  /** Creates a project from the UI and returns the project detail. */
  // biome-ignore lint/suspicious/noExplicitAny: test convenience
  const createProject = async (input: Record<string, unknown>): Promise<any> => {
    const r = await t.uiReq('POST', '/api/projects', { json: input });
    if (r.status !== 201) throw new Error(`create failed: ${JSON.stringify(r.data)}`);
    return r.data;
  };

  /** A project with two phases of two tasks each. */
  const seed = (overrides: Record<string, unknown> = {}) =>
    createProject({
      name: 'Spot Welder',
      phases: [
        { title: 'Design', tasks: ['Schematic', 'BOM'] },
        { title: 'Build', tasks: ['Case', 'Wiring'] },
      ],
      ...overrides,
    });

  /** Inserts a live Claude Code session row (hooks are not wired yet). */
  const insertLiveSession = (projectId: number, sessionId: string, isTesting = false) => {
    const now = t.clock.now;
    t.d.db
      .insert(schema.claudeSessions)
      .values({
        sessionId,
        projectId,
        startedAt: now,
        lastHeartbeatAt: now,
        isTesting,
        testingSince: isTesting ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  };

  return { ...t, token, agentReq, createProject, seed, insertLiveSession };
}

export type Api = Awaited<ReturnType<typeof startApi>>;

export interface FilePart {
  name: string;
  data: Uint8Array | string;
  type?: string;
}

/** Builds a multipart body with `file` parts and extra text fields. */
export function multipart(files: FilePart[], fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) {
    const bytes = typeof f.data === 'string' ? f.data : new Uint8Array(f.data);
    form.append('file', new Blob([bytes], { type: f.type ?? 'application/octet-stream' }), f.name);
  }
  return form;
}
