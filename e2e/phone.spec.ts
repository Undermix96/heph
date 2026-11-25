import { expect, test } from '@playwright/test';

/** Phone layout at 390 px against mockups 60–62 (design §8, invented data). */
const WELDER = 'Saldatrice a punti (dati inventati)';

test('dashboard (60): compact top bar, project rows, filters behind a toggle', async ({ page }) => {
  await page.goto('/');
  const bar = page.locator('header.topbar');
  await expect(bar.getByRole('heading', { name: 'Progetti' })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Cerca' })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Nuovo progetto' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Altre azioni' })).toBeVisible();

  const all = page.locator('section', { has: page.getByRole('heading', { name: 'Tutti' }) });
  await expect(all.getByRole('link', { name: WELDER })).toBeVisible();
  await expect(page.locator('#m-filter')).toHaveCount(0);
  await all.getByRole('button', { name: /Filtri/ }).click();
  await page.locator('#m-filter').fill('banco');
  await expect(all.getByRole('link', { name: WELDER })).toHaveCount(0);
});

test('project (61): back button, compact header, tab counters, vertical path', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: WELDER }).first().click();
  const bar = page.locator('header.topbar');
  await expect(bar.getByRole('heading', { name: WELDER })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Indietro' })).toBeVisible();
  // Edit lives in the ⋯ menu, not in the page header.
  await expect(page.locator('main').getByRole('link', { name: 'Modifica' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Altre azioni' }).click();
  await expect(page.locator('.menu-list').getByRole('button', { name: 'Modifica' })).toBeVisible();
  await page.keyboard.press('Escape');

  const tabs = page.getByRole('navigation', { name: 'Sezioni del progetto' });
  await expect(tabs.getByRole('link', { name: /Roadmap\s*\d+/ })).toBeVisible();
  await expect(tabs.getByRole('link', { name: /Diario\s*\d+/ })).toBeVisible();

  await expect(page.locator('.m-path-item')).toHaveCount(3);
  await expect(page.locator('.m-path-note')).toContainText('sei qui');
  await expect(page.locator('.m-checks input[type="checkbox"]').first()).toBeVisible();
  // Main actions are full width.
  const done = page.getByRole('button', { name: 'Segna fatto' });
  const box = await done.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
});

test('diary (62): source chips and a bottom bar that posts a note', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: WELDER }).first().click();
  await page
    .getByRole('navigation', { name: 'Sezioni del progetto' })
    .getByRole('link', { name: /Diario/ })
    .click();
  const chips = page.getByRole('group', { name: 'Fonte' });
  await expect(chips.getByRole('button', { name: /Claude/ })).toBeVisible();

  const field = page.getByPlaceholder('Scrivi una nota…');
  await expect(field).toBeInViewport();
  const fieldBox = await field.boundingBox();
  expect(fieldBox?.y ?? 0).toBeGreaterThan(844 - 120);
  await field.fill('Nota dal telefono (dati inventati)');
  await page.getByRole('button', { name: 'Invia' }).click();
  await expect(page.getByText('Nota dal telefono (dati inventati)')).toBeVisible();
  await expect(field).toHaveValue('');
});
