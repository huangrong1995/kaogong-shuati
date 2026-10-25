// test-stream-callagent.mjs — callAgent 流式单元测试：stub fetch 返回 OpenAI SSE 流
// 覆盖：stream:true 逐 delta 回调并拼接；不带 stream 仍走单次 JSON（回归护栏）；空流报错
// 运行：node --test test-stream-callagent.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callAgent } from './lib/ai-agents.mjs';

const agent = {
  api_key: 'sk-test',
  base_url: 'https://mock.example/v1',
  model: 'mock-model',
  system_prompt: '你是一个测试助手',
  skill: '', // 空 skill：不触发 resolveSkill 读库，测试纯净
  temperature: 0.3,
  max_tokens: 100,
  reasoning_effort: 'low',
};

/** 构造 OpenAI SSE 字节流响应 */
function sseRes(frames) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(ctrl) {
        for (const f of frames) ctrl.enqueue(new TextEncoder().encode(f));
        ctrl.close();
      },
    }),
    json: async () => { throw new Error('流式响应不应调用 res.json()'); },
    text: async () => '',
  };
}

test('callAgent(stream:true)：逐 delta 回调、终态为增量拼接', async () => {
  const saved = global.fetch;
  global.fetch = async () => sseRes([
    'data: {"choices":[{"delta":{"content":"甲"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"乙"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"丙"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const got = [];
    const r = await callAgent(agent, 'hi', { stream: true, onDelta: (d) => got.push(d) });
    assert.equal(r.content, '甲乙丙', '终态 content 应为增量拼接');
    assert.deepEqual(got, ['甲', '乙', '丙'], 'onDelta 应按顺序收到每段增量');
  } finally { global.fetch = saved; }
});

test('callAgent(stream:true)：推理型模型 reasoning_content 走 onReasoning、不混入终态 content', async () => {
  const saved = global.fetch;
  global.fetch = async () => sseRes([
    'data: {"choices":[{"delta":{"reasoning_content":"先想…"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"再想…"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"正式答案"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"继续"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const deltas = [];
    const reasons = [];
    const r = await callAgent(agent, 'hi', { stream: true, onDelta: (d) => deltas.push(d), onReasoning: (rc) => reasons.push(rc) });
    assert.equal(r.content, '正式答案继续', '终态 content 只含正式输出，不含思维链');
    assert.deepEqual(deltas, ['正式答案', '继续'], 'onDelta 只收正式增量');
    assert.deepEqual(reasons, ['先想…', '再想…'], 'onReasoning 按序收到思维链增量');
  } finally { global.fetch = saved; }
});

test('callAgent 不带 stream：走单次 JSON（回归护栏，形状不变）', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '单次响应' } }] }),
    text: async () => '',
  });
  try {
    const r = await callAgent(agent, 'hi');
    assert.equal(r.content, '单次响应', '非流式路径应返回 json content');
  } finally { global.fetch = saved; }
});

test('callAgent(stream:true) 显式 stream:false：仍走单次 JSON', async () => {
  const saved = global.fetch;
  let bodySent = null;
  global.fetch = async (url, opts) => {
    bodySent = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'X' } }] }),
      text: async () => '',
    };
  };
  try {
    const r = await callAgent(agent, 'hi', { stream: false });
    assert.equal(r.content, 'X');
    assert.equal(bodySent.stream, false, '请求体 stream 应为 false');
  } finally { global.fetch = saved; }
});

test('callAgent(stream:true) 请求体带 stream:true', async () => {
  const saved = global.fetch;
  let bodySent = null;
  global.fetch = async (url, opts) => {
    bodySent = JSON.parse(opts.body);
    return sseRes(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
  };
  try {
    const r = await callAgent(agent, 'hi', { stream: true });
    assert.equal(r.content, 'ok');
    assert.equal(bodySent.stream, true, '请求体 stream 应为 true');
  } finally { global.fetch = saved; }
});

test('callAgent(stream:true) 空内容 → 可读错误（不 throw）', async () => {
  const saved = global.fetch;
  global.fetch = async () => sseRes([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const r = await callAgent(agent, 'hi', { stream: true });
    assert.ok(r.error && r.error.includes('无内容'), `应返回无内容错误：${r.error}`);
  } finally { global.fetch = saved; }
});

test('callAgent(stream:true) finish_reason=length 且无内容 → 截断提示', async () => {
  const saved = global.fetch;
  global.fetch = async () => sseRes([
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const r = await callAgent(agent, 'hi', { stream: true });
    assert.ok(r.error && r.error.includes('截断'), `应返回截断错误：${r.error}`);
  } finally { global.fetch = saved; }
});

test('callAgent(stream:true) finish_reason=length 但有内容 → 正常返回内容', async () => {
  const saved = global.fetch;
  global.fetch = async () => sseRes([
    'data: {"choices":[{"delta":{"content":"部分内容"},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  try {
    const r = await callAgent(agent, 'hi', { stream: true });
    assert.equal(r.content, '部分内容', '已有输出的截断不应报错（内容可先展示）');
  } finally { global.fetch = saved; }
});
