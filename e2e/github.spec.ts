import fs from 'node:fs';
import { expect, request, test } from '@playwright/test';
import { E2E } from '../playwright.config.js';

/**
 * Phase 6: GitHub sync end to end against the local fake GitHub started by
 * playwright.config.ts (invented repo example-e2e/stazione-meteo).
 */
const NAME = 'Stazione meteo (dati inventati)';

test('token, verify, Sync now: docs and commits from GitHub', async ({ page }) => {
  // Settings: save the token, then Verify.
  await page.goto('/settings#s-github');
  await page.getByLabel('Nuovo token GitHub').fill(E2E.githubToken);
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByText('Salvato.')).toBeVisible();
  await page.getByRole('button', { name: 'Verifica' }).click();
  await expect(
    page.getByText(/Valido · invented-user · accesso in lettura a 1 repository/),
  ).toBeVisible();

  // A project linked to the repo, created as Claude Code would.
  const api = await request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: { authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}` },
  });
  const created = await api.post('/api/projects', {
    data: {
      name: NAME,
      repos: [{ fullName: 'example-e2e/stazione-meteo', docsPath: 'docs/DECISIONI.md' }],
    },
  });
  expect(created.ok()).toBe(true);
  const p = (await created.json()) as { slug: string };
  await api.dispose();

  // Documentation: Sync now brings the pushed file and its last change.
  await page.goto(`/p/${p.slug}/docs`);
  await page.getByRole('button', { name: 'Sincronizza ora' }).click();
  await expect(page.getByRole('heading', { name: 'D1 — Sonno profondo' })).toBeVisible();
  await expect(page.getByText(/Da GitHub, sincronizzata/)).toBeVisible();
  await expect(page.getByText(/Ultima modifica: Invented Dev · commit 9c01e7b/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Apri su GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/example-e2e/stazione-meteo/blob/main/docs/DECISIONI.md',
  );

  // Diary: one box per day of commits, and the release.
  await page.goto(`/p/${p.slug}/diary`);
  await expect(page.getByText('2 commit su main')).toBeVisible();
  await expect(page.getByText('fix(sleep): keep RTC memory across wake')).toBeVisible();
  await expect(page.getByRole('link', { name: '9c01e7b' })).toBeVisible();
  await expect(page.getByText('Release v0.2.0: Primo inverno')).toBeVisible();
  await page.screenshot({ path: '.e2e-data/screens/desktop/github-diary.png', fullPage: true });
});
