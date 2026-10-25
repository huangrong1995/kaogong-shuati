// test-stream-server.mjs — AI 接口 SSE 流式 e2e：带 Accept: text/event-stream → 流式帧；
// 不带 → 普通 JSON（parity 保证，现有调用方/测试零破坏）
// 运行：node --test test-stream-server.mjs（需先 node build-app-assets.mjs——startAuthServer 用 server.mjs + 临时库；本文件不依赖 app-assets，但共仓库跑需 tiku.db）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startAuthServer, registerUser, authFetch } from './auth-test-helper.mjs';

let mock, srv, api;
let calls = []; // 每次上游调用的 { stream, body }

// ---------- mock 上游：OpenAI 兼容 /chat/completions，按请求 stream 字段分流 ----------
before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const stream = parsed.stream === true;
      calls.push({ stream: !!stream, body: parsed });
      if (!stream) {
        // 单次 JSON（与真实网关一致：stream:false 不吐 SSE）
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '第一段第二段' } }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"思考甲"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_content":"思考乙"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"第二段"},"finish_reason":"stop"}]}\n\n');
        res.end();
      }, 20);
    });
  });
  await new Promise((r) => mock.listen(0, r));

  // 起真实 server（临时 practice/ai 库）：explainer(id1) + 题目解析员(id6) 指向 mock
  srv = await startAuthServer({ prefix: 'stream-srv' });
  const { cookie } = await registerUser(srv.base, { username: 'streamer', inviteCode: srv.bootCode });
  api = authFetch(srv.base, cookie);
  for (const id of [1, 6]) {
    const upd = await api(`/api/ai/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: `http://127.0.0.1:${mock.address().port}/v1`,
        api_key: 'sk-mock',
        model: 'mock-model',
      }),
    });
    const u = await upd.json();
    assert.ok(u.ok, `agent ${id} 指向 mock 失败：${JSON.stringify(u)}`);
  }
});

after(async () => {
  try { srv.server.kill(); } catch {}
  try { mock.close(); } catch {}
});

// 解析 SSE 响应体 → 帧对象数组（与 app.js api() 的客户端解析同构：\n\n 切帧、data: 取 payload）
function parseSse(text) {
  return text.split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter(Boolean)
    .map((payload) => { try { return JSON.parse(payload); } catch { return null; } })
    .filter(Boolean);
}
const doneFrame = (frames) => frames.find((f) => f.done === true);

// 构造 explain 请求体（自定义题直传，绕开 tiku 依赖；切换 selected 规避缓存命中）
const explainBody = (selected, correct) => ({
  questionId: null,
  selected,
  correct,
  questionData: {
    content: '某题题干：1+1=?',
    material: '',
    options: ['A、2', 'B、3', 'C、4', 'D、5'],
    answer: 'A',
    answerIndex: 0,
  },
});

test('POST /api/ai/explain 带 Accept 头 → SSE 流式帧 + done 终态', async () => {
  const res = await api('/api/ai/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(explainBody(0, true)),
  });
  assert.ok(/text\/event-stream/i.test(res.headers.get('content-type') || ''), `content-type 应为 SSE：${res.headers.get('content-type')}`);
  const text = await res.text();
  assert.ok(text.includes('data: {"d":"第一段"}'), '应含首段 delta 帧');
  assert.ok(text.includes('data: {"d":"第二段"}'), '应含次段 delta 帧');
  assert.ok(text.includes('data: {"d":"第二段"}\n\ndata: {"done":true'), 'delta 后应紧跟 done 结束帧');
});

test('POST /api/ai/explain 带 Accept 头 → done 帧携带终态字段（content/imageNote/cached 与非流式一致）', async () => {
  const res = await api('/api/ai/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(explainBody(1, false)),
  });
  const text = await res.text();
  const frames = parseSse(text);
  const deltas = frames.filter((f) => typeof f.d === 'string');
  assert.deepEqual(deltas.map((f) => f.d), ['第一段', '第二段'], '按序解析出每段正文增量');
  const reasons = frames.filter((f) => typeof f.r === 'string');
  assert.deepEqual(reasons.map((f) => f.r), ['思考甲', '思考乙'], '推理链增量独立走 r 帧转发给前端');
  const done = doneFrame(frames);
  assert.ok(done, '应有 done 帧');
  assert.equal(done.content, '第一段第二段', 'done.content 只含正文，思维链不混入终态');
  assert.equal(done.cached, false, '新作答不应命中缓存');
  assert.equal(done.notice, '解析完成');
  assert.equal(done.imageNote, null, '无图题为 null');
  assert.equal(done.done, true);
});

test('POST /api/ai/explain 不带 Accept 头 → 普通 JSON（parity，老调用方零破坏）', async () => {
  const res = await api('/api/ai/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(explainBody(2, true)),
  });
  assert.ok(/application\/json/i.test(res.headers.get('content-type') || ''), `content-type 应为 JSON：${res.headers.get('content-type')}`);
  const j = await res.json();
  assert.equal(j.content, '第一段第二段', 'JSON 终态与流式 done 一致');
  assert.equal(j.cached, false);
  assert.equal(j.idx || undefined, undefined); // 无多余字段泄漏
});

test('POST /api/ai/structure 文本分支带 Accept 头 → 流式（覆盖非 explain 端点）', async () => {
  const res = await api('/api/ai/structure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text: '一段包含题干的文本' }),
  });
  assert.ok(/text\/event-stream/i.test(res.headers.get('content-type') || ''), 'structure 也应流式');
  const text = await res.text();
  const done = doneFrame(parseSse(text));
  assert.ok(done, 'structure 应有 done 帧');
  assert.equal(done.text, '第一段第二段', 'structure done.text 为整合内容');
});

test('网关上游调用：带 Accept 头 → stream:true；不带 → 单次 JSON（流式由网关转发）', async () => {
  // 全部测试完成后再断言：3 次 explain + 1 次 structure（共 ≥4 次上游）
  assert.ok(calls.length >= 4, `应收到 ≥4 次上游调用，实际 ${calls.length}`);
  assert.ok(calls.some((c) => c.stream), '应存在 stream:true 的上游流式调用（SSE 请求转发流式）');
  assert.ok(calls.some((c) => !c.stream), '应存在单次 JSON 的上游调用（非 Accept 请求走单次，兼容老网关/代理）');
  assert.equal(calls[calls.length - 1].body.model, 'mock-model', '上游收到正确的 model');
});