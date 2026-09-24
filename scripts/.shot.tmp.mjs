import { chromium } from 'playwright';
const [out, land = '', zoom = '0'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('err', e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForTimeout(1500);
if (land) { const s = page.locator('select').first(); const o = await s.locator('option').allTextContents(); await s.selectOption({ label: o.find(x => x.toLowerCase().includes(land)) ?? o[0] }); }
await page.locator('button', { hasText: 'Begin' }).first().click();
await page.waitForTimeout(8000);
await page.keyboard.press('h');
const z = Number(zoom);
if (z) { await page.mouse.move(720, 450); for (let i = 0; i < Math.abs(z); i++) { await page.mouse.wheel(0, z > 0 ? -120 : 120); await page.waitForTimeout(80); } }
await page.waitForTimeout(800);
await page.screenshot({ path: out });
await browser.close();
