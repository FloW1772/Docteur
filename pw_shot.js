const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:5173');
  // Wait for WebGL canvas to render (Three.js needs a few frames)
  await page.waitForTimeout(3500);
  await page.screenshot({ path: 'C:/dev/Docteur/screenshot_render.png', fullPage: false });
  console.log('Screenshot saved');
  await browser.close();
})();
