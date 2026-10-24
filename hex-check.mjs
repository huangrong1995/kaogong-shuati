import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.goto('http://localhost:3000/radar-preview.html?t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const res = await page.evaluate(() => {
  const cvs = document.querySelector('#a');
  const ctx = cvs.getContext('2d');
  const { width: w, height: h } = cvs;
  const img = ctx.getImageData(0, 0, w, h).data;
  let drawn = 0, primary = 0, gold = 0, greenPx = 0;
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i+1], b = img[i+2], a = img[i+3];
    if (a < 8) continue;
    drawn++;
    if (Math.abs(r-20)<30 && Math.abs(g-80)<30 && Math.abs(b-141)<40) primary++;
    if (Math.abs(r-180)<45 && Math.abs(g-132)<45 && Math.abs(b-58)<50) gold++;
  }
  return { drawn, primary, gold };
});
console.log(JSON.stringify(res));
await page.screenshot({ path: '/home/hrong/kaogong-shuati/shots/radar-hex-light.png' });
await page.close();
