import fs from 'node:fs';
import { expect, request, test } from '@playwright/test';
import { E2E } from '../playwright.config.js';

/**
 * Phase 5: what the Claude Code plugin hooks show in the UI. The hooks are
 * simulated over HTTP exactly as plugin/scripts/heph-hook.sh sends them
 * (invented data; the script itself is tested in apps/server).
 */
const LAMP = 'Lampada da scrivania (dati inventati)';
const SESSION = 'e2e-plugin-session';
const GIT = {
  'x-heph-remote': 'git@github.com:example-e2e/lampada.git',
  'x-heph-head': 'a'.repeat(40),
  'x-heph-worktree': 'b'.repeat(40),
};

async function agent() {
  return request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: { authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}` },
  });
}

test('a Claude session from the plugin shows live, testing, in the diary, then ends', async ({
  page,
}) => {
  const api = await agent();
  const created = await api.post('/api/projects', {
    data: {
      name: LAMP,
      repos: ['example-e2e/lampada'],
      phases: [{ title: 'Ottica', tasks: ['Lente'] }],
    },
  });
  expect(created.ok()).toBe(true);
  const hook = (event: string, data: Record<string, unknown>) =>
    api.post(`/hooks/v1/${event}`, { data: { session_id: SESSION, ...data }, headers: GIT });

  const start = await hook('session-start', { source: 'startup', cwd: 'D:\\Git\\lampada' });
  expect(await start.text()).toContain(`# Briefing: ${LAMP}`);

  await page.goto('/');
  const tile = page.locator('.tile', { hasText: LAMP });
  await expect(tile.getByText('Claude al lavoro')).toBeVisible();

  await hook('pre-tool-use', {
    tool_name: 'PowerShell',
    tool_use_id: 'tu-e2e-1',
    tool_input: { command: 'npm test' },
  });
  await expect(tile.getByText('Claude esegue test')).toBeVisible({ timeout: 15_000 });
  await hook('post-tool-use', {
    tool_name: 'PowerShell',
    tool_use_id: 'tu-e2e-1',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'ok', stderr: '', interrupted: false },
  });
  await expect(tile.getByText('Claude al lavoro')).toBeVisible({ timeout: 15_000 });

  // Two log_progress from the session: the diary groups them in a live session block.
  const project = (await created.json()) as { id: number; slug: string };
  for (const body of ['Montata la lente.', 'Regolato il fuoco.']) {
    await api.post(`/api/projects/${project.id}/diary`, {
      data: { body },
      headers: { 'x-heph-session-id': SESSION },
    });
  }
  await page.goto(`/p/${project.slug}/diary`);
  const block = page.locator('.box-ai', { hasText: 'Sessione di Claude' }).first();
  await expect(block.getByText('in corso')).toBeVisible();

  await page.goto(`/p/${project.slug}`);
  await expect(page.getByText(/Claude sta lavorando/)).toBeVisible();

  await hook('session-end', { reason: 'prompt_input_exit' });
  await page.goto('/');
  await expect(tile).toBeVisible();
  await expect(tile.getByText('Claude al lavoro')).toHaveCount(0);
  await api.dispose();
});

test('Connect Claude Code shows the plugin steps and a recent call', async ({ page }) => {
  await page.goto('/settings#s-claude');
  const box = page.locator('#s-claude');
  await expect(box.getByText('claude plugin marketplace add Undermix96/heph')).toBeVisible();
  await expect(box.getByText('claude plugin install heph@heph --scope user')).toBeVisible();
  // The e2e server has no HEPH_PUBLIC_AGENT_URL: the page says how to set it.
  await expect(box.getByText(/TBD: imposta HEPH_PUBLIC_AGENT_URL/)).toBeVisible();
  // Global setup and the previous test called with the token.
  await expect(box.getByText(/collegato · ultima chiamata/)).toBeVisible();
});

test('test patterns: add one, save, and it is used for recognition', async ({ page }) => {
  await page.goto('/settings#s-tests');
  await page.getByLabel('Nuovo schema').fill('make check');
  await page.getByLabel('Nuovo schema').press('Enter');
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByText('Salvato.')).toBeVisible();
  await page.reload();
  await expect(page.locator('#s-tests').getByText('make check', { exact: true })).toBeVisible();
});
