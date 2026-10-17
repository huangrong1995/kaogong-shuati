// test-diagnose.mjs — Task 3/4：错题诊断顾问智能体（wrong-diagnosis）+ POST /api/ai/diagnose 服务端冒烟 + formatDiagnosisPrompt
// 覆盖：
//   - lib/ai-agents.mjs DEFAULT_AGENTS 含 role='wrong-diagnosis' 条目
//   - initAiConfig 补种后 getAgent('wrong-diagnosis') 可见且 id === 7
//     （用 AI_CONFIG_DB 环境变量指向临时库，不影响真实 ai-config.db）
//   - server /api/ai/diagnose：未配 api_key → 可读降级 notice（不打 LLM）
//   - formatDiagnosisPrompt：矩阵缩略 + 错题细分标签（纯函数，不依赖服务器）
// 运行：node --test test-diagnose.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { formatDiagnosisPrompt, diagOptions, diagAnswerText, diagClean, createLocalApi, FENBI_TREE } from './lib/local-queries.mjs';
import { createLocalHandler } from './public/local-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDb;
// server 冒烟的独立 AI 配置库（与测试进程 before() 的 tmpDb 分开，避免写真实 ai-config.db）
const SPW_DB = `/tmp/diagnose-server-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

before(() => {
  tmpDb = path.join(os.tmpdir(), `diagnose-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.AI_CONFIG_DB = tmpDb;
});

after(async () => {
  try {
    const { closeAiConfig } = await import('./lib/ai-agents.mjs');
    closeAiConfig();
  } catch {}
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm', SPW_DB, SPW_DB + '-wal', SPW_DB + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
});

test('DEFAULT_AGENTS 含 wrong-diagnosis', async () => {
  const { DEFAULT_AGENTS } = await import('./lib/ai-agents.mjs');
  assert.ok(DEFAULT_AGENTS.find((a) => a.role === 'wrong-diagnosis'));
});

test('initAiConfig 补种后 getAgent(wrong-diagnosis) 可见且 id 为 7', async () => {
  const { initAiConfig, getAgent } = await import('./lib/ai-agents.mjs');
  await initAiConfig();
  const agent = getAgent('wrong-diagnosis');
  assert.ok(agent, 'ai_agents 应含 wrong-diagnosis 行');
  assert.equal(agent.id, 7);
  assert.equal(agent.name, '错题诊断顾问');
  assert.equal(agent.enabled, 0);
});

// ---------- Task 4：server /api/ai/diagnose 冒烟（不打 LLM；AI_CONFIG_DB 指向独立临时库，wrong-diagnosis 未配 key） ----------
// 探测一个空闲端口；若撞上被占用（EADDRINUSE）则换号重试，避免探针与其它进程竞争同一端口
async function pickFreePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 5200 + Math.floor(Math.random() * 800);
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(port, () => s.close(() => res(true)));
    });
    if (free) return port;
  }
  throw new Error('无法分配空闲测试端口');
}

async function withServer(fn) {
  const port = await pickFreePort();
  const srv = spawn(process.execPath, ['server.mjs', String(port)], {
    stdio: 'ignore',
    env: { ...process.env, AI_CONFIG_DB: SPW_DB },
  });
  let exited = false;
  const exitedP = new Promise((res) => srv.once('exit', () => { exited = true; res(); }));
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch {}
      if (exited) break; // 子进程已退出（如端口冲突）→ 别再空等 10s
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn(port);
  } finally {
    srv.kill();
    await exitedP; // 等子进程真正退出释放端口，避免下一个 withServer 探针撞上
  }
}

test('formatDiagnosisPrompt：输出含矩阵摘要与错题细分标签', () => {
  const text = formatDiagnosisPrompt(
    { target: 0.72, groups: [{ group: '判断推理', rate: 50, line: 74, met: false, total: 20 }] },
    [{ group: '判断推理', sub: '图形推理', leaf: '笔画数', content: '…', myAnswer: 'B', correctAnswer: 'A', analysis: '一笔画…' }]
  );
  assert.ok(text.includes('判断推理') && text.includes('50') && text.includes('笔画数') && text.includes('一笔画'));
  assert.ok(text.includes('样本 20 题')); // M5：每行含样本量，LLM 可区分数据不足与薄弱
});

// ---------- Task 4 修复 R1：共享渲染纯函数（不打 LLM、不起 server） ----------
test('diagAnswerText：空 options 判断题按 0=正确/1=错误 渲染', () => {
  assert.equal(diagAnswerText(0, []), '正确');
  assert.equal(diagAnswerText(1, []), '错误');
});
test('diagAnswerText：["正确","错误"] 选项判断题方向正确（0=正确/1=错误）', () => {
  assert.equal(diagAnswerText(0, ['正确', '错误']), '正确');
  assert.equal(diagAnswerText(1, ['正确', '错误']), '错误');
  assert.equal(diagAnswerText('[0]', ['正确', '错误']), '正确');
  assert.equal(diagAnswerText(1, ['正确', '错误']), '错误');
});
test('diagAnswerText：字母/文本单选输出选项文本', () => {
  assert.ok(diagAnswerText(0, ['A选项', 'B选项', 'C选项']).includes('A选项'));
  assert.ok(diagAnswerText(1, ['A', 'B', 'C', 'D']).includes('B'));
});
test('diagAnswerText：多选 JSON 数组 / 逗号串 / 数组串形态', () => {
  assert.equal(diagAnswerText([0, 2], ['A', 'B', 'C', 'D']), 'A、C');
  assert.equal(diagAnswerText('0,2', ['A', 'B', 'C', 'D']), 'A、C');
  assert.equal(diagAnswerText('[0,2]', ['A', 'B', 'C', 'D']), 'A、C');
});
test('diagOptions：解析 options 字段（失败回退空数组）', () => {
  assert.deepEqual(diagOptions({ options: '["A","B"]' }), ['A', 'B']);
  assert.deepEqual(diagOptions({ options: 'not-json' }), []);
  assert.deepEqual(diagOptions({}), []);
});
test('diagClean：剥 HTML 并折叠空白后截断', () => {
  assert.equal(diagClean('<p>题干</p>  内容', 140), '题干 内容');
  assert.ok(!diagClean('<p>x</p>', 140).includes('<'));
});

test('server /api/ai/diagnose：未配置 api_key 返回可读降级', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/api/ai/diagnose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 0.72, exam: 'fujian' }),
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.ok(typeof r.notice === 'string' && r.content === null);
  });
});

test('server /api/ai/diagnose：无错题时提示暂无诊断（或降级）结构不报错', async () => {
  // 同上（agent 未配 key → 走降级 notice）；若 practice.db 恰好有错题也无妨：content 为 null 时断言 notice 是字符串
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/api/ai/diagnose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 0.72, exam: 'fujian' }),
    });
    assert.equal(res.status, 200);
    const r = await res.json();
    if (r.content === null) assert.ok(typeof r.notice === 'string');
  });
});

// ---------- Task 5：本地/App 模式错题诊断接线（local-handler /ai/diagnose + ai-local.diagnose） ----------
// 真实错题候选：question_categories 有 sub、questions 有题干/选项/数字答案，subject 属行测/职测
function pickDiagRecord(eng) {
  const MODS = FENBI_TREE.map((g) => g.group);
  const cand = eng.get(`
    SELECT qc.question_id qid, qc.subject subject, qc.category module,
           q.answerIndex aIdx, q.options opts
    FROM question_categories qc
    JOIN questions q ON q.questionId = qc.question_id
    WHERE qc.subject IN ('公务员·行测', '事业编·职测')
      AND qc.sub != '' AND q.content != '' AND q.options != '[]' AND q.options IS NOT NULL
      AND q.answerIndex IS NOT NULL AND q.answerIndex >= 0
      AND qc.category IN (${MODS.map(() => '?').join(',')})
    LIMIT 1
  `, ...MODS);
  if (!cand) throw new Error('tiku_app.db 缺少可诊断的错题候选');
  const optArr = JSON.parse(cand.opts);
  const wrongSel = optArr.length > 1 ? (cand.aIdx + 1) % optArr.length : 0;
  return {
    question_id: cand.qid,
    subject: cand.subject,
    sub_key: cand.module,
    selected: [wrongSel],
    is_correct: 0,
    created_at: Date.now(),
  };
}

test('local-handler /ai/diagnose：组装 payload 并转发给 ai.diagnose（真实题库行测错题）', async () => {
  const db2 = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const eng = { get: (s, ...p) => db2.prepare(s).get(...p), all: (s, ...p) => db2.prepare(s).all(...p) };
  const qapi = createLocalApi(eng, eng, {});
  const rec = pickDiagRecord(eng);
  let got = null;
  const fakeAi = { diagnose: async (p) => { got = p; return { content: 'ok', model: 'm' }; } };
  const handler = createLocalHandler({ query: qapi, records: null, store: { getAll: async () => [rec] }, ai: fakeAi });
  const r = await handler('api/ai/diagnose', { method: 'POST', body: JSON.stringify({ target: 0.7, exam: 'guokao' }) });
  assert.equal(r.content, 'ok');
  assert.equal(r.model, 'm');
  assert.ok(got && typeof got === 'string' && got.length > 0, 'payload 应已组装为诊断 prompt 文本');
  assert.ok(got.includes(rec.sub_key), `prompt 应含模块名：${got.slice(0, 80)}`);
  assert.ok(got.includes('我答') && got.includes('正确'), 'prompt 应含作答/正确渲染（与 server 同构）');
});

test('local-handler /ai/diagnose：无错题时返回 notice（与 server 同构）', async () => {
  const db2 = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const eng = { get: (s, ...p) => db2.prepare(s).get(...p), all: (s, ...p) => db2.prepare(s).all(...p) };
  const qapi = createLocalApi(eng, eng, {});
  const handler = createLocalHandler({ query: qapi, records: null, store: { getAll: async () => [] }, ai: { diagnose: async () => ({ content: 'x' }) } });
  const r = await handler('api/ai/diagnose', { method: 'POST', body: JSON.stringify({ target: 0.7, exam: 'guokao' }) });
  assert.equal(r.content, null);
  assert.ok(typeof r.notice === 'string' && r.notice.includes('薄弱模块'), `应提示先去刷题：${r.notice}`);
});

test('local-handler /ai/diagnose：fakeAi 未配置 key → 可读降级 notice', async () => {
  const db2 = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const eng = { get: (s, ...p) => db2.prepare(s).get(...p), all: (s, ...p) => db2.prepare(s).all(...p) };
  const qapi = createLocalApi(eng, eng, {});
  const rec = pickDiagRecord(eng);
  const fakeAi = { diagnose: async () => ({ error: '该 AI 未配置 api_key，请到 AI 设置页填写' }) };
  const handler = createLocalHandler({ query: qapi, records: null, store: { getAll: async () => [rec] }, ai: fakeAi });
  const r = await handler('api/ai/diagnose', { method: 'POST', body: JSON.stringify({ target: 0.7, exam: 'guokao' }) });
  assert.equal(r.content, null);
  assert.ok(typeof r.notice === 'string' && r.notice.includes('api_key'), `应提示未配置 key：${r.notice}`);
});

test('ai-local diagnose：找到 wrong-diagnosis 并转发 callChat（不打缓存）', async () => {
  const storage = new Map();
  const prevLS = global.localStorage;
  const prevFetch = global.fetch;
  global.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('ai-agents.default.json')) {
      return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, 'public/ai-agents.default.json'), 'utf8')) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const calls = [];
    const request = async (url, opts) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'DIAG_OK' } }] }), text: async () => '' };
    };
    const { createAiApi } = await import('./public/ai-local.js');
    const ai = await createAiApi({ request, tiku: null, query: null });
    const r = await ai.diagnose('测试诊断 payload');
    assert.equal(r.content, 'DIAG_OK');
    assert.equal(r.model, 'deepseek-v4-flash-free', '成功响应带 model（与 server 1:1）');
    assert.equal(calls.length, 1, '诊断只调一次（绝不缓存）');
    const msg = calls[0].body.messages;
    assert.ok(msg.some((m) => m.role === 'system' && m.content.includes('诊断')), 'system_prompt 应为错题诊断顾问');
    assert.equal(msg.find((m) => m.role === 'user').content, '测试诊断 payload');
  } finally {
    global.localStorage = prevLS;
    global.fetch = prevFetch;
  }
});
