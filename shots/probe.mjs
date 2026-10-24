import { chromium } from 'playwright-core';
import fs from 'node:fs';
const LOG = '/tmp/probe-log.txt';
const w = (s) => fs.appendFileSync(LOG, s + '\n');
fs.writeFileSync(LOG, '=== probe start ===\n');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const stage = (s) => { w(`[${Date.now()}] ${s}`); };
stage('goto');
await page.goto('http://localhost:4000/?t=2', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.subject-grid', { timeout: 20000 });
stage('subject');
await page.click('.subject-card:has-text("公务员·行测")');
await page.waitForSelector('.mod-tree', { timeout: 20000 });
const head = page.locator('.mod-group-head').filter({ hasText: '资料分析' });
await head.click();
await page.waitForTimeout(400);
const group = page.locator('.mod-group').filter({ has: head });
await group.locator('[data-all]').click();
await page.waitForSelector('#view[data-exam="1"] .quiz-rail', { timeout: 25000 });
stage('quiz rail reached');
await page.waitForTimeout(500);

const info = await page.evaluate(() => {
  const opts = [...document.querySelectorAll('.quiz-main .option')];
  return {
    optCount: opts.length,
    opt0Cls: opts[0] ? opts[0].className : null,
    opt0Text: opts[0] ? opts[0].textContent.slice(0, 80) : null,
    hasQcard: !!document.querySelector('.q-card'),
    hasBanner: !!document.querySelector('.result-banner'),
    hasConfirm: !!document.querySelector('#btn-confirm'),
    hasFb: !!document.querySelector('#answer-feedback'),
    metaText: document.querySelector('.q-progress-text')?.textContent || null,
    typeTag: document.querySelector('.tag-type')?.textContent || null,
    bodyStart: document.querySelector('.quiz-main')?.textContent.slice(0, 150) || null,
  };
});
w('INFO: ' + JSON.stringify(info));

if (info.optCount) {
  stage('click option');
  try { await page.click('.quiz-main .option', { timeout: 8000 }); } catch (e) { w('CLICK ERR: ' + e.message.slice(0, 200)); }
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    hasBanner: !!document.querySelector('.result-banner, #answer-feedback'),
    hasConfirm: !!document.querySelector('#btn-confirm'),
    selected: [...document.querySelectorAll('.quiz-main .option')].map((o) => o.className).join(' | '),
    bodyEnd: document.querySelector('.quiz-main')?.textContent.slice(-200) || null,
  }));
  w('AFTER: ' + JSON.stringify(after));
}

stage('done');
process.exit(0);