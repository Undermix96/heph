import fs from 'node:fs';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { E2E } from '../playwright.config.js';

/**
 * Independent verification of the phone layout (mockups 60-62, design §8) at 390 px.
 * Uses its own invented projects so it does not change the data other specs rely on.
 */
const LONG =
  'Verifica D: stazione di saldatura con controllo di temperatura e pedale (dati inventati)';
const EMPTY = 'Verifica D: senza fasi (dati inventati)';

async function agent(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: {
      authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}`,
      'x-heph-session-id': 'verify-d',
    },
  });
}

async function ensure(name: string, data: Record<string, unknown>, notes = 0) {
  const api = await agent();
  const list = (await (await api.get('/api/projects?includeClosed=true')).json()) as {
    id: number;
    slug: string;
    name: string;
  }[];
  const found = list.find((p) => p.name === name);
  if (found) return found;
  const res = await api.post('/api/projects', { data: { name, ...data } });
  expect(res.ok(), await res.text()).toBe(true);
  const p = (await res.json()) as { id: number; slug: string };
  for (let i = 0; i < notes; i++) {
    await api.post(`/api/projects/${p.id}/diary`, { data: { body: `Nota D ${i}` } });
  }
  return p;
}
const longProject = () =>
  ensure(
    LONG,
    {
      description: 'Descrizione con **grassetto** e un elenco:\n\n- uno\n- due',
      phases: [
        { title: 'Progetto elettrico molto lungo da leggere sul telefono', tasks: ['Uno', 'Due'] },
        { title: 'Costruzione', tasks: ['Tre'] },
      ],
    },
    15,
  );

async function noHorizontalScroll(page: Page) {
  const r = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(r.sw, `scrollWidth ${r.sw} > clientWidth ${r.cw}`).toBeLessThanOrEqual(r.cw);
}

/** Visible interactive elements shorter than 44 px (D56). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      'header.topbar a, header.topbar button, main a.btn, main button, main input:not([type=checkbox]):not([type=file]), main select, main textarea, main label.check, .composer button, .composer textarea, nav.tabs a',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || el.closest('.sr-only')) continue;
      if (r.height < 43.5) {
        out.push(
          `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }
    return out;
  });
}

test.describe('verifyD phone', () => {
  test('no horizontal scroll and 44 px targets on the main phone pages', async ({ page }) => {
    const p = await longProject();
    const report: Record<string, string[]> = {};
    for (const path of [
      '/',
      '/tests',
      '/proposals',
      `/p/${p.slug}`,
      `/p/${p.slug}/diary`,
      `/p/${p.slug}/roadmap`,
      '/search',
      '/settings',
    ]) {
      await page.goto(path);
      await page.locator('header.topbar').waitFor();
      await page.waitForLoadState('networkidle');
      await noHorizontalScroll(page);
      const small = await smallTargets(page);
      if (small.length) report[path] = small;
    }
    expect(report).toEqual({});
  });

  test('a long project name is truncated in the top bar and the actions stay on screen', async ({
    page,
  }) => {
    const p = await longProject();
    await page.goto(`/p/${p.slug}`);
    const bar = page.locator('header.topbar');
    const title = bar.getByRole('heading', { name: LONG });
    await expect(title).toBeVisible();
    const t = await title.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(t.sw).toBeGreaterThan(t.cw);
    for (const name of ['Cerca', 'Altre azioni', 'Indietro']) {
      await expect(
        bar.getByRole(name === 'Altre azioni' ? 'button' : 'link', { name }),
      ).toBeInViewport();
    }
    await noHorizontalScroll(page);
  });

  test('the last diary entry is not hidden behind the bottom bar, even with a tall field', async ({
    page,
  }) => {
    const p = await longProject();
    await page.goto(`/p/${p.slug}/diary`);
    const field = page.getByPlaceholder('Scrivi una nota…');
    await expect(field).toBeVisible();
    await field.fill('riga\nriga\nriga\nriga\nriga');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const view = document.querySelector('.diary-view') as HTMLElement;
      const items = Array.from(view.children).filter((c) => !c.classList.contains('composer'));
      const last = items[items.length - 1] as HTMLElement | undefined;
      const bar = document.querySelector('.composer') as HTMLElement;
      return {
        lastBottom: last?.getBoundingClientRect().bottom ?? 0,
        barTop: bar.getBoundingClientRect().top,
        n: items.length,
      };
    });
    expect(r.n).toBeGreaterThan(0);
    expect(r.lastBottom).toBeLessThanOrEqual(r.barTop + 1);
  });

  test('the bottom bar field grows with text and shrinks back to one line after Invia', async ({
    page,
  }) => {
    const p = await longProject();
    await page.goto(`/p/${p.slug}/diary`);
    const field = page.getByPlaceholder('Scrivi una nota…');
    const h0 = (await field.boundingBox())?.height ?? 0;
    await field.pressSequentially('Prima riga del collaudo');
    for (let i = 0; i < 3; i++) {
      await field.press('Shift+Enter');
      await field.pressSequentially(`riga ${i}`);
    }
    const h1 = (await field.boundingBox())?.height ?? 0;
    expect(h1).toBeGreaterThan(h0 + 10);
    await page.getByRole('button', { name: 'Invia' }).click();
    await expect(field).toHaveValue('');
    const h2 = (await field.boundingBox())?.height ?? 0;
    expect(h2).toBeLessThanOrEqual(h0 + 2);
  });

  test('a project with no phases shows its overview on the phone without errors', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const p = await ensure(EMPTY, {});
    await page.goto(`/p/${p.slug}`);
    await expect(page.locator('header.topbar').getByRole('heading', { name: EMPTY })).toBeVisible();
    await expect(page.locator('.m-project-head')).toContainText('0/0 · 0%');
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });

  test('at 600 px the desktop layout comes back; description is Markdown', async ({ page }) => {
    const p = await longProject();
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto(`/p/${p.slug}`);
    await expect(page.locator('header.topbar-phone')).toHaveCount(0);
    await expect(page.locator('.project-desc strong')).toHaveText('grassetto');
    await expect(page.locator('.m-path-item')).toHaveCount(0);
    await page.setViewportSize({ width: 599, height: 900 });
    await expect(page.locator('header.topbar-phone')).toHaveCount(1);
    await expect(page.locator('.m-path-item')).toHaveCount(2);
  });

  test('desktop search page is unchanged at 1440 px (no extra search form)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/search?q=schema');
    await expect(page.locator('main h1.page-title')).toBeVisible();
    // Hidden by CSS at 600 px and above: desktop searches from the top bar.
    await expect(page.locator('main .search-form')).toBeHidden();
  });
});
