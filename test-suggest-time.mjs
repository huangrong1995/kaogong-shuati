// test-suggest-time.mjs — 建议用时计算（public/lib/suggest-time.js）
// 覆盖：模块基准表、难度线性缩放、题型权重、章节→模块映射、兜底与材料题跳过。
// 依赖：仅 public/lib 纯模块（xingce-chapter-map.js），无需 tiku.db / 构建产物，可独立运行。
// 运行：node --test test-suggest-time.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSuggested,
  suggestDifficultyFactor,
  suggestTypeFactor,
  SUGGEST_MODULE_SEC,
} from './public/lib/suggest-time.js';

test('模块基准表：常识 24s，其余符合 120 分钟/130 题口径（合计 114min + 6min 缓冲）', () => {
  assert.deepEqual(SUGGEST_MODULE_SEC, {
    '政治理论': 30, '常识判断': 24, '言语理解与表达': 60,
    '数量关系': 78, '判断推理': 60, '资料分析': 60,
  });
  // 基准表按官方题量反推全卷，应等于 114 分钟（120 分钟 - 涂卡/检查缓冲 6 分钟）
  const ts = [['政治理论', 20], ['常识判断', 15], ['言语理解与表达', 30], ['数量关系', 10], ['判断推理', 35], ['资料分析', 20]];
  const secs = ts.map(([m, c]) => SUGGEST_MODULE_SEC[m] * c).reduce((a, b) => a + b, 0);
  assert.equal(secs, 114 * 60);
});

test('难度系数：1→0.85、5→1.0、9→1.15 线性；缺省/非法 → 1.0', () => {
  assert.equal(suggestDifficultyFactor(1), 0.85);
  assert.equal(suggestDifficultyFactor(5), 1.0);
  assert.equal(suggestDifficultyFactor(9), 1.15);
  // 线性插值：d=4 → 0.85 + 3/8×0.3 = 0.9625（双精度有末位误差，用容差）
  assert.ok(Math.abs(suggestDifficultyFactor(4) - 0.9625) < 1e-9);
  assert.equal(suggestDifficultyFactor(undefined), 1);
  assert.equal(suggestDifficultyFactor('abc'), 1);
  assert.equal(suggestDifficultyFactor(0), 1);
});

test('题型权重：多选 ×1.4、判断对错 ×0.75、单选 ×1.0', () => {
  assert.equal(suggestTypeFactor(2), 1.4);
  assert.equal(suggestTypeFactor(3), 0.75);
  assert.equal(suggestTypeFactor(5), 0.75);
  assert.equal(suggestTypeFactor(1), 1);
  assert.equal(suggestTypeFactor(undefined), 1);
});

test('整卷累加：30 道言语 + 35 道判断、难度 5 单选 = 3900s', () => {
  const mem = Array.from({ length: 30 }, () => ({ chapter: '言语理解与表达', type: 1, difficulty: 5 }));
  const pan = Array.from({ length: 35 }, () => ({ chapter: '判断推理', type: 1, difficulty: 5 }));
  const r = computeSuggested([...mem, ...pan]);
  assert.deepEqual(r, { seconds: 30 * 60 + 35 * 60, label: '难度适中' });
});

test('常识快扫：15 道常识难度 2 → 24×0.8875×15 = 319.5 ≈ 320s，标签"难度简单"', () => {
  const qs = Array.from({ length: 15 }, () => ({ chapter: '常识判断', type: 1, difficulty: 2 }));
  const r = computeSuggested(qs);
  // 逐题累加后统一取整，与直接相乘存在末位浮点差，允许 ±1s
  assert.ok(Math.abs(r.seconds - 320) <= 1, `约 320s，实际 ${r.seconds}`);
  assert.equal(r.label, '难度简单');
});

test('常识多选（难度 9）：判断推理单选基准 60s 不受影响；多选 ×1.4', () => {
  // 常识多选：24 × 1.4 × 1.15 ≈ 38.6 → 39s
  const r = computeSuggested([{ chapter: '常识判断', type: 2, difficulty: 9 }]);
  assert.equal(r.seconds, Math.round(24 * 1.4 * 1.15));
  // 判断推理单选：60 × 1 × 1 = 60s
  const r2 = computeSuggested([{ chapter: '判断推理', type: 1, difficulty: 5 }]);
  assert.equal(r2.seconds, 60);
});

test('章节变体映射：选词填空→言语（60s）、图形推理→判断（60s）、定义判断→判断', () => {
  for (const ch of ['选词填空', '阅读理解', '言语理解']) {
    const r = computeSuggested([{ chapter: ch, type: 1, difficulty: 5 }]);
    assert.equal(r.seconds, 60, `${ch} 应归言语 60s`);
  }
  for (const ch of ['图形推理', '定义判断', '类比推理', '逻辑判断', '判断推理']) {
    const r = computeSuggested([{ chapter: ch, type: 1, difficulty: 5 }]);
    assert.equal(r.seconds, 60, `${ch} 应归判断 60s`);
  }
});

test('兜底与跳过：未知章节按题型兜底（判断 45×0.75≈34s）；申论题（type≥20）不估算', () => {
  const r = computeSuggested([{ chapter: '某陌生章节', type: 3, difficulty: 5 }]);
  assert.equal(r.seconds, Math.round(45 * 0.75));
  const r2 = computeSuggested([{ chapter: '', type: 1, difficulty: 5 }]);
  assert.equal(r2.seconds, 60);
  const r3 = computeSuggested([{ chapter: '申论材料', type: 21, difficulty: 5 }]);
  assert.equal(r3, null);
  const r4 = computeSuggested([]);
  assert.equal(r4, null);
});

test('混合真实感样例：言语 15 道（平均难度偏难）+ 数量 3 道（难度 8）', () => {
  const qs = [
    ...Array.from({ length: 15 }, () => ({ chapter: '言语理解与表达', type: 1, difficulty: 7 })),
    ...Array.from({ length: 3 }, () => ({ chapter: '数量关系', type: 1, difficulty: 8 })),
  ];
  const r = computeSuggested(qs);
  const expect = 15 * 60 * suggestDifficultyFactor(7) + 3 * 78 * suggestDifficultyFactor(8);
  assert.equal(r.seconds, Math.round(expect));
  assert.equal(r.label, '难度偏难');
});