import { expect, test } from '@playwright/test';
import { PAGES } from './pages.js';

/**
 * Screenshots of every screen at 1440 px (desktop project) and 390 px (phone project)
 * into .e2e-data/screens/, to compare with docs/design/screenshots. Also asserts that
 * no page scrolls sideways.
 */
for (const p of PAGES) {
  test(`screen ${p.name}`, async ({ page }, info) => {
    await page.goto(p.path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `.e2e-data/screens/${info.project.name}/${p.name}.png`,
      fullPage: true,
    });
  });
}
