// 验证首页模块顺序：行测 → 申论 → 自定义题库 → 其余（真实 Edge 渲染 + app.js 实际排序逻辑）
import { startAuthServer, registerUser, loginUser, authFetch, makeTempDb, pickFreePort } from './auth-test-helper.mjs';
import { chromium } from 'playwright-core';

const port = await pickFreePort();
const dbPath = makeTempDb('order');
const server = await startAuthServer({ prefix: 'order', port, dbPath });

// 登录拿 owner cookie（首个注册者用 bootstrap 码）
const reg = await registerUser(server.base, { username: 'orderowner', password: 'pass12345', inviteCode: server.bootCode });
const { sid, cookie } = await loginUser(server.base, { username: 'orderowner', password: 'pass12345' });
console.log('owner sid:', sid ? '***' : 'MISSING');

// 直连 Windows Edge（CDP）
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0] || await browser.newContext();
const page = await ctx.newPage();
await page.goto(server.base + '/');
await page.context().addCookies([{ name: 'sid', value: sid, url: server.base + '/' }]);
await page.reload();
await page.waitForSelector('.subject-grid .subject-card', { timeout: 15000 });

const names = await page.$$eval('.subject-grid .subject-card .name', els => els.map(e => e.textContent.trim()));
console.log('实际卡片顺序:', JSON.stringify(names));

const i = (x) => names.indexOf(x);
const ok =
  i('公务员·行测') === 0 && i('公务员·申论') === 1 && i('自定义题库') === 2 &&
  i('公务员·行测') < i('公务员·申论') && i('公务员·申论') < i('自定义题库');
console.log(ok ? '✅ 顺序正确：行测 → 申论 → 自定义题库 → 其余' : '❌ 顺序错误');

await page.close();
await browser.close();
server.close();
process.exit(ok ? 0 : 1);