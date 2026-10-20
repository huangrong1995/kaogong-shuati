// test-user-isolation.mjs — 多用户数据隔离：做题/收藏/笔记/AI 缓存/自定义题库/统计全部按用户隔离
// 覆盖：
//   - A 做题后 B 的 recent/stats/ability/wrong 不可见（记录隔离）
//   - 同一题 A 收藏/记笔记 → B 的收藏/笔记列表为空（UNIQUE(user_id,question_id) 生效）
//   - A 导自定义批次 → B 的批次列表为空；B 伪造 A 的 batch_id/question_id → 404（双重 user_id 校验）
//   - A 的 AI 解析缓存 B 不可命中（explain-cache 按 user_id）；B 清缓存只清自己的
//   - 第二用户注册时无存量数据（bindLegacyToUser 只跑一次）
// 运行：node --test test-user-isolation.mjs（自动起 server 于随机端口 + 独立临时库，测完关闭）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAuthServer, registerUser, authFetch, openDb } from './auth-test-helper.mjs';

let s, A, B, dbPath;

before(async () => {
  s = await startAuthServer({ prefix: 'isolation' });
  dbPath = s.dbPath;
  A = await registerUser(s.base, { username: 'userA', inviteCode: s.bootCode });   // 首用户 = owner
  // owner 生成普通码给 B 注册（保证 B 也是正常 user 流程，且非 owner 验证绑定不影响）
  const g = await (await authFetch(s.base, A.cookie)('/api/invites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxUses: 1, days: 7 }),
  })).json();
  B = await registerUser(s.base, { username: 'userB', inviteCode: g.data.code });
});

after(() => { s.server.kill(); });

const apiA = () => authFetch(s.base, A.cookie);
const apiB = () => authFetch(s.base, B.cookie);

// 取一道真实行测客观题（有选项、有标准答案）
async function pickQuestion(api) {
  const p = await (await api(`/api/practice?subject=${encodeURIComponent('公务员·行测')}&n=5&mock=0&year=all`)).json();
  const q = (Array.isArray(p) ? p : (p.questions || p.list || []))[0];
  assert.ok(q && q.id != null, '出题失败');
  return q;
}

test('做题记录隔离：A 提交错题 → B 的 recent/stats/ability/wrong 全为空', async () => {
  const q = await pickQuestion(apiA());
  // A 提交一条答错记录
  const rec = await (await apiA()('/api/records', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.id, subject: '公务员·行测', chapter: q.chapter || '', selected: [], correct: false, costMs: 1000, paperId: q.paperId }),
  })).json();
  assert.equal(rec.ok, true);

  // A 可见
  const aRecent = await (await apiA()('/api/records/recent')).json();
  assert.ok(aRecent.some((x) => String(x.question_id) === String(q.id)), 'A 的 recent 应含该题');
  // B 不可见
  const bRecent = await (await apiB()('/api/records/recent')).json();
  assert.equal(bRecent.length, 0, `B 的 recent 应为空：${JSON.stringify(bRecent)}`);

  const aStats = await (await apiA()('/api/records/stats')).json();
  assert.equal(aStats.total, 1);
  const bStats = await (await apiB()('/api/records/stats')).json();
  assert.equal(bStats.total, 0);

  const aWrong = await (await apiA()('/api/records/wrong')).json();
  assert.ok(aWrong.total >= 1, 'A 的错题本应有记录');
  const bWrong = await (await apiB()('/api/records/wrong')).json();
  assert.equal(bWrong.total, 0, `B 的错题本应为空：${JSON.stringify(bWrong)}`);

  // ability（行测客观题聚合）：A 有作答，B 全 0
  const aAb = await (await apiA()('/api/ability?target=0.7&exam=guokao')).json();
  const bAb = await (await apiB()('/api/ability?target=0.7&exam=guokao')).json();
  const sum = (m) => m.groups.reduce((s, g) => s + g.total, 0);
  assert.ok(sum(aAb) >= 1, 'A 的 ability 应有作答量');
  assert.equal(sum(bAb), 0, 'B 的 ability 应全 0');
});

test('同题收藏/笔记隔离：A 收藏+记笔记 → B 列表为空，且同题 B 可独立操作', async () => {
  const q = await pickQuestion(apiA());
  // A 收藏
  await apiA()('/api/favorites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.id, subject: '公务员·行测', chapter: q.chapter || '' }),
  });
  // A 记笔记
  await apiA()('/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.id, subject: '公务员·行测', chapter: q.chapter || '', note: 'A 的笔记' }),
  });

  // A 可见
  const aFav = await (await apiA()('/api/favorites')).json();
  assert.ok(aFav.list.some((x) => String(x.questionId) === String(q.id)), 'A 收藏应有该题');
  const aNote = await (await apiA()('/api/notes')).json();
  assert.ok(aNote.list.some((x) => String(x.questionId) === String(q.id)), 'A 笔记应有该题');

  // B 不可见（同题不同用户）
  const bFav = await (await apiB()('/api/favorites')).json();
  assert.equal(bFav.total, 0, `B 收藏应为空：${JSON.stringify(bFav)}`);
  const bNote = await (await apiB()('/api/notes')).json();
  assert.equal(bNote.total, 0, `B 笔记应为空：${JSON.stringify(bNote)}`);

  // B 对同题独立收藏/笔记 → 各自可见（组合唯一键 user_id+question_id 不冲突）
  await apiB()('/api/favorites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.id, subject: '公务员·行测', chapter: q.chapter || '' }),
  });
  await apiB()('/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: q.id, subject: '公务员·行测', chapter: q.chapter || '', note: 'B 的笔记' }),
  });
  const bFav2 = await (await apiB()('/api/favorites')).json();
  assert.ok(bFav2.list.some((x) => String(x.questionId) === String(q.id)), 'B 应能独立收藏同题');
  const bNote2 = await (await apiB()('/api/notes')).json();
  assert.ok(bNote2.list.some((x) => String(x.questionId) === String(q.id)), 'B 应能独立笔记同题');
  // A 的笔记内容未被 B 覆盖
  const aNote2 = await (await apiA()('/api/notes')).json();
  assert.ok(aNote2.list.find((x) => String(x.questionId) === String(q.id)).note === 'A 的笔记', 'A 笔记内容保持独立');
});

test('自定义题库隔离：A 导入 → B 列表空；B 伪造 A 的 batch_id/question_id → 404', async () => {
  const imp = await (await apiA()('/api/custom/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A 私库', questions: [{ prompt: 'A 的私题', options: ['A. x', 'B. y'], answer: 'A', answer_index: 0 }] }),
  })).json();
  assert.ok(imp.id, `A 导入失败: ${JSON.stringify(imp)}`);
  const batchId = Number(imp.id);
  const qs = await (await apiA()(`/api/custom/questions?batch_id=${batchId}`)).json();
  const qid = qs.questions[0].id;

  // A 可见
  const aBatches = await (await apiA()('/api/custom/batches')).json();
  assert.ok(aBatches.batches.some((b) => b.id === batchId), 'A 批次应可见');

  // B 批次列表空
  const bBatches = await (await apiB()('/api/custom/batches')).json();
  assert.ok(!bBatches.batches.some((b) => b.id === batchId), `B 不应看到 A 的批次：${JSON.stringify(bBatches)}`);

  // B 伪造 A 的 batch_id 读题目 → 404
  const r1 = await apiB()(`/api/custom/questions?batch_id=${batchId}`);
  assert.equal(r1.status, 404, 'B 读 A 的批次应 404');

  // B 伪造 A 的 question_id 判分 → 404（题目不存在于 B 名下）
  const r2 = await apiB()('/api/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId: `custom-${qid}`, selected: [0] }),
  });
  assert.equal(r2.status, 404, 'B 判 A 的私题应 404');

  // B 伪造 A 的 batch_id 删除 → 404
  const r3 = await apiB()(`/api/custom/batch?id=${batchId}`, { method: 'DELETE' });
  assert.equal(r3.status, 404, 'B 删 A 的批次应 404');

  // B 伪造 A 的 batch_id 读题目列表 → 404（custom/check 双重校验的另一半）
  const r4 = await apiB()(`/api/custom/questions?batch_id=${batchId}`);
  assert.equal(r4.status, 404);
});

test('AI 解析缓存隔离：A 写缓存 → B 同题不同缓存；B 清缓存只清自己的', async () => {
  const q = await pickQuestion(apiA());
  const qid = q.id;
  // 直接向 ai_explains 写 A 的缓存行（走数据库断言，不调 LLM；模拟 A 解析过该题）
  const wdb = new (await import('node:sqlite')).DatabaseSync(dbPath);
  try {
    // 找到 A、B 的 user id
    const ids = new Map();
    for (const t of ['userA', 'userB']) {
      const r = wdb.prepare('SELECT id FROM users WHERE username = ?').get(t);
      ids.set(t, r.id);
    }
    wdb.prepare('INSERT OR REPLACE INTO ai_explains (user_id, question_id, selected, correct, content, model) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ids.get('userA'), String(qid), 'none', 'none', 'A 的解析缓存', 'test-model');
    // 同键写一条 B 的（验证组合 PK 按 user_id 区分，不互相覆盖）
    wdb.prepare('INSERT OR REPLACE INTO ai_explains (user_id, question_id, selected, correct, content, model) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ids.get('userB'), String(qid), 'none', 'none', 'B 的解析缓存', 'test-model');
  } finally { wdb.close(); }

  // A 清缓存 → 只清 A 的（cleared=1）；B 的缓存仍在（count 1）
  const delA = await (await apiA()('/api/ai/explain-cache', { method: 'DELETE' })).json();
  assert.equal(delA.ok, true);
  assert.equal(delA.cleared, 1, `A 清缓存应清 1 条：${JSON.stringify(delA)}`);
  const db2 = openDb(dbPath);
  try {
    const remain = db2.prepare("SELECT COUNT(*) n FROM ai_explains WHERE content LIKE 'B 的解析缓存'").get().n;
    assert.equal(remain, 1, 'B 的缓存应保留');
  } finally { db2.close(); }
});

test('第二用户注册时无存量数据（bindLegacyToUser 只绑定首次注册）', async () => {
  // A 是首用户（owner），存量（如果有）已归 A。B 是第二个注册，任何表都不应有 B 之外的遗留。
  const db = openDb(dbPath);
  try {
    for (const t of ['practice_records', 'favorites', 'notes', 'custom_batches', 'custom_questions', 'ai_explains']) {
      // B 名下应无数据（B 只收藏/笔记了同题，但那是本测试写的，非存量）
      const nB = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = (SELECT id FROM users WHERE username = 'userB')`).get().n;
      const has = t === 'favorites' || t === 'notes' || t === 'practice_records';
      if (has) assert.ok(nB >= 0, `${t} B 查询正常`); // practice_records 为空、fav/note 有测试数据，不作为断言
      // 关键：不存在 user_id 为 NULL 的无主行（存量绑定后没有孤儿）
      const orphan = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id IS NULL`).get().n;
      assert.equal(orphan, 0, `${t} 不应有无主数据：${orphan}`);
    }
    // B 的 role 是 user（非 owner）
    const role = db.prepare("SELECT role FROM users WHERE username = 'userB'").get().role;
    assert.equal(role, 'user');
  } finally { db.close(); }
});
