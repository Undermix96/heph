import { expect, test } from '@playwright/test';

/**
 * Independent verification, phase 5 group C (desktop, 1440 px): keyboard-only use of the
 * test-pattern editor and the Connect section layout. Invented data.
 */
test('keyboard only: add a pattern with Enter, remove it, save', async ({ page }) => {
  await page.goto('/settings#s-tests');
  const input = page.getByLabel('Nuovo schema');
  await input.focus();
  await page.keyboard.type('verifica c5 make test');
  await page.keyboard.press('Enter');
  const added = page.locator('#s-tests').getByText('verifica c5 make test', { exact: true });
  await expect(added).toBeVisible();
  // Tab back to the remove button of the new pattern (shift+tab from the input).
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator(':focus')).toHaveAttribute(
    'aria-label',
    'Rimuovi verifica c5 make test',
  );
  await page.keyboard.press('Enter');
  await expect(added).toHaveCount(0);
  // Focus is not lost to <body> after removing.
  const tag = await page.evaluate(() => document.activeElement?.tagName);
  expect(tag).not.toBe('BODY');
});

test('Connect section: commands do not overflow their box at 1440 px', async ({ page }) => {
  await page.goto('/settings#s-claude');
  const box = page.locator('#s-claude');
  await expect(box.getByText('claude plugin install heph@heph --scope user')).toBeVisible();
  const boxRight = await box.evaluate((e) => e.getBoundingClientRect().right);
  const over = await box
    .locator('*')
    .evaluateAll(
      (els, right) =>
        els
          .filter((e) => e.getBoundingClientRect().right > right + 0.5)
          .map((e) => `${e.tagName}.${e.className}`),
      boxRight,
    );
  expect(over).toEqual([]);
  await page.screenshot({ path: '.e2e-data/verifyC5-settings-desktop.png', fullPage: true });
});
