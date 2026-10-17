// test-diagnose.mjs — Task 3：错题诊断顾问智能体（wrong-diagnosis）注册
// 覆盖：
//   - lib/ai-agents.mjs DEFAULT_AGENTS 含 role='wrong-diagnosis' 条目
//   - initAiConfig 补种后 getAgent('wrong-diagnosis') 可见且 id === 7
//     （用 AI_CONFIG_DB 环境变量指向临时库，不影响真实 ai-config.db）
// 运行：node --test test-diagnose.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let tmpDb;

before(() => {
  tmpDb = path.join(os.tmpdir(), `diagnose-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.AI_CONFIG_DB = tmpDb;
});

after(async () => {
  try {
    const { closeAiConfig } = await import('./lib/ai-agents.mjs');
    closeAiConfig();
  } catch {}
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) {
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
