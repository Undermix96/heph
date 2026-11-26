import { expect, test } from '@playwright/test';

/**
 * Independent verification, phase 5 group C (phone project only, 390 px): the Connect
 * Claude Code and test-pattern sections fit the screen and keep 44 px touch targets (D56).
 */
test('settings Connect and test patterns: no horizontal overflow at 390 px', async ({ page }) => {
  await page.goto('/settings#s-claude');
  await expect(page.locator('#s-claude')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  for (const sel of ['#s-claude', '#s-tests']) {
    const wide = await page
      .locator(`${sel} *`)
      .evaluateAll((els) =>
        els
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5)
          .map((e) => `${e.tagName}.${e.className}`),
      );
    expect(wide, sel).toEqual([]);
  }
  await page.screenshot({ path: '.e2e-data/verifyC5-settings-phone.png', fullPage: true });
});

test('settings Connect and test patterns: touch targets are at least 44x44 px', async ({
  page,
}) => {
  await page.goto('/settings#s-tests');
  await expect(page.getByLabel('Nuovo schema')).toBeVisible();
  const small = await page
    .locator('#s-claude button, #s-tests button, #s-tests input, #s-activity input')
    .evaluateAll((els) =>
      els
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { what: e.getAttribute('aria-label') ?? e.textContent, w: r.width, h: r.height };
        })
        .filter((x) => x.w < 44 || x.h < 44)
        .map((x) => `${x.what} ${Math.round(x.w)}x${Math.round(x.h)}`),
    );
  expect(small).toEqual([]);
});
