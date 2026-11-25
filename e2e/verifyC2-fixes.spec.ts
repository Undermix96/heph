import fs from 'node:fs';
import {
  type APIRequestContext,
  devices,
  expect,
  type Page,
  request,
  test,
} from '@playwright/test';
import { E2E } from '../playwright.config.js';

/**
 * Independent verification round 2, phase 4 group C fixes. Uses its own invented project
 * (60 diary notes, more than one page) so it does not depend on other specs or on order.
 */
const NAME = 'Verifica C2: banco da lavoro (dati inventati)';

async function agent(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: {
      authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}`,
      'x-heph-session-id': 'verify-c2',
    },
  });
}

async function ensureProject(): Promise<{ id: number; slug: string }> {
  const api = await agent();
  const list = (await (await api.get('/api/projects')).json()) as {
    id: number;
    slug: string;
    name: string;
  }[];
  const found = list.find((p) => p.name === NAME);
  if (found) return found;
  const res = await api.post('/api/projects', {
    data: { name: NAME, phases: [{ title: 'Prova', tasks: ['Uno'] }] },
  });
  const p = (await res.json()) as { id: number; slug: string };
  for (let i = 0; i < 60; i++) {
    const r = await api.post(`/api/projects/${p.id}/diary`, {
      data: { body: `Nota C2 numero ${i}\n\nSeconda riga` },
    });
    expect(r.ok(), await r.text()).toBe(true);
  }
  return p;
}

/** True when the centre of the element is not covered by another element. */
async function uncovered(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (el === top || el.contains(top));
  }, selector);
}

const { defaultBrowserType: _b, ...PIXEL } = devices['Pixel 7'];

for (const height of [844, 500]) {
  test.describe(`verifyC2 phone 390x${height}`, () => {
    test.use({ ...PIXEL, viewport: { width: 390, height } });

    test('composer fixed at the bottom; last entry and Load earlier days not covered', async ({
      page,
    }) => {
      const p = await ensureProject();
      await page.goto(`/p/${p.slug}/diary`);
      await expect(page.getByText('Nota C2 numero 59')).toBeVisible();
      const composer = page.locator('.composer');
      expect(await composer.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
      const check = async (what: string) => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const box = await composer.boundingBox();
        expect(box!.y + box!.height, what).toBeLessThanOrEqual(height + 1);
        expect(await uncovered(page, '.timeline > li:last-child .entry:last-child'), what).toBe(
          true,
        );
        const more = page.getByRole('button', { name: 'Carica i giorni precedenti' });
        await expect(more).toBeVisible();
        const moreUncovered = await more.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!top && (el === top || el.contains(top));
        });
        expect(
          moreUncovered,
          `Load earlier days, ${what}, composer ${Math.round(box!.height)} px`,
        ).toBe(true);
      };
      await check('empty composer');
      // Writing a longer note (several short paragraphs) is normal use on the phone.
      await composer.locator('textarea').fill('Riga\n'.repeat(8));
      await check('composer with an 8-line note');
    });
  });
}

test.describe('verifyC2 phone touch targets', () => {
  test.use({ ...PIXEL, viewport: { width: 390, height: 844 } });

  test('diary, search and settings controls are at least 44 px high (D56)', async ({ page }) => {
    const p = await ensureProject();
    const small: string[] = [];
    for (const path of [`/p/${p.slug}/diary`, `/search?q=C2`, '/settings', `/p/${p.slug}`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const found = await page.evaluate(() => {
        const sel =
          'button, a.btn, a.icon-btn, a.tag, .tabs a, .topbar a, summary, [role=button], [role=tab], select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, label.check';
        return [...document.querySelectorAll<HTMLElement>(sel)]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.height < 43.5;
          })
          .map(
            (el) =>
              `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`,
          );
      });
      for (const f of new Set(found)) small.push(`${path}: ${f}`);
    }
    expect(small).toEqual([]);
  });
});

for (const vp of [
  { width: 800, height: 1000 },
  { width: 1440, height: 900 },
]) {
  test.describe(`verifyC2 ${vp.width} px`, () => {
    test.use({ viewport: vp });
    test('the diary composer is not fixed', async ({ page }) => {
      const p = await ensureProject();
      await page.goto(`/p/${p.slug}/diary`);
      await expect(page.getByText('Nota C2 numero 59')).toBeVisible();
      expect(
        await page.locator('.composer').evaluate((el) => getComputedStyle(el).position),
      ).not.toBe('fixed');
    });
  });
}

test.describe('verifyC2 desktop', () => {
  test.use({ viewport: { width: 1440, height: 600 } });

  test('a settings link with a hash scrolls to its section', async ({ page }) => {
    await page.goto('/settings#s-claude');
    const sec = page.locator('#s-claude');
    await expect(sec).toBeVisible();
    // At the section, or at the end of the page when it is the last one.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.getElementById('s-claude')!.getBoundingClientRect().top < 200 ||
            window.scrollY >= document.documentElement.scrollHeight - innerHeight - 1,
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('proxy 502 HTML shows the notice, JSON 503 does not, and the notice clears', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    await page.route(/\/api\/projects(\?|$)/, (r) =>
      r.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html>502 (invented)</html>',
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.offline[role=alert]')).toBeVisible({
      timeout: 25_000,
    });
    await page.unroute(/\/api\/projects(\?|$)/);
    await expect(page.locator('.offline')).toHaveCount(0, { timeout: 25_000 });

    await page.route('**/api/settings', (r) =>
      r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'unavailable', message: 'invented' },
        }),
      }),
    );
    await page.goto('/settings');
    await expect(page.locator('.offline')).toHaveCount(0);
  });

  test('chunk failure: error in layout, other pages work, Retry reloads', async ({ page }) => {
    const p = await ensureProject();
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    await page.route('**/assets/SettingsPage-*.js', (r) => r.abort('connectionrefused'));
    await page.getByRole('link', { name: 'Impostazioni' }).click();
    const retry = page.getByRole('button', { name: 'Riprova' });
    await expect(retry).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
    // Other pages still work from the error state (in-app navigation, no reload).
    await page.locator('.topbar a').first().click();
    await expect(page.locator('.tile-name').first()).toBeVisible();
    await page.getByRole('link', { name: NAME }).first().click();
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
    expect(p.slug).toBeTruthy();
    await page.getByRole('link', { name: 'Impostazioni' }).click();
    await expect(retry).toBeVisible();
    await page.unroute('**/assets/SettingsPage-*.js');
    await retry.click();
    await expect(page.getByLabel('Attivo di recente (giorni)')).toBeVisible();
  });
});
