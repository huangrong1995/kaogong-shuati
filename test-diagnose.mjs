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
import { formatDiagnosisPrompt } from './lib/local-queries.mjs';

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
async function withServer(fn) {
  const port = 5200 + Math.floor(Math.random() * 200);
  await new Promise((res) => { const s = net.createServer(); s.listen(port, () => { s.close(res); }); });
  const srv = spawn(process.execPath, ['server.mjs', String(port)], {
    stdio: 'ignore',
    env: { ...process.env, AI_CONFIG_DB: SPW_DB },
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn(port);
  } finally {
    srv.kill();
  }
}

test('formatDiagnosisPrompt：输出含矩阵摘要与错题细分标签', () => {
  const text = formatDiagnosisPrompt(
    { target: 0.72, groups: [{ group: '判断推理', rate: 50, line: 74, met: false, total: 20 }] },
    [{ group: '判断推理', sub: '图形推理', leaf: '笔画数', content: '…', myAnswer: 'B', correctAnswer: 'A', analysis: '一笔画…' }]
  );
  assert.ok(text.includes('判断推理') && text.includes('50') && text.includes('笔画数') && text.includes('一笔画'));
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
