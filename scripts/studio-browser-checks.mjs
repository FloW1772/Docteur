import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function captureStudio(page, name) {
  fs.mkdirSync('reports/studios-evidence', { recursive: true });
  const original = page.viewportSize();
  for (const [label, width, height] of [['desktop', 1365, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    const dialog = page.getByRole('dialog').last();
    const bounds = await dialog.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${name}: dialog fits ${label}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no page overflow ${label}`);
    await page.screenshot({ path: `reports/studios-evidence/${name}-${label}.png`, fullPage: true });
    await dialog.locator('button').first().focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i < 6 ? 'Tab' : 'Shift+Tab');
      assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), `${name}: focus stays in dialog`);
    }
  }
  await page.setViewportSize(original);
}
