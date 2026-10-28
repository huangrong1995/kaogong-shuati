/**
 * suggest-time.js — 建议用时计算（刷题计时条旁"建议 X:XX"）
 *
 * 以国考行测 130 题 / 120 分钟为基准：官方模块题量 → 每模块建议耗时（分钟）→ 每题基准秒；
 * 逐题按 模块 × 题型权重 × 难度权重 加权累加，得到整卷建议用时。
 * 纯计算、无 DOM：浏览器（app.js 动态 import）与 Node 测试（test-suggest-time.mjs）共用。
 *
 * 计算口径：
 *   - 模块：question.chapter → mapChapterToNode().group 查基准表（复用 xingce-chapter-map.js，双端同源）
 *   - 题型：多选 ×1.4（勾选确认更耗时）、判断对错 ×0.75、单选 ×1.0
 *   - 难度：粉笔难度 1–9 线性缩放 —— 简单(1) ×0.85 最紧、偏难(9) ×1.15 最宽（估算现实耗时，非应试限时策略）
 *   - 归不了模块的客观题按题型兜底：单选 60s / 判断 45s；申论/综应等材料题（type≥20）不估算
 */

import { mapChapterToNode } from './xingce-chapter-map.js';

// 行测官方模块题量与建议耗时分配（合计 114 分钟，余 6 分钟给涂卡/检查缓冲）
const SUGGEST_MODULES = [
  { name: '政治理论', minutes: 10, count: 20 },
  { name: '常识判断', minutes: 6, count: 15 },
  { name: '言语理解与表达', minutes: 30, count: 30 },
  { name: '数量关系', minutes: 13, count: 10 },
  { name: '判断推理', minutes: 35, count: 35 },
  { name: '资料分析', minutes: 20, count: 20 },
];

/** 模块 → 每题基准秒（分钟×60/题量，取整） */
export const SUGGEST_MODULE_SEC = Object.fromEntries(
  SUGGEST_MODULES.map((m) => [m.name, Math.round((m.minutes * 60) / m.count)]),
);

/** 归不了模块的客观题按题型兜底的基准秒（其余类型一律 60） */
export const SUGGEST_TYPE_SEC = { 1: 60, 3: 45, 5: 45 };

/** 题型权重：多选勾选确认更耗时，判断对错更省时 */
export function suggestTypeFactor(type) {
  const t = Number(type);
  return t === 2 ? 1.4 : (t === 3 || t === 5 ? 0.75 : 1);
}

/**
 * 难度权重：粉笔难度 1–9 线性缩放（简单 0.85 → 偏难 1.15）。
 * 缺省/非法难度按 1.0（不缩放）。
 */
export function suggestDifficultyFactor(difficulty) {
  const d = Number(difficulty);
  if (!Number.isFinite(d) || d < 1) return 1;
  if (d >= 9) return 1.15;
  return 0.85 + ((d - 1) / 8) * 0.3; // 线性插值：d=1→0.85, d=5→1.0
}

/**
 * 整卷建议用时：逐题参考秒累加。
 * @param {Array<{chapter?: string, type?: number, difficulty?: number}>} questions 当前 quiz 的题目
 * @returns {{seconds: number, label: string}|null} 无法估算（空卷/全材料题）时返回 null
 */
export function computeSuggested(questions) {
  if (!Array.isArray(questions) || !questions.length) return null;
  let total = 0;
  let diffSum = 0;
  let diffN = 0;
  for (const q of questions) {
    const t = Number(q.type);
    // 申论/综应等材料题不做单题估算（这些题型本不显示计时条）
    if (t >= 20) continue;
    const node = q.chapter ? mapChapterToNode(String(q.chapter)) : null;
    const base = (node && SUGGEST_MODULE_SEC[node.group]) || SUGGEST_TYPE_SEC[t] || 60;
    const d = Number(q.difficulty);
    if (Number.isFinite(d) && d >= 1) { diffSum += d; diffN++; }
    total += base * suggestTypeFactor(t) * suggestDifficultyFactor(d);
  }
  if (!total) return null;
  let label = '';
  if (diffN) {
    const avg = diffSum / diffN;
    label = avg <= 3.5 ? '难度简单' : avg <= 6.5 ? '难度适中' : '难度偏难';
  }
  return { seconds: Math.round(total), label };
}