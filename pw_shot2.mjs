import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto('http://127.0.0.1:5173');
await page.waitForTimeout(4500);
await page.screenshot({ path: 'C:/dev/Docteur/screenshot_render2.png' });
console.log('Screenshot 2 saved');
await browser.close();
