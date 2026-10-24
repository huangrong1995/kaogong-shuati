import { chromium } from 'playwright-core';
import fs from 'node:fs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:3000/radar-preview.html?t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(900); // 等动画播完
await page.screenshot({ path: '/home/hrong/kaogong-shuati/shots/radar-new-light.png' });
// dark
await page.addInitScript(() => { document.documentElement.setAttribute('data-theme','dark'); });
await page.goto('http://localhost:3000/radar-preview.html?t=' + Date.now(), { waitUntil: 'networkidle' });
await page.evaluate(() => document.documentElement.setAttribute('data-theme','dark'));
await page.waitForTimeout(900);
await page.screenshot({ path: '/home/hrong/kaogong-shuati/shots/radar-new-dark.png' });
await page.close();
console.log('done');
