#!/usr/bin/env node
/**
 * Screenshot the running game through a real browser.
 *
 *    npm run dev &
 * 	  node scripts/screenshot.mjs out.png
 *
 * Exists because looking at the output is the only thing that has reliably caught the
 * defects in this project's art and rendering, and because driving Chrome by hand does
 * not work: a tab that is not visible has its requestAnimationFrame throttled to a stop,
 * so the game sits frozen a few ticks in and every frame-time number is a lie. Playwright
 * renders whether or not anyone is looking.
 *
 * It marches the starting force at the herd first. The herd spawns about sixteen tiles
 * from the player's units and vision reaches eight, so a screenshot taken at load shows
 * no cattle at all.
 */
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'game.png';
const settleMs = Number(process.argv[3] ?? 9000);
const url = process.env.GAME_URL ?? 'http://localhost:5173/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on('console', (message) => {
  if (message.type() === 'error') console.log('console error:', message.text());
});
page.on('pageerror', (error) => console.log('page error:', error.message));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(2500);

await page.mouse.move(340, 180);
await page.mouse.down();
await page.mouse.move(900, 520, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
await page.mouse.click(760, 640, { button: 'right' });

await page.waitForTimeout(settleMs);
await page.screenshot({ path: out });
console.log(`[screenshot] ${out}`);
await browser.close();
