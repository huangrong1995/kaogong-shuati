// test-ability.mjs — Task 2：达标线共享纯函数 + 能力矩阵（server /api/ability + 本地 abilityMatrix）
// 运行：node --test test-ability.mjs
// 本地矩阵部分需要 app-assets/tiku_app.db（已含 question_categories 表）；server 冒烟为只读 GET，不写 practice.db。
// 真实 qid 说明：brief 原例 100000 等 qid 在 tiku_app.db 中不存在（Step 5 注释允许改用真实 qid），
//   这里用真实判断推理 qid（881/895/909/915/923/937，SELECT 自 question_categories）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi, computeTargetLines } from './lib/local-queries.mjs';

test('computeTargetLines：均匀权重 → 全员 = target（未触界）', () => {
  const w = Array(6).fill(1 / 6);
  const lines = computeTargetLines(w, 0.72);
  assert.deepEqual(lines, Array(6).fill(0.72));
});
test('computeTargetLines：高权重模块线更高', () => {
  const w = [0.30, 0.20, 0.20, 0.10, 0.10, 0.10];       // w̄=1/6
  const lines = computeTargetLines(w, 0.68);
  assert.ok(lines[0] > 0.68 && lines[5] < 0.68);         // 0.30 档更高、0.10 档更低
  assert.ok(lines[0] >= 0.50 && lines[0] <= 0.90);       // 恒在 clamp 区间
});
test('computeTargetLines：clamp 上下界', () => {
  assert.equal(computeTargetLines([1, 0, 0, 0, 0, 0], 0.90)[0], 0.90); // 上界：权重 1 档 T+k·Δ 破 0.90 → clamp
  // 下界：权重 0 档（低权重模块）T+k·Δ 破 0.50 → clamp（brief 原断言取 [1]，但 [0,1,0,0,0,0] 的 index1 是最高权重档，
  //   按公式 line = T + k·(w_i − w̄) 应更高而非触下界；取 index0（w=0）才触下界，见 task-2-report.md 偏离说明）
  assert.equal(computeTargetLines([0, 1, 0, 0, 0, 0], 0.50)[0], 0.50);
});

// ---------- 本地能力矩阵（app-assets/tiku_app.db，含 question_categories） ----------
const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const engine = { get: (s, ...p) => db.prepare(s).get(...p), all: (s, ...p) => db.prepare(s).all(...p) };
const qapi = createLocalApi(engine, engine, {});
const CUR = Date.now();
const mk = (qid, subKey, ok, subject = '公务员·行测') => ({ question_id: qid, sub_key: subKey, subject, is_correct: ok, archived: 0, created_at: CUR });

test('abilityMatrix：行测/职测聚合 + 排除主观与归档', () => {
  const records = [
    mk(881, '判断推理', 1), mk(881, '判断推理', 0), mk(895, '图形推理', 0),   // 注: sub_key='图形推理' 非六模块 → 不入矩阵
    { ...mk(909, '判断推理', null) },                                   // 主观题排除
    { ...mk(915, '判断推理', 0), archived: 1 },                          // 归档排除
    { ...mk(923, '', 0) },                                             // 未分类排除出矩阵
  ];
  const m = qapi.abilityMatrix(records, { target: 0.7, exam: 'guokao', k: 0.35 });
  assert.equal(m.groups.length, 6);
  const jt = m.groups.find((g) => g.group === '判断推理');
  assert.equal(jt.total, 2); assert.equal(jt.correct, 1); assert.equal(jt.rate, 50);
  assert.ok(jt.enough === false);                                        // 2 < 5
  assert.ok(typeof jt.line === 'number' && jt.line >= 50 && jt.line <= 90);
  assert.ok(Array.isArray(jt.subs) && jt.subs.every((s) => ['sub', 'total', 'correct', 'rate'].every((k2) => k2 in s)));
  assert.ok(jt.subs.every((s) => Array.isArray(s.leaves)));
  assert.equal(Array.isArray(m.weights) && m.weights.length, 6);
  assert.equal(Math.abs(m.weights.reduce((a, b) => a + b.w, 0) - 100) < 5, true); // 权重和为 ≈100%
});
test('abilityMatrix：同 qid 双 subject 只计一次（subject 匹配关联）', () => {
  const records = [mk(881, '判断推理', 1), mk(881, '判断推理', 0, '事业编·职测')]; // 同 qid 两科
  const m = qapi.abilityMatrix(records, { target: 0.7, exam: 'guokao' });
  const jt = m.groups.find((g) => g.group === '判断推理');
  assert.equal(jt.total, 2);                                             // 两次作答各自入账，不因 qc 双行而翻倍
});

// ---------- server /api/ability 冒烟（只读 GET，不写 practice.db） ----------
import { spawn } from 'node:child_process';
import net from 'node:net';
const PORT = 4700 + Math.floor(Math.random() * 200); let server;
test('server /api/ability 冒烟：形状正确（不写 practice.db）', async (t) => {
  await new Promise((res) => { const s = net.createServer(); s.listen(PORT, () => { s.close(res); }); });
  server = spawn(process.execPath, ['server.mjs', String(PORT)], { stdio: 'ignore', env: { ...process.env, AI_CONFIG_DB: '/tmp/ability-test-ai.db' } });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    const r = await fetch(`http://localhost:${PORT}/api/ability?target=0.72&exam=fujian`);
    const m = await r.json();
    assert.equal(m.groups.length, 6);
    assert.deepEqual(m.groups.map((g) => g.group), ['政治理论', '常识判断', '言语理解与表达', '数量关系', '判断推理', '资料分析']);
    for (const g of m.groups) for (const k of ['total', 'correct', 'rate', 'line', 'enough', 'met', 'subs']) assert.ok(k in g);
    assert.equal(Math.abs(m.weights.reduce((a, b) => a + b.w, 0) - 100) < 5, true);
  } finally {
    if (server) { server.kill(); server = null; }
  }
});
