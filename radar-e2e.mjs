import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });

// 浅色
await page.goto('http://localhost:3000/?view=ability&t=' + Date.now(), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#ab-radar', { timeout: 20000 });
await page.waitForTimeout(1200);
const light = await page.evaluate(() => {
  const cvs = document.querySelector('#ab-radar');
  const ctx = cvs.getContext('2d');
  const { width: w, height: h } = cvs;
  const img = ctx.getImageData(0, 0, w, h).data;
  let drawn = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i+3] > 8) drawn++;
  return { drawn, w, h };
});
await page.screenshot({ path: '/home/hrong/kaogong-shuati/shots/ability-radar-new-light.png' });

// 暗色：走 app 自己的 theme 切换（localStorage）
await page.evaluate(() => localStorage.setItem('theme', 'dark'));
await page.reload();
await page.waitForSelector('#ab-radar', { timeout: 20000 });
await page.waitForTimeout(1200);
const dark = await page.evaluate(() => {
  const cvs = document.querySelector('#ab-radar');
  const ctx = cvs.getContext('2d');
  const { width: w, height: h } = cvs;
  const img = ctx.getImageData(0, 0, w, h).data;
  let drawn = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i+3] > 8) drawn++;
  return { drawn, w, h, theme: document.documentElement.dataset.theme || document.body.getAttribute('data-theme') };
});
await page.screenshot({ path: '/home/hrong/kaogong-shuati/shots/ability-radar-new-dark.png' });

console.log(JSON.stringify({ light, dark }));
await page.close();
