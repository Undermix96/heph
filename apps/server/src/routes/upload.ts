import type { Domain } from '@heph/core';
import { Hono } from 'hono';
import type { AppEnv } from '../http/common.js';
import { cleanup, parseMultipart } from '../http/multipart.js';

/**
 * One-time agent uploads on the LAN port: `curl -F file=@shot.png <url>`.
 * The token in the URL is the credential; it works once and expires.
 */
export function uploadRoutes(domain: Domain) {
  const r = new Hono<AppEnv>();
  r.post('/:token', async (c) => {
    const grant = domain.files.consumeUploadToken(c.req.param('token'));
    const parsed = await parseMultipart(c.req.raw, {
      maxBytes: domain.files.maxBytes(),
      maxFiles: 1,
      tempPath: () => domain.files.tempPath(),
    });
    try {
      const [file] = parsed.files;
      if (!file) return c.json({ error: { code: 'validation', message: 'No file' } }, 400);
      const view = await domain.files.ingest(
        grant.projectId,
        { ...file, caption: parsed.fields.caption ?? grant.caption, target: grant.target },
        grant.ctx,
      );
      return c.json(view, 201);
    } finally {
      cleanup(parsed);
    }
  });
  return r;
}
