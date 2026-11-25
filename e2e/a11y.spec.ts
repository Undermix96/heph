import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PAGES } from './pages.js';

/** WCAG 2.1 AA checks with axe on every screen: no serious or critical violations. */
for (const p of PAGES) {
  test(`a11y ${p.name}`, async ({ page }) => {
    await page.goto(p.path);
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    const bad = result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(
        (v) =>
          `${v.id}: ${v.help} (${v.nodes
            .map((n) => n.target.join(' '))
            .slice(0, 3)
            .join(' | ')})`,
      );
    expect(bad).toEqual([]);
  });
}
