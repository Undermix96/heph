import type { Domain, HookFacts } from '@heph/core';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authenticate, refuseCrossOrigin } from '../http/auth.js';
import { type AppEnv, body } from '../http/common.js';

/**
 * Endpoints for the Claude Code plugin hooks (§9, D58), on the agent port
 * (D24). Contract v1, kept in sync with `plugin/scripts/heph-hook.sh`:
 * - POST `/hooks/v1/<event>`: the body is the hook's stdin JSON as Claude
 *   Code wrote it; git facts come as headers (`X-Heph-Remote`,
 *   `X-Heph-Head`, `X-Heph-Worktree`). The response body is printed by the
 *   script as the hook output, so it is exactly what Claude Code expects.
 * - GET / PUT `/hooks/v1/docs?session_id=…`: the docs file to keep in sync.
 *
 * "Do not break": the script never parses JSON and treats every non-2xx
 * response as "no output", so a change here must keep these response shapes.
 */
const SessionInput = z.looseObject({ session_id: z.string().min(1).max(200) });
const StopInput = SessionInput.extend({ stop_hook_active: z.boolean().optional() });
const ToolInput = SessionInput.extend({
  tool_name: z.string().optional(),
  tool_use_id: z.string().max(200).optional(),
  tool_input: z.looseObject({ command: z.string().optional() }).optional(),
});
const EndInput = SessionInput.extend({ reason: z.string().optional() });

/** Shell tools whose commands can run tests (D57: Windows sessions use PowerShell). */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** PostToolUse carries the tool's whole output; generous, but bounded. */
const MAX_HOOK_BODY = 32 * 1024 * 1024;

export function hookRoutes(domain: Domain) {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(domain, { allowCookie: false }));
  r.use('*', refuseCrossOrigin);
  r.use('*', bodyLimit({ maxSize: MAX_HOOK_BODY }));

  r.post('/v1/session-start', async (c) => {
    const input = SessionInput.parse(await body(c));
    const text = domain.hooks.sessionStart(input.session_id, facts(c, input));
    return c.text(text);
  });

  r.post('/v1/stop', async (c) => {
    const input = StopInput.parse(await body(c));
    const block = domain.hooks.stop(
      input.session_id,
      input.stop_hook_active === true,
      facts(c, input),
    );
    return block ? c.json(block) : c.body(null, 204);
  });

  r.post('/v1/pre-tool-use', async (c) => {
    const input = ToolInput.parse(await body(c));
    const command = input.tool_input?.command;
    if (input.tool_name && SHELL_TOOLS.has(input.tool_name) && command) {
      domain.sessions.toolStart(
        input.session_id,
        input.tool_use_id ?? null,
        command,
        facts(c, input),
      );
    }
    return c.body(null, 204);
  });

  r.post('/v1/post-tool-use', async (c) => {
    const input = ToolInput.parse(await body(c));
    domain.sessions.toolEnd(input.session_id, input.tool_use_id ?? null, facts(c, input));
    return c.body(null, 204);
  });

  r.post('/v1/session-end', async (c) => {
    const input = EndInput.parse(await body(c));
    domain.sessions.end(input.session_id, input.reason ?? null);
    return c.body(null, 204);
  });

  // Plain text `<path>\t<hash>\n` (hash empty when nothing is cached), or an
  // empty body when the session has no linked repo with docs.
  r.get('/v1/docs', (c) => {
    const target = domain.hooks.docsTarget(sessionParam(c.req.query('session_id')));
    return c.text(target ? `${target.path}\t${target.hash ?? ''}\n` : '');
  });

  r.put('/v1/docs', async (c) => {
    const sessionId = sessionParam(c.req.query('session_id'));
    const path = z.string().min(1).max(500).parse(c.req.query('path'));
    const changed = domain.hooks.storeDocs(sessionId, path, Buffer.from(await c.req.arrayBuffer()));
    return c.json({ changed });
  });

  return r;
}

function sessionParam(value: string | undefined): string {
  return z.string().min(1).max(200).parse(value);
}

/** Git facts sent by the hook script, plus the cwd from the hook input. */
function facts(c: { req: { header(name: string): string | undefined } }, input: object): HookFacts {
  const header = (name: string) => c.req.header(name)?.trim().slice(0, 500) || null;
  const cwd = 'cwd' in input && typeof input.cwd === 'string' ? input.cwd.slice(0, 1000) : null;
  return {
    remote: header('x-heph-remote'),
    head: header('x-heph-head'),
    worktree: header('x-heph-worktree'),
    cwd,
  };
}
