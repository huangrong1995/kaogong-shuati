import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.goto('http://localhost:3000/radar-preview.html?t=' + Date.now(), { waitUntil: 'networkidle' });
await page.waitForTimeout(1200); // 动画播完
const res = await page.evaluate(() => {
  const cvs = document.querySelector('#a');
  const ctx = cvs.getContext('2d');
  const { width: w, height: h } = cvs;
  const img = ctx.getImageData(0, 0, w, h).data;
  // 统计非背景像素数量 & 各类特征色像素
  let drawn = 0, ring = 0, primary = 0, green = 0, pillPx = 0;
  const cx = w/2, cy = h/2;
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i+1], b = img[i+2], a = img[i+3];
    if (a < 8) continue;
    drawn++;
    // 深蓝主色系（--primary #14508d ≈ (20,80,141)）
    if (Math.abs(r-20)<30 && Math.abs(g-80)<30 && Math.abs(b-141)<40) primary++;
    // 绿 --green #34c759 ≈ (52,199,89)
    if (Math.abs(r-52)<40 && Math.abs(g-199)<40 && Math.abs(b-89)<40) green++;
  }
  return { drawn, primary, green };
});
console.log(JSON.stringify(res));
await page.close();
