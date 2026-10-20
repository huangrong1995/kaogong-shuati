// test-custom-practice-e2e.mjs — 自定义刷题筛选 · 背题模式前端交互 e2e（Playwright + 系统 Edge）
// 运行：node test-custom-practice-e2e.mjs（自动起 server 于随机端口 + 独立临时库，测完关闭；需 npm i -D playwright-core）
// 账号体系：先经 API 注册测试用户，把 sid cookie 注入浏览器上下文 → 首页直接可用（不走登录 UI）
// Edge 获取：本机无 Linux Edge，测试通过 CDP 连接 Windows 侧常驻的 Edge（127.0.0.1:9222，同前的 radar 像素校验方案）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startAuthServer, registerUser } from './auth-test-helper.mjs';

const PORT = 4500 + Math.floor(Math.random() * 200);
let server, browser, page;

before(async () => {
  const s = await startAuthServer({ prefix: 'custom-e2e', port: PORT });
  server = s.server;
  const { sid } = await registerUser(s.base, { username: 'e2euser', inviteCode: s.bootCode });
  const port = Number(new URL(s.base).port);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  page = await browser.newPage(); // CDP 侧新 context（隔离出的隐式 context，复用已有 Edge 进程）
  await page.context().addCookies([{ name: 'sid', value: sid, url: `http://localhost:${port}` }]);
  await page.setViewportSize({ width: 420, height: 900 }); // 手机尺寸
});

after(async () => { await browser?.close(); server?.kill(); });

async function openPanel() {
  await page.getByText('公务员·行测', { exact: true }).first().click();
  await page.getByRole('heading', { name: /专项练习/ }).waitFor({ timeout: 10000 });
  const btn = page.getByRole('button', { name: '自定义刷题' });
  assert.ok(await btn.isVisible(), '行测页应有「自定义刷题」按钮');
  await btn.click();
  await page.locator('#cp-mode').waitFor();
}

test('e2e 设置筛选 → 确定 → 模块刷题按筛选出题 + 背题交互', async () => {
  await page.goto(`http://localhost:${PORT}`);
  await page.getByText('公务员·行测', { exact: true }).first().waitFor({ timeout: 15000 });
  const practiceUrls = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/practice')) practiceUrls.push(req.url());
  });

  await openPanel();
  // 设置：背题模式 + 近5年 + 偏难
  await page.getByText('背题模式', { exact: true }).click();
  await page.getByText('近5年', { exact: true }).click();
  await page.getByText('偏难', { exact: true }).click();
  await page.getByRole('button', { name: '确定' }).click();
  await page.waitForTimeout(300);
  // 面板关闭后回到专项练习页，卡片显示当前筛选
  const sub = await page.locator('.card-sub').textContent();
  assert.ok(sub.includes('当前筛选') && sub.includes('近5年') && sub.includes('偏难') && sub.includes('背题模式'), `卡片筛选提示：${sub}`);

  // 点专项练习大模块（判断推理）→ 展开 → 点「全部」→ 刷题
  await page.getByText('判断推理', { exact: true }).first().click();
  await page.locator('.mod-group-body:visible [data-all]').first().click();
  await page.locator('.q-progress-text').waitFor({ timeout: 15000 });
  // 请求应携带筛选参数（不带 custom=1，题量仍按模块规则）
  const url = practiceUrls.find((u) => u.includes('/api/practice'));
  assert.ok(url, '应发出 /api/practice 请求');
  assert.ok(url.includes('year=5'), `URL 应带 year=5：${url}`);
  assert.ok(url.includes('difficulty=hard'), `URL 应带 difficulty=hard：${url}`);
  assert.ok(!url.includes('custom=1'), `模块刷题不应带 custom=1：${url}`);

  // 背题模式生效
  const tip = await page.locator('.timer-tip').textContent();
  assert.ok(tip.includes('背题模式'), `计时条应提示背题模式：${tip}`);
  const prog0 = await page.locator('.q-progress-text').textContent();
  await page.locator('.option').first().click();
  await page.locator('#answer-feedback').waitFor({ timeout: 8000 });
  const fbTitle = (await page.locator('#answer-feedback .ab-title').textContent()).trim();
  assert.ok(/回答正确|回答错误|无标准答案/.test(fbTitle), `反馈横幅：${fbTitle}`);
  const prog1 = await page.locator('.q-progress-text').textContent();
  assert.equal(prog1, prog0, `点选后不应跳题：${prog0} → ${prog1}`);
  const locked = await page.locator('.option.locked').count();
  const total = await page.locator('.option').count();
  assert.equal(locked, total, `选项应全部锁定：${locked}/${total}`);

  // 跳到最后一道题作答 → 不自动交卷
  await page.evaluate(() => { for (let i = 0; i < 30; i++) window.nextQuestion(); });
  const prog4 = await page.locator('.q-progress-text').textContent();
  const idx = Number(prog4.match(/(\d+) \/ (\d+)/)[1]);
  const totalQ = Number(prog4.match(/\d+ \/ (\d+)/)[1]);
  assert.equal(idx, totalQ, '应位于最后一题');
  await page.locator('.option').first().click();
  await page.waitForTimeout(500);
  const prog5 = await page.locator('.q-progress-text').textContent();
  assert.equal(prog5, prog4, '最后一题作答后不应自动交卷');
  const toastTxt = await page.locator('#toast').textContent();
  assert.ok(toastTxt.includes('交卷'), `应提示交卷：${toastTxt}`);

  // 交卷 → 成绩页
  await page.getByRole('button', { name: '交卷' }).click();
  await page.waitForTimeout(500);
  const confirm = page.getByRole('button', { name: /直接交卷|确定交卷|确认交卷/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.getByText('正确率').waitFor({ timeout: 8000 });
});

test('e2e 申论页无入口按钮', async () => {
  await page.goto(`http://localhost:${PORT}`);
  await page.getByText('公务员·申论', { exact: true }).first().waitFor({ timeout: 10000 });
  await page.getByText('公务员·申论', { exact: true }).first().click();
  await page.getByRole('heading', { name: /专项练习/ }).waitFor({ timeout: 10000 });
  const cnt = await page.getByRole('button', { name: '自定义刷题' }).count();
  assert.equal(cnt, 0, '申论页不应有「自定义刷题」按钮');
});

test('e2e 默认做题模式：设置面板默认值 → 模块刷题点选自动跳题', async () => {
  await page.goto(`http://localhost:${PORT}`);
  await page.getByText('公务员·行测', { exact: true }).first().waitFor({ timeout: 10000 });
  await openPanel();
  // 上一用例保存了背题模式 → 改回刷题模式；年份/难度恢复默认
  await page.getByText('刷题模式', { exact: true }).click();
  await page.getByText('不限', { exact: true }).click();
  await page.getByText('随机', { exact: true }).click();
  await page.getByRole('button', { name: '确定' }).click();
  await page.waitForTimeout(300);
  await page.getByText('判断推理', { exact: true }).first().click();
  await page.locator('.mod-group-body:visible [data-all]').first().click();
  await page.locator('.q-progress-text').waitFor({ timeout: 15000 });
  const tip = await page.locator('.timer-tip').textContent();
  assert.ok(!tip.includes('背题模式'), `做题模式不应提示背题：${tip}`);
  const p0 = await page.locator('.q-progress-text').textContent();
  await page.locator('.option').first().click();
  await page.waitForTimeout(500);
  const p1 = await page.locator('.q-progress-text').textContent();
  assert.notEqual(p1, p0, `做题模式点选应自动跳题：${p0} → ${p1}`);
});
