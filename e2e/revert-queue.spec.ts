import fs from 'node:fs';
import { expect, request, test } from '@playwright/test';
import { E2E } from '../playwright.config.js';

/**
 * Revert (D74) and Claude's queue (D76), end to end with invented data. Claude Code
 * is simulated over HTTP: the agent API with a session header and the plugin hooks.
 */
async function agent(sessionId?: string) {
  return request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: {
      authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}`,
      ...(sessionId ? { 'x-heph-session-id': sessionId } : {}),
    },
  });
}

test('a completion by Claude is undone from the Changes tab', async ({ page }) => {
  const api = await agent('e2e-revert');
  const created = await api.post('/api/projects', {
    data: {
      name: 'Mensola a muro (dati inventati)',
      phases: [{ title: 'Montaggio', tasks: ['Forare', 'Fissare'] }],
    },
  });
  const p = (await created.json()) as { slug: string; phases: { tasks: { id: number }[] }[] };
  const drill = p.phases[0]!.tasks[0]!.id;
  expect((await api.post(`/api/tasks/${drill}/complete`)).ok()).toBe(true);

  await page.goto(`/p/${p.slug}/changes`);
  await page.getByRole('button', { name: 'Annulla modifica: Chiuso il task «Forare»' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Annullare questa modifica?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Annulla modifica' }).click();
  await expect(page.getByText('Modifica annullata.')).toBeVisible();
  await expect(page.getByText(/Annullata/).first()).toBeVisible();

  const task = (await (await api.get(`/api/tasks/${drill}`)).json()) as { done: boolean };
  expect(task.done).toBe(false);
  await page.goto(`/p/${p.slug}/diary`);
  await expect(page.getByText('Reverted: Completed task "Forare"')).toBeVisible();
  await api.dispose();
});

test('a deleted task comes back with its file', async ({ page }) => {
  const api = await agent();
  const created = await api.post('/api/projects', {
    data: { name: 'Portapenne (dati inventati)', phases: [{ title: 'Taglio', tasks: ['Tubo'] }] },
  });
  const p = (await created.json()) as {
    id: number;
    slug: string;
    phases: { tasks: { id: number }[] }[];
  };
  const tube = p.phases[0]!.tasks[0]!.id;
  const up = await api.post(`/api/projects/${p.id}/files`, {
    multipart: {
      taskId: String(tube),
      file: {
        name: 'misure.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('30 x 8 cm (inventato)'),
      },
    },
  });
  expect(up.ok()).toBe(true);
  expect((await api.delete(`/api/tasks/${tube}`, { data: { reason: 'prova' } })).status()).toBe(
    202,
  );
  // Without confirmation Claude only proposes: the user deletes from the UI instead.
  await page.goto(`/p/${p.slug}/roadmap`);
  const ui = page.request;
  expect((await ui.delete(`/api/tasks/${tube}`)).status()).toBe(204);

  await page.goto(`/p/${p.slug}/changes`);
  await page.getByRole('button', { name: 'Annulla modifica: Eliminato il task «Tubo»' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Annulla modifica' }).click();
  await expect(page.getByText('Modifica annullata.')).toBeVisible();
  const files = (await (await api.get(`/api/projects/${p.id}/files`)).json()) as {
    taskId: number | null;
  }[];
  expect(files.map((f) => f.taskId)).toEqual([tube]);
  await api.dispose();
});

test("Claude's queue shows a running session, then the ended one", async ({ page }) => {
  const api = await agent();
  const SESSION = 'e2e-queue-session';
  const GIT = { 'x-heph-remote': 'git@github.com:example-e2e/orologio.git' };
  const created = await api.post('/api/projects', {
    data: { name: 'Orologio a pendolo (dati inventati)', repos: ['example-e2e/orologio'] },
  });
  const p = (await created.json()) as { id: number };
  const hook = (event: string, data: Record<string, unknown> = {}) =>
    api.post(`/hooks/v1/${event}`, { data: { session_id: SESSION, ...data }, headers: GIT });
  await hook('session-start', { source: 'startup', cwd: 'D:Gitorologio' });
  await api.post(`/api/projects/${p.id}/diary`, {
    data: { body: '## Regolato il pendolo\nDettagli.' },
    headers: { 'x-heph-session-id': SESSION },
  });

  await page.goto('/');
  const queue = page.getByRole('complementary', { name: 'Coda di Claude' });
  const row = queue.getByRole('listitem').filter({ hasText: 'Orologio a pendolo' });
  await expect(row.getByText('al lavoro')).toBeVisible();
  await expect(row.getByText('Regolato il pendolo')).toBeVisible();
  await page.screenshot({ path: '.e2e-data/screens/desktop/05-claude-queue.png' });

  await hook('session-end', { reason: 'prompt_input_exit' });
  await expect(row.getByText(/finita/)).toBeVisible({ timeout: 15_000 });

  // Collapsing is remembered across reloads.
  await queue.getByRole('button', { name: 'Riduci la coda di Claude' }).click();
  await page.reload();
  await expect(
    page.getByRole('complementary', { name: 'Coda di Claude' }).getByRole('button', {
      name: 'Apri la coda di Claude',
    }),
  ).toBeVisible();
  await api.dispose();
});
