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
import { formatDiagnosisPrompt, diagOptions, diagAnswerText, diagClean } from './lib/local-queries.mjs';

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
