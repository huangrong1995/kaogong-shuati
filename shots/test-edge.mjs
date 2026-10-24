import { chromium } from 'playwright-core';
try {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  console.log('connect OK, contexts:', browser.contexts().length);
  const ctx = browser.contexts()[0] || await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pages = ctx.pages();
  const p = pages[0] || await ctx.newPage();
  await p.setContent('<h1>hello WSL CDP</h1>');
  const title = await p.textContent('h1');
  console.log('h1 text:', title);
  await p.screenshot({ path: '/home/hrong/kaogong-shuati/shots/cdp-test.png' });
  console.log('screenshot saved');
} catch (e) {
  console.log('ERR:', e.message.slice(0, 800));
}