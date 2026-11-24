import fs from 'node:fs';
import { Readable } from 'node:stream';
import { type Domain, DomainError, iso } from '@heph/core';
import { FileTarget, ProposalState } from '@heph/schema';
import { type Context, Hono } from 'hono';
import { requireUi } from '../http/auth.js';
import { type AppEnv, body, idParam, queryObject } from '../http/common.js';
import { cleanup, parseMultipart } from '../http/multipart.js';

const MAX_FILES_PER_REQUEST = 20;

/** Image types safe to display inline; everything else downloads as an attachment. */
const INLINE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'application/pdf',
]);

/**
 * REST API (spec §11). Every route is a thin adapter over the domain layer;
 * the caller has already been authenticated and `ctx` says who they are.
 */
export function apiRoutes(domain: Domain) {
  const r = new Hono<AppEnv>();
  const ref = (c: Context) => c.req.param('ref') as string;

  // ------------------------------------------------------------ projects

  r.get('/projects', (c) => c.json(domain.projects.list(queryObject(c))));
  r.post('/projects', async (c) =>
    c.json(domain.projects.create(await body(c), c.get('ctx')), 201),
  );
  r.get('/projects/:ref', (c) => c.json(domain.projects.get(ref(c))));
  r.patch('/projects/:ref', async (c) =>
    c.json(domain.projects.update(ref(c), await body(c), c.get('ctx'))),
  );
  r.delete('/projects/:ref', requireUi, (c) => {
    domain.projects.delete(ref(c), c.get('ctx'));
    return c.body(null, 204);
  });

  /** Lifecycle status. 202 + proposal when the change needs the user's approval. */
  r.post('/projects/:ref/status', async (c) => {
    const input = (await body(c)) as { reason?: string };
    const res = domain.projects.setStatus(ref(c), input, c.get('ctx'), input?.reason);
    return res.applied ? c.json(res.result) : c.json({ proposal: res.proposal }, 202);
  });
  r.post('/projects/:ref/test-outcome', async (c) =>
    c.json(domain.projects.recordTestOutcome(ref(c), await body(c), c.get('ctx'))),
  );
  r.get('/projects/:ref/next-task', (c) =>
    c.json({ nextTask: domain.projects.get(ref(c)).nextTask }),
  );
  r.put('/projects/:ref/next-task', async (c) => {
    const { taskId } = (await body(c)) as { taskId?: unknown };
    if (taskId !== null && (typeof taskId !== 'number' || !Number.isInteger(taskId))) {
      throw new DomainError('validation', 'taskId: expected an integer or null');
    }
    return c.json({ nextTask: domain.roadmap.setNextTask(ref(c), taskId, c.get('ctx')) });
  });

  r.post('/projects/:ref/repos', async (c) =>
    c.json(domain.projects.linkRepo(ref(c), await body(c), c.get('ctx')), 201),
  );
  r.patch('/repos/:id', async (c) =>
    c.json(domain.projects.updateRepo(idParam(c), await body(c), c.get('ctx'))),
  );
  r.delete('/repos/:id', (c) => c.json(domain.projects.unlinkRepo(idParam(c), c.get('ctx'))));

  r.get('/tags', (c) => c.json(domain.projects.allTags()));

  // ------------------------------------------------------------ roadmap

  r.get('/projects/:ref/phases', (c) =>
    c.json(domain.roadmap.phasesOf(domain.projects.row(ref(c)).id)),
  );
  r.post('/projects/:ref/phases', async (c) =>
    c.json(domain.roadmap.addPhase(ref(c), await body(c), c.get('ctx')), 201),
  );
  r.patch('/phases/:id', async (c) =>
    c.json(domain.roadmap.updatePhase(idParam(c), await body(c), c.get('ctx'))),
  );
  r.post('/phases/:id/move', async (c) =>
    c.json(domain.roadmap.movePhase(idParam(c), await body(c), c.get('ctx'))),
  );
  r.delete('/phases/:id', async (c) => {
    const { reason } = (await body(c)) as { reason?: string };
    const proposal = domain.roadmap.deletePhase(idParam(c), c.get('ctx'), reason);
    return proposal ? c.json({ proposal }, 202) : c.body(null, 204);
  });

  r.post('/phases/:id/tasks', async (c) =>
    c.json(domain.roadmap.addTask(idParam(c), await body(c), c.get('ctx')), 201),
  );
  r.get('/tasks/:id', (c) => c.json(domain.roadmap.getTask(idParam(c))));
  r.patch('/tasks/:id', async (c) =>
    c.json(domain.roadmap.updateTask(idParam(c), await body(c), c.get('ctx'))),
  );
  r.post('/tasks/:id/move', async (c) =>
    c.json(domain.roadmap.moveTask(idParam(c), await body(c), c.get('ctx'))),
  );
  r.post('/tasks/:id/complete', (c) =>
    c.json(domain.roadmap.completeTask(idParam(c), c.get('ctx'))),
  );
  r.post('/tasks/:id/reopen', (c) => c.json(domain.roadmap.reopenTask(idParam(c), c.get('ctx'))));
  r.delete('/tasks/:id', async (c) => {
    const { reason } = (await body(c)) as { reason?: string };
    const proposal = domain.roadmap.deleteTask(idParam(c), c.get('ctx'), reason);
    return proposal ? c.json({ proposal }, 202) : c.body(null, 204);
  });

  // ------------------------------------------------------------ diary

  r.get('/diary', (c) => c.json(domain.diary.list(null, queryObject(c))));
  r.get('/diary/sessions/:sessionId', (c) =>
    c.json(domain.diary.bySession(c.req.param('sessionId'))),
  );
  r.get('/diary/:id', (c) => c.json(domain.diary.get(idParam(c))));
  r.get('/projects/:ref/diary', (c) => c.json(domain.diary.list(ref(c), queryObject(c))));
  r.post('/projects/:ref/diary', async (c) =>
    c.json(domain.diary.addNote(ref(c), await body(c), c.get('ctx')), 201),
  );

  // ------------------------------------------------------------ materials

  r.get('/projects/:ref/materials', (c) => c.json(domain.materials.list(ref(c))));
  r.post('/projects/:ref/materials', async (c) =>
    c.json(domain.materials.add(ref(c), await body(c), c.get('ctx')), 201),
  );
  r.patch('/materials/:id', async (c) =>
    c.json(domain.materials.update(idParam(c), await body(c), c.get('ctx'))),
  );
  r.delete('/materials/:id', (c) => {
    domain.materials.delete(idParam(c), c.get('ctx'));
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ files

  r.get('/projects/:ref/files', (c) => {
    const q = c.req.query();
    const target = q.target ? FileTarget.parse(q.target) : undefined;
    return c.json(
      domain.files.list(ref(c), {
        target,
        targetId: q.targetId ? Number(q.targetId) : undefined,
        pinned: q.pinned === undefined ? undefined : q.pinned === 'true',
      }),
    );
  });

  /**
   * Multipart upload: one or more `file` parts, optional `caption`, and at most
   * one of `phaseId` / `taskId` / `diaryEntryId`.
   */
  r.post('/projects/:ref/files', async (c) => {
    const project = domain.projects.writable(ref(c), c.get('ctx'));
    const parsed = await parseMultipart(c.req.raw, {
      maxBytes: domain.files.maxBytes(),
      maxFiles: MAX_FILES_PER_REQUEST,
      tempPath: () => domain.files.tempPath(),
    });
    try {
      const target = targetFromFields(parsed.fields);
      const out = [];
      for (const f of parsed.files) {
        out.push(
          await domain.files.ingest(
            project.id,
            { ...f, caption: parsed.fields.caption ?? null, target },
            c.get('ctx'),
          ),
        );
      }
      return c.json(out, 201);
    } finally {
      cleanup(parsed);
    }
  });

  /** One-time upload URL for agents (`curl -F file=@path <url>`); never base64 in tool args. */
  r.post('/projects/:ref/upload-requests', async (c) => {
    const input = (await body(c)) as { target?: unknown; caption?: string | null };
    const { token, expiresAt } = domain.files.createUploadToken(ref(c), input, c.get('ctx'));
    const path = `/upload/${token}`;
    return c.json(
      { path, url: new URL(path, publicAgentOrigin(c)).toString(), expiresAt: iso(expiresAt) },
      201,
    );
  });

  r.get('/files/:id', (c) => c.json(domain.files.get(idParam(c))));
  r.get('/files/:id/content', (c) =>
    sendFile(c, domain.files.open(idParam(c)), c.req.query('download') !== undefined),
  );
  r.get('/files/:id/thumbnail', (c) => sendFile(c, domain.files.open(idParam(c), true), false));
  r.patch('/files/:id', async (c) =>
    c.json(domain.files.update(idParam(c), await body(c), c.get('ctx'))),
  );
  r.delete('/files/:id', (c) => {
    domain.files.delete(idParam(c), c.get('ctx'));
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ proposals

  r.get('/proposals', (c) => c.json(domain.proposals.list(null, stateParam(c))));
  r.get('/projects/:ref/proposals', (c) => c.json(domain.proposals.list(ref(c), stateParam(c))));
  r.get('/proposals/:id', (c) => c.json(domain.proposals.get(idParam(c))));
  r.post('/proposals/:id/approve', requireUi, async (c) =>
    c.json(domain.proposals.approve(idParam(c), await body(c), c.get('ctx'))),
  );
  r.post('/proposals/:id/reject', requireUi, async (c) =>
    c.json(domain.proposals.reject(idParam(c), await body(c), c.get('ctx'))),
  );

  // ------------------------------------------------------------ attention & search

  /** Open projects in dashboard order (spec §6). */
  r.get('/needs-attention', (c) => c.json(domain.projects.list({})));

  r.get('/search', (c) => {
    const q = queryObject(c);
    const kinds =
      q.kinds === undefined ? undefined : Array.isArray(q.kinds) ? q.kinds : q.kinds.split(',');
    return c.json(domain.search.search({ ...q, kinds }));
  });

  return r;
}

function targetFromFields(fields: Record<string, string>) {
  const out: { phaseId?: number; taskId?: number; diaryEntryId?: number } = {};
  for (const key of ['phaseId', 'taskId', 'diaryEntryId'] as const) {
    const v = fields[key];
    if (v === undefined || v === '') continue;
    if (!/^\d+$/.test(v)) throw new DomainError('validation', `${key}: expected an integer`);
    out[key] = Number(v);
  }
  return out;
}

function stateParam(c: Context) {
  const s = c.req.query('state');
  return s ? ProposalState.parse(s) : undefined;
}

/** Origin agents should use for upload URLs: HEPH_PUBLIC_AGENT_URL, else the request's own origin. */
function publicAgentOrigin(c: Context): string {
  return process.env.HEPH_PUBLIC_AGENT_URL || new URL(c.req.url).origin;
}

function sendFile(
  c: Context,
  f: { path: string; mime: string; name: string; size: number },
  forceDownload: boolean,
) {
  if (!fs.existsSync(f.path)) throw new DomainError('not_found', 'File content is missing on disk');
  const inline = !forceDownload && INLINE_MIME.has(f.mime);
  const encoded = encodeURIComponent(f.name);
  const ascii = f.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  c.header('content-type', f.mime);
  c.header('content-length', String(f.size));
  c.header(
    'content-disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  );
  c.header(
    'content-security-policy',
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
  c.header('x-content-type-options', 'nosniff');
  c.header('cache-control', 'private, max-age=3600');
  return c.body(Readable.toWeb(fs.createReadStream(f.path)) as ReadableStream);
}
