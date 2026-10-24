import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = '/home/hrong/kaogong-shuati/shots';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4000';
let pass = 0, fail = 0;
const log = (ok, msg) => { ok ? pass++ : fail++; console.log(`${ok ? '✓' : '✗'} ${msg}`); };

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

async function newCtx(viewport, theme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (theme) await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
  return ctx;
}
const shot = async (page, name) => { await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}/${name}`, fullPage: false }); };

async function gotoHome(page) {
  await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.subject-grid', { timeout: 20000 });
  await page.waitForTimeout(600);
}

async function openSubject(page, name = '公务员·行测') {
  await page.click(`.subject-card:has-text("${name}")`);
  await page.waitForSelector('.mod-tree', { timeout: 20000 });
  await page.waitForTimeout(400);
}

async function openGroupPractice(page, groupName) {
  const head = page.locator('.mod-group-head').filter({ hasText: groupName });
  const group = page.locator('.mod-group').filter({ has: head });
  const vis = await group.locator('.mod-group-body').evaluate((el) => getComputedStyle(el).display);
  if (vis === 'none') await head.click(); // 已展开则不再点（点一下会收起）
  await page.waitForTimeout(350);
  await group.locator('[data-all]').click();
  await page.waitForSelector('#view[data-exam="1"]', { timeout: 25000 });
  await page.waitForSelector('#view[data-exam="1"] .q-card', { timeout: 10000 });
  const rail = page.locator('.quiz-rail');
  if (await rail.count()) await page.waitForSelector('.quiz-rail', { timeout: 8000 });
  await page.waitForTimeout(500);
}

async function findMaterialQuestion(page, maxCells = 15) {
  for (let i = 0; i < maxCells; i++) {
    if (await page.$('.quiz-main .material-box')) return i;
    const cells = page.locator('.quiz-rail .sheet-cell');
    const n = await cells.count();
    if (n < 2) break;
    await cells.nth((i + 1) % n).click();
    await page.waitForTimeout(500);
  }
  return -1;
}

async function answerQuestion(page) {
  // 单选答完自动跳下一题（无横幅）；多选/背题有确认或反馈框
  const before = await page.evaluate(() => {
    const p = document.querySelector('.q-progress-text');
    return p ? p.textContent : 'none';
  });
  await page.click('#view[data-exam] .option');
  await page.waitForTimeout(250);
  const cf = page.locator('#btn-confirm');
  try { if (await cf.count() && await cf.isVisible()) await cf.click(); } catch {}
  await page.waitForFunction(
    (prev) => {
      const p = document.querySelector('.q-progress-text');
      const moved = p && p.textContent !== prev;
      return moved || !!document.querySelector('.result-banner, #answer-feedback');
    },
    before,
    { timeout: 10000 }
  );
  await page.waitForTimeout(250);
}

async function submitToReview(page) {
  const railSubmit = page.locator('#rail-submit');
  const mainSubmit = page.locator('.btn-submit-obj');
  const pick = await page.evaluate(() => {
    const rs = document.querySelector('#rail-submit');
    const ms = document.querySelector('.btn-submit-obj');
    const visible = (el) => !!el && el.offsetParent !== null;
    if (visible(rs)) return 'rail';
    if (visible(ms)) return 'main';
    return null;
  });
  if (pick === 'rail') await railSubmit.click();
  else if (pick === 'main') await mainSubmit.click();
  else throw new Error('no submit button visible');
  // 有未答 → 漏答弹层 → 直接交卷
  const force = page.locator('#btn-force-submit, .btn-force-submit');
  try { await force.waitFor({ timeout: 4000 }); await force.click(); } catch {}
  await page.waitForSelector('.review-toolbar', { timeout: 20000 });
  await page.waitForSelector('.review-grid .review-card', { timeout: 10000 });
  await page.waitForTimeout(600);
}

// ================= A. 桌面浅色 1280×900 =================
console.log('===== A. Desktop light 1280×900 =====');
{
  const ctx = await newCtx({ width: 1280, height: 900 }, 'light');
  const page = await ctx.newPage();

  await gotoHome(page);
  await shot(page, 'home-desktop-light.png');
  log(!!(await page.$('.home-layout')), 'home-layout 存在');
  log(!!(await page.$('.home-aside')), 'home-aside 右侧快捷入口存在');
  const qg = await page.evaluate(() => getComputedStyle(document.querySelector('.quick-grid')).gridTemplateColumns.split(' ').length);
  log(qg >= 6, `quick-grid 列数=${qg}（≥980 应 6 列）`);

  await openSubject(page, '公务员·行测');
  await page.click('.mod-group-head:has-text("资料分析")');
  await page.waitForTimeout(400);
  await shot(page, 'subject-desktop-light.png');
  const mtCols = await page.evaluate(() => getComputedStyle(document.querySelector('.mod-tree')).gridTemplateColumns.split(' ').length);
  log(mtCols >= 2, `mod-tree 列数=${mtCols}（应 2 列）`);
  const progLine = await page.evaluate(() => {
    const h = document.querySelector('.mod-group-head');
    return h ? getComputedStyle(h).getPropertyValue('--p') : 'none';
  });
  log(progLine !== 'none' && progLine !== '', `mod-group-head --p="${progLine}"`);

  await openGroupPractice(page, '资料分析');
  const matIdx = await findMaterialQuestion(page);
  log(matIdx >= 0, `材料题定位：第 ${matIdx + 1} 题${matIdx < 0 ? '（本组无材料，仍截图）' : ''}`);
  await shot(page, 'quiz-desktop-light.png');
  log(!!(await page.$('#view[data-exam="1"] .quiz-rail')), 'quiz-rail 常驻侧栏存在');
  const railCss = await page.evaluate(() => {
    const r = document.querySelector('.quiz-rail');
    return r ? `${getComputedStyle(r).position}|${getComputedStyle(r).maxHeight}` : 'none';
  });
  log(railCss.startsWith('sticky'), `quiz-rail ${railCss}`);

  await answerQuestion(page);
  const cnt = await page.textContent('.rail-count');
  log(!!cnt && /\/\s*\d+\s*已答/.test(cnt), `rail-count="${cnt?.trim()}"`);
  await page.click('.nav-pc:has-text("下一题")');
  await page.waitForTimeout(400);
  await answerQuestion(page);
  await page.click('.nav-pc:has-text("下一题")');
  await page.waitForTimeout(400);
  await answerQuestion(page);
  const okCells = await page.locator('.quiz-rail .sheet-cell.ok').count();
  log(okCells >= 3, `侧栏已答高亮单元格=${okCells}`);
  await shot(page, 'quiz-answered-desktop-light.png');

  await submitToReview(page);
  await shot(page, 'review-desktop-light.png');
  log(!!(await page.$('.review-grid')), '复盘 .review-grid');
  await page.click('.rv-act:has-text("答题卡")');
  await page.waitForSelector('.sheet-overlay.drawer .sheet', { timeout: 8000 });
  await page.waitForTimeout(400);
  await shot(page, 'review-drawer-light.png');
  await ctx.close();

  const ctx2 = await newCtx({ width: 1280, height: 900 }, 'light');
  const p2 = await ctx2.newPage();
  await gotoHome(p2);
  await p2.click('#quick-wrong');
  await p2.waitForSelector('.list-grid', { timeout: 20000 });
  await p2.waitForTimeout(600);
  await shot(p2, 'wrong-desktop-light.png');
  log(true, '错题两列网格截图');
  await ctx2.close();

  const ctx3 = await newCtx({ width: 1280, height: 900 }, 'light');
  const p3 = await ctx3.newPage();
  await p3.goto(`${BASE}/?view=ai&t=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await p3.waitForSelector('.ai-agent-grid', { timeout: 20000 });
  await p3.waitForTimeout(600);
  await shot(p3, 'ai-desktop-light.png');
  const aiCols = await p3.evaluate(() => getComputedStyle(document.querySelector('.ai-agent-grid')).gridTemplateColumns.split(' ').length);
  log(aiCols >= 2, `ai-agent-grid 列数=${aiCols}`);
  await ctx3.close();
}

// ================= B. 桌面深色 =================
console.log('===== B. Desktop dark 1280×900 =====');
{
  const ctx = await newCtx({ width: 1280, height: 900 }, 'dark');
  const page = await ctx.newPage();
  await gotoHome(page);
  await shot(page, 'home-desktop-dark.png');
  await openSubject(page, '公务员·行测');
  await openGroupPractice(page, '资料分析');
  await findMaterialQuestion(page);
  await shot(page, 'quiz-desktop-dark.png');
  await answerQuestion(page);
  await submitToReview(page);
  await shot(page, 'review-desktop-dark.png');
  await ctx.close();
}

// ================= C. 手机回归 =================
console.log('===== C. Mobile 390×844 =====');
{
  const ctx = await newCtx({ width: 390, height: 844 }, 'light');
  const page = await ctx.newPage();
  await gotoHome(page);
  await shot(page, 'home-mobile-light.png');
  const qg = await page.evaluate(() => getComputedStyle(document.querySelector('.quick-grid')).gridTemplateColumns.split(' ').length);
  log(qg === 3, `mobile quick-grid 列数=${qg}（应 3）`);
  log(!(await page.$('.home-layout')), 'mobile 无 .home-layout');
  await openSubject(page, '公务员·行测');
  await shot(page, 'subject-mobile-light.png');
  await openGroupPractice(page, '常识判断');
  log(!(await page.$('.quiz-rail')), 'mobile 无 quiz-rail');
  await shot(page, 'quiz-mobile-light.png');
  await page.click('.q-card-btn');
  await page.waitForSelector('.sheet-overlay .sheet', { timeout: 8000 });
  await page.waitForTimeout(400);
  const mobileAlign = await page.evaluate(() => {
    const o = document.querySelector('.sheet-overlay.drawer');
    return o ? getComputedStyle(o).justifyContent : 'none';
  });
  log(mobileAlign === 'center', `mobile 答题卡弹层居中（justify-content=${mobileAlign}）`);
  await shot(page, 'quiz-mobile-sheet.png');
  await ctx.close();

  const ctx2 = await newCtx({ width: 390, height: 844 }, 'dark');
  const p2 = await ctx2.newPage();
  await gotoHome(p2);
  await p2.click('.subject-card:has-text("公务员·行测")');
  await p2.waitForSelector('.mod-tree', { timeout: 20000 });
  await openGroupPractice(p2, '常识判断');
  await answerQuestion(p2);
  await submitToReview(p2);
  await shot(p2, 'review-mobile-dark.png');
  await ctx2.close();
}

console.log(`\n===== 结果: pass=${pass} fail=${fail} =====`);
process.exit(0);