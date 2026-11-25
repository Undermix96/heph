import fs from 'node:fs';
import { expect, type Page, request, test } from '@playwright/test';
import { E2E } from '../playwright.config.js';

/** Main workflows end to end against the real server (invented data). */
const WELDER = 'Saldatrice a punti (dati inventati)';

async function agent() {
  return request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: {
      authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}`,
      'x-heph-session-id': 'e2e-session',
    },
  });
}

async function openProject(page: Page, tab = '') {
  await page.goto('/');
  await page.getByRole('link', { name: WELDER }).first().click();
  if (tab) {
    await page
      .getByRole('navigation', { name: 'Sezioni del progetto' })
      // Tabs carry counters ("Roadmap 4").
      .getByRole('link', { name: new RegExp(`^${tab}(\\s|$)`) })
      .click();
  }
}

test('dashboard shows the seeded projects in attention order', async ({ page }) => {
  await page.goto('/');
  const names = page.locator('.tile-name');
  await expect(names).toHaveText(['Banco da lavoro', WELDER]);
  await expect(page.getByText('da testare')).toBeVisible();
});

test('create a project from the UI and see it through the API', async ({ page }) => {
  await page.goto('/new');
  await page.getByLabel('Nome', { exact: true }).fill('Mensola (dati inventati)');
  await page.getByRole('button', { name: 'Crea progetto' }).click();
  await expect(page.getByRole('heading', { name: 'Mensola (dati inventati)' })).toBeVisible();
  const api = await agent();
  const list = (await (await api.get('/api/projects')).json()) as { name: string }[];
  expect(list.map((p) => p.name)).toContain('Mensola (dati inventati)');
});

test('roadmap: keyboard move persists and a change via the API appears without reload', async ({
  page,
}) => {
  await openProject(page, 'Roadmap');
  const grip = page.getByRole('button', { name: 'Sposta il task Schema' });
  await grip.focus();
  // dnd-kit measures between key presses, like a person typing.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  const titles = page.locator('.phase').first().locator('.task-title');
  await expect(titles).toHaveText(['Distinta materiali', 'Schema', 'Simulazione']);

  const api = await agent();
  const project = (await (await api.get('/api/projects')).json()).find(
    (p: { name: string }) => p.name === WELDER,
  );
  const detail = await (await api.get(`/api/projects/${project.id}`)).json();
  expect(detail.phases[0].tasks.map((t: { title: string }) => t.title)).toEqual([
    'Distinta materiali',
    'Schema',
    'Simulazione',
  ]);
  const phaseId = detail.phases[0].id;
  await api.post(`/api/phases/${phaseId}/tasks`, { data: { title: 'Aggiunto da Claude' } });
  await expect(page.getByText('Aggiunto da Claude')).toBeVisible({ timeout: 15_000 });
});

test('the project description is rendered as Markdown, not raw', async ({ page }) => {
  await openProject(page);
  await expect(page.locator('.project-head strong', { hasText: 'dati inventati' })).toBeVisible();
  await expect(page.getByText('**dati inventati**')).toHaveCount(0);
});

test('mark done shows the next step computed by the server', async ({ page }) => {
  await openProject(page);
  const next = page.locator('.next-title');
  const before = await next.textContent();
  await page.getByRole('button', { name: 'Segna fatto' }).click();
  await expect(next).not.toHaveText(before ?? '');
});

test('a failed manual test brings the project back to development', async ({ page }) => {
  await page.goto('/tests');
  await page.getByLabel('Esito').fill('Il piano non è in bolla.');
  await page.getByRole('button', { name: 'Fallito' }).click();
  await expect(page.getByText('Nessun test in attesa')).toBeVisible();
  await expect(page.getByText('Fallito').first()).toBeVisible();
});

test('diary note with an image keeps the thumbnail', async ({ page }) => {
  await openProject(page, 'Diario');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('foto.png')).toBeVisible();
  await page.getByPlaceholder('Scrivi una nota').fill('Nota con foto, più è già.');
  await page.getByRole('button', { name: 'Pubblica' }).click();
  await expect(page.getByText('Nota con foto, più è già.')).toBeVisible();
  await expect(page.locator('.thumbs img').first()).toBeVisible();
});

test('a proposal from Claude is approved and applied', async ({ page }) => {
  const api = await agent();
  const project = (await (await api.get('/api/projects')).json()).find(
    (p: { name: string }) => p.name === WELDER,
  );
  const detail = await (await api.get(`/api/projects/${project.id}`)).json();
  const task = detail.phases[1].tasks[0];
  const res = await api.delete(`/api/tasks/${task.id}`, { data: { reason: 'Non serve più.' } });
  expect(res.status()).toBe(202);
  await page.goto('/proposals');
  await expect(page.getByText(`- #${task.id} ${task.title}`)).toBeVisible();
  const box = page.locator('section.box', { hasText: `#${task.id} ${task.title}` });
  await box.getByRole('button', { name: 'Approva' }).click();
  await expect(page.getByText('Proposta approvata')).toBeVisible();
  expect((await api.get(`/api/tasks/${task.id}`)).status()).toBe(404);
});

test('search finds a task and a diary note', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cerca').fill('schema');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Task e fasi' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Diario' })).toBeVisible();
});

test('settings save the thresholds', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Attivo di recente (giorni)').fill('5');
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByText('Salvato.')).toBeVisible();
});

test('export downloads a zip and a Markdown file', async ({ page }) => {
  await openProject(page);
  await page.getByRole('link', { name: 'Modifica' }).click();
  const zip = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Scarica .zip' }).click();
  expect((await zip).suggestedFilename()).toMatch(/\.zip$/);
  const md = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Scarica .md' }).click();
  expect((await md).suggestedFilename()).toMatch(/\.md$/);
});
