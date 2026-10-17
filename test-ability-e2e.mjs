// test-ability-e2e.mjs — Task 8：本地模式端到端冒烟（AI 能力诊断：能力矩阵 → leaf 出题 → AI 诊断 全链）
// 无服务器全链：createLocalHandler + 真实 app-assets/tiku_app.db（只读 DatabaseSync）+ 内存 store + mock ai.diagnose。
// 需要先 node build-app-assets.mjs（tiku_app.db 是构建产物、不入 git）。
// 运行：node --test test-ability-e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi } from './lib/local-queries.mjs';
import { createLocalHandler } from './public/local-handler.js';
import { classifyLeaf } from './lib/leaf-classifier.mjs';

// 用真实题库建本地引擎（app-assets/tiku_app.db 需先 node build-app-assets.mjs）
const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const engine = { get: (s, ...p) => db.prepare(s).get(...p), all: (s, ...p) => db.prepare(s).all(...p) };
const qapi = createLocalApi(engine, engine, {});

// 取真实 qid 拼记录：判断推理·图形推理 若干错题 + 言语理解与表达 若干作对
// （qid 用 SELECT question_id FROM question_categories WHERE category='判断推理' AND sub='图形推理' 等取；
//   每条记录 subject 取 qc 行真实 subject，保证 diagnose 的 qcMap(qid|subject) 命中 sub='图形推理'）
const CUR = Date.now();
const mk = (qid, subKey, ok, subject = '公务员·行测') => ({ question_id: qid, sub_key: subKey, subject, is_correct: ok, archived: 0, created_at: CUR });

function pickLeafCandidates() {
  const rows = engine.all(`SELECT qc.question_id qid, qc.subject subject, q.content, q.analysis, q.options, q.answerIndex
    FROM question_categories qc
    JOIN questions q ON q.questionId = qc.question_id
    WHERE qc.category = '判断推理' AND qc.sub = '图形推理'
      AND qc.subject IN ('公务员·行测', '事业编·职测')
      AND q.content != '' AND q.analysis IS NOT NULL AND q.answerIndex IS NOT NULL AND q.answerIndex >= 0
    GROUP BY qc.question_id, qc.subject`);
  const seen = new Set();
  const hits = [];
  for (const r of rows) {
    const key = `${r.qid}|${r.subject}`;
    if (seen.has(key)) continue;
    // 预检：只有 classifyLeaf 命中 '笔画数' 的题才可作错题记录，否则诊断 prompt 的细分标签断言无保证
    if (classifyLeaf({ sub: '图形推理', content: r.content, analysis: r.analysis }) !== '笔画数') continue;
    seen.add(key);
    hits.push(r);
  }
  assert.ok(hits.length >= 6, `需至少 6 道 判断推理·图形推理 题命中 笔画数 细分标签（实际 ${hits.length}）`);
  return hits;
}

function pickYanyuCorrect() {
  const rows = engine.all(`SELECT qc.question_id qid, qc.subject subject
    FROM question_categories qc
    WHERE qc.category = '言语理解与表达' AND qc.subject IN ('公务员·行测', '事业编·职测')
    GROUP BY qc.question_id, qc.subject LIMIT 5`);
  assert.equal(rows.length, 5, '言语理解与表达 应有真实 qid 可作正确题记录');
  return rows;
}

test('本地模式 e2e：能力矩阵 → leaf 出题 → AI 诊断 全链', async () => {
  // 1. 预置内存 store：判断推理 1 对 5 错（全为 笔画数 题）+ 言语理解与表达 5 对，覆盖 ≥2 大模块
  const bh = pickLeafCandidates();
  const records = bh.slice(0, 6).map((r, i) => {
    const opts = JSON.parse(r.options || '[]');
    const isCorrect = i === 0 ? 1 : 0; // 判断推理整体压到达标线下：5 错 1 对
    const aIdx = r.answerIndex;
    const selected = [isCorrect === 1 ? aIdx : (opts.length > 1 ? (aIdx + 1) % opts.length : 0)];
    return { ...mk(r.qid, '判断推理', isCorrect, r.subject), selected };
  });
  for (const r of pickYanyuCorrect()) records.push({ ...mk(r.qid, '言语理解与表达', 1, r.subject), selected: [0] });

  let captured = null;
  const fakeAi = { diagnose: async (prompt) => { captured = prompt; return { content: 'ok', model: 'm' }; } };
  const store = { getAll: async (k) => (k === 'records' ? records : []) };
  const handler = createLocalHandler({ query: qapi, records: null, store, ai: fakeAi });

  // 2. 能力矩阵：各模块 rate/line/met 手工核对
  const ability = await handler('api/ability?target=0.72&exam=fujian', { method: 'GET' });
  assert.equal(ability.groups.length, 6);
  const covered = ability.groups.filter((g) => g.total > 0).length;
  assert.ok(covered >= 2, `应覆盖 ≥2 大模块（实际 ${covered}）`);
  const jt = ability.groups.find((g) => g.group === '判断推理');
  assert.ok(jt.total >= 5, `判断推理 做题量 ≥5 才有 enough（实际 ${jt.total}）`);
  assert.equal(jt.enough, true);
  assert.ok(jt.rate < jt.line, `判断推理 应在达标线下（rate=${jt.rate} < line=${jt.line}）`);
  assert.equal(jt.met, false);
  const yy = ability.groups.find((g) => g.group === '言语理解与表达');
  assert.ok(yy.total >= 5 && yy.rate >= yy.line, `言语理解与表达 应达标（rate=${yy.rate} >= line=${yy.line}）`);
  assert.equal(yy.met, true);

  // 3. leaf 出题：n=8 请求，返回的每道题都必须命中 笔画数 细分标签（ORDER BY RANDOM → 极小概率抽空，重试兜底）
  let practice = [];
  for (let i = 0; i < 5 && practice.length === 0; i++) {
    practice = await handler('api/practice?subject=公务员·行测&group=判断推理&sub=图形推理&leaf=笔画数&n=8', { method: 'GET' });
  }
  assert.ok(practice.length > 0, 'leaf=笔画数 应返回题目');
  for (const q of practice) {
    assert.equal(
      classifyLeaf({ sub: '图形推理', content: q.content || '', analysis: q.analysis || '' }),
      '笔画数',
      `leaf 过滤契约：返回题必须命中 笔画数（qid=${q.id}）`
    );
  }

  // 4. mock ai.diagnose 收下 prompt；诊断返回 content 非空；prompt 文本含细分标签 笔画数
  const diag = await handler('api/ai/diagnose', { method: 'POST', body: JSON.stringify({ target: 0.72, exam: 'fujian' }) });
  assert.equal(diag.content, 'ok');
  assert.equal(diag.model, 'm');
  assert.ok(captured && typeof captured === 'string' && captured.length > 0, '诊断 payload 应已组装为 prompt 文本');
  assert.ok(captured.includes('判断推理'), 'prompt 应含薄弱模块名');
  assert.ok(captured.includes('笔画数'), 'prompt 应含未达标模块错题的细分标签 笔画数');
  assert.ok(captured.includes('未达标') && captured.includes('我答'), 'prompt 应为能力诊断格式（矩阵摘要+错题清单）');
});
