import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  type APIRequestContext,
  devices,
  expect,
  type Page,
  request,
  test,
} from '@playwright/test';
import { E2E } from '../playwright.config.js';
import { PAGES } from './pages.js';

/**
 * Independent verification, phase 4 group C. Uses its own invented project so it does
 * not depend on the data the other specs change.
 */
const NAME = 'Verifica C: lampada (dati inventati)';

async function agent(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: `http://localhost:${E2E.agentPort}`,
    extraHTTPHeaders: {
      authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}`,
      'x-heph-session-id': 'verify-c',
    },
  });
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Creates (once) the verification project with 40 diary notes and an image. */
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
    data: { name: NAME, phases: [{ title: 'Prova', tasks: ['Uno', 'Due'] }] },
  });
  const p = (await res.json()) as { id: number; slug: string };
  for (let i = 0; i < 40; i++) {
    await api.post(`/api/projects/${p.id}/diary`, { data: { body: `Nota di prova ${i}` } });
  }
  const up = await api.post(`/api/projects/${p.id}/files`, {
    multipart: { files: { name: 'lampada.png', mimeType: 'image/png', buffer: PNG } },
  });
  expect(up.ok(), await up.text()).toBe(true);
  return p;
}

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3)}`);
}

const { defaultBrowserType: _b, ...PIXEL } = devices['Pixel 7'];
const PHONE = { ...PIXEL, viewport: { width: 390, height: 844 } };

test.describe('verifyC phone', () => {
  test.use(PHONE);

  // Bug: .composer is sticky with bottom: 0 but sits at the top of the diary, so it
  // scrolls away upward; on a long diary it is not reachable at the bottom (design §8).
  test('diary composer stays reachable at the bottom while scrolling a long diary', async ({
    page,
  }) => {
    const p = await ensureProject();
    // Notes written in the UI (no Claude session), so they are not grouped into one block.
    for (let i = 0; i < 30; i++) {
      const r = await page.request.post(`/api/projects/${p.id}/diary`, {
        data: { body: `Nota dal telefono ${i}\n\nRiga due\n\nRiga tre` },
      });
      expect(r.status(), await r.text()).toBe(201);
    }
    await page.goto(`/p/${p.slug}/diary`);
    await expect(page.getByText('Nota dal telefono 29')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => window.scrollY > 1000);
    const box = await page.locator('.composer').boundingBox();
    expect(box).not.toBeNull();
    const vh = page.viewportSize()?.height ?? 844;
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
  });

  test('interactive controls are at least 44 px high on every screen (D56)', async ({ page }) => {
    await ensureProject();
    const small: string[] = [];
    for (const s of PAGES) {
      await page.goto(s.path);
      await page.waitForLoadState('networkidle');
      const found = await page.evaluate(() => {
        const sel =
          'button, a.btn, a.icon-btn, .tabs a, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, label.check';
        return [...document.querySelectorAll<HTMLElement>(sel)]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && r.height < 43.5;
          })
          .map(
            (el) =>
              `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`,
          );
      });
      for (const f of new Set(found)) small.push(`${s.name}: ${f}`);
    }
    expect(small).toEqual([]);
  });

  test('dashboard filters sit behind a Filtri toggle that works by keyboard', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /Filtri/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.filters-body')).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.filters-body')).toBeVisible();
  });

  test('the project list is reachable from a project page (logo or back)', async ({ page }) => {
    const p = await ensureProject();
    await page.goto(`/p/${p.slug}`);
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
    await page.locator('.topbar a').first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: NAME }).first()).toBeVisible();
  });

  test('axe with menus, dialogs and the viewer open', async ({ page }) => {
    const p = await ensureProject();
    const bad: string[] = [];
    await page.goto(`/p/${p.slug}`);
    await page.getByRole('button', { name: 'Stato' }).click();
    bad.push(...(await axe(page)).map((v) => `status menu: ${v}`));
    await page.getByRole('button', { name: 'In pausa' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    bad.push(...(await axe(page)).map((v) => `status dialog: ${v}`));
    await page.keyboard.press('Escape');
    await page.goto(`/p/${p.slug}/files`);
    await page.locator('.file-card').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    bad.push(...(await axe(page)).map((v) => `viewer: ${v}`));
    expect(bad).toEqual([]);
  });
});

test.describe('verifyC desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('axe with the roadmap task menu, the status dialog and the viewer open', async ({
    page,
  }) => {
    const p = await ensureProject();
    const bad: string[] = [];
    await page.goto(`/p/${p.slug}/roadmap`);
    await page.locator('.task .menu > button').first().click();
    await expect(page.locator('.menu-list').first()).toBeVisible();
    bad.push(...(await axe(page)).map((v) => `task menu: ${v}`));
    await page.goto(`/p/${p.slug}`);
    await page.getByRole('button', { name: 'Stato' }).click();
    await page.getByRole('button', { name: 'In pausa' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    bad.push(...(await axe(page)).map((v) => `status dialog: ${v}`));
    await page.goto(`/p/${p.slug}/files`);
    await page.locator('.file-card').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    bad.push(...(await axe(page)).map((v) => `viewer: ${v}`));
    expect(bad).toEqual([]);
  });

  test('page-wide notice while the server does not answer, cleared by the next poll', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.tile-name').first()).toBeVisible();
    await page.route('**/api/**', (r) => r.abort('connectionrefused'));
    await expect(page.locator('.offline[role=alert]')).toBeVisible({ timeout: 25_000 });
    await page.unroute('**/api/**');
    await expect(page.locator('.offline')).toHaveCount(0, { timeout: 25_000 });
  });

  // Bug (normal use: the image is updated while a tab stays open, D44 "never fail
  // silently"): a lazy page chunk that cannot be loaded leaves no fixed error text with
  // an action, because the routes have no errorElement / error boundary.
  test('a page chunk that fails to load shows an error with an action, not a crash', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    await page.route('**/assets/SettingsPage-*.js', (r) => r.abort('connectionrefused'));
    await page.getByRole('link', { name: 'Impostazioni' }).click();
    await expect(page.locator('.topbar')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Riprova' })).toBeVisible({ timeout: 5_000 });
  });

  test('html lang follows the UI language', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  });

  test('every lazy page loads by in-app navigation and the main chunk is small', async ({
    page,
  }) => {
    const p = await ensureProject();
    await page.goto('/');
    await page.getByRole('link', { name: NAME }).first().click();
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
    await page.getByRole('link', { name: 'Impostazioni' }).click();
    await expect(page.getByLabel('Attivo di recente (giorni)')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
    expect(p.slug).toBeTruthy();
    const assets = fs.readdirSync('apps/web/dist/assets').filter((f) => /^index-.*\.js$/.test(f));
    for (const a of assets) {
      expect(fs.statSync(`apps/web/dist/assets/${a}`).size).toBeLessThan(500 * 1024);
    }
  });

  test('UTF-8 text with accents, euro and emoji round-trips through REST and MCP', async () => {
    const p = await ensureProject();
    const api = await agent();
    const text = 'Più è già: 12 € 🔌🛠️ — naïve';
    const rest = await api.post(`/api/projects/${p.id}/diary`, { data: { body: text } });
    expect(rest.status()).toBe(201);
    const id = ((await rest.json()) as { id: number }).id;
    expect(((await (await api.get(`/api/diary/${id}`)).json()) as { body: string }).body).toBe(
      text,
    );
    // UTF-8 with a BOM, as some Windows tools write it.
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ body: `${text} BOM` }), 'utf8'),
    ]);
    const withBom = await api.post(`/api/projects/${p.id}/diary`, {
      headers: { 'content-type': 'application/json' },
      data: bom,
    });
    expect(withBom.status(), await withBom.text()).toBe(201);
    // Latin-1 is refused.
    const latin1 = await api.post(`/api/projects/${p.id}/diary`, {
      headers: { 'content-type': 'application/json' },
      data: Buffer.from(JSON.stringify({ body: 'più' }), 'latin1'),
    });
    expect(latin1.status()).toBe(400);

    const client = new Client({ name: 'verify-c', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${E2E.agentPort}/mcp`), {
        requestInit: {
          headers: { authorization: `Bearer ${fs.readFileSync(E2E.tokenFile, 'utf8')}` },
        },
      }),
    );
    try {
      const r = await client.callTool({
        name: 'log_progress',
        arguments: { project: p.slug, body: `${text} MCP` },
      });
      expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
      const d = await client.callTool({ name: 'get_diary', arguments: { project: p.slug } });
      const out = (d.content as { type: string; text?: string }[])
        .map((c) => c.text ?? '')
        .join('\n');
      expect(out).toContain(`${text} MCP`);
      expect(out).toContain(text);
    } finally {
      await client.close();
    }
  });
});

test.describe('verifyC tablet', () => {
  test.use({ viewport: { width: 800, height: 1000 } });

  test('no sideways scroll and sidebars above the content at 800 px', async ({ page }) => {
    await ensureProject();
    const wide: string[] = [];
    for (const s of PAGES) {
      await page.goto(s.path);
      await page.waitForLoadState('networkidle');
      const o = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (o > 0) wide.push(`${s.name}: ${o}px`);
    }
    expect(wide).toEqual([]);
    await page.goto('/');
    const f = await page.locator('aside.filters').boundingBox();
    const c = await page.locator('section.content').boundingBox();
    expect(f!.y + f!.height).toBeLessThanOrEqual(c!.y + 1);
  });
});
