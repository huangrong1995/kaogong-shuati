// test-wrong-dedupe.mjs — 错题本按题去重（2026-10-27）
// 复现：同一题重复做错 → 多条 is_correct=0 记录累积，错题本（待订正题目集合）应按题只显示一条。
// 覆盖（Web server.mjs 与 App public/local-api.js 双端同构）：
//   1. 重复做错同题 → wrong 列表只 1 条
//   2. wrong/groups 分组计数 = 列表条数（按题计，不按记录行计）
//   3. stats.wrong 按题去重
// 运行：node --test test-wrong-dedupe.mjs（自动起 server 于随机端口 + 独立临时库，测完关闭）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAuthServer, registerUser, authFetch } from './auth-test-helper.mjs';
import { createRecordsApi } from './public/local-api.js';

let server, base, cookie;
const cleanedRecords = [];

before(async () => {
  const s = await startAuthServer({ prefix: 'wrong-dedupe' });
  server = s.server; base = s.base;
  const { cookie: ck } = await registerUser(s.base, { username: 'dedupe_tester', inviteCode: s.bootCode });
  cookie = ck;
});

after(async () => {
  for (const qid of cleanedRecords) {
    try { await authFetch(base, cookie)(`/api/records/wrong`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: qid }) }); } catch {}
  }
  server?.kill();
});

const post = (path, body) => authFetch(base, cookie)(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

test('server：同一题重复做错 → 错题列表/分组计数/统计 全部按题去重', async () => {
  const p = await authFetch(base, cookie)(`/api/practice?subject=公务员·行测&n=5&mock=0&year=all`).then((r) => r.json());
  const qs = Array.isArray(p) ? p : (p.questions || p.list || []);
  assert.ok(qs.length > 0, '出题失败');
  const q = qs[0];
  cleanedRecords.push(q.id);
  // 同一题做错两次（错题记录不参与同日去重 → 会落两条行；错题本展示应合并为一条）
  const mk = (selected) => post('/api/records', { questionId: q.id, subject: '公务员·行测', chapter: q.chapter || '', type: q.type, selected, correct: false, costMs: 1000, paperId: q.paperId });
  await mk([]);
  await mk(['A']);
  // 1) 列表只一条
  const w = await authFetch(base, cookie)(`/api/records/wrong`).then((r) => r.json());
  const hits = (w.list || []).filter((x) => String(x.questionId) === String(q.id));
  assert.equal(hits.length, 1, `重复做错同题应只显示 1 条: ${JSON.stringify(w.list && w.list.slice(0, 3))}`);
  // 2) group 过滤列表 + 分组计数按题（count == 该模块列表去重条数）
  const inMod = await authFetch(base, cookie)(`/api/records/wrong?group=${encodeURIComponent('公务员·行测')}&limit=200`).then((r) => r.json());
  assert.equal(inMod.total, 1, `行测组列表应只 1 条（该题）: total=${inMod.total}, list=${JSON.stringify((inMod.list || []).map((x) => x.questionId))}`);
  const g = await authFetch(base, cookie)(`/api/records/wrong/groups`).then((r) => r.json());
  const xc = g.find((x) => x.key === '公务员·行测');
  assert.ok(xc, `应有行测组: ${JSON.stringify(g)}`);
  assert.equal(xc.count, inMod.total, `groups.count 应等于列表条数: count=${xc.count}, total=${inMod.total}`);
  // 3) stats.wrong 按题去重
  const st = await authFetch(base, cookie)(`/api/records/stats`).then((r) => r.json());
  assert.equal(st.wrong, 1, `stats.wrong 应按题去重: ${JSON.stringify(st)}`);
});

// ---- 本地端（App/IndexedDB，无 server） ----
function mockStore() {
  const tables = new Map();
  let seq = 1;
  return {
    async getAll(kind) { return [...(tables.get(kind) || new Map()).values()]; },
    async put(kind, row) { if (row.id == null) row.id = seq++; tables.get(kind) || tables.set(kind, new Map()); tables.get(kind).set(row.id, row); return row; },
    async deleteBy(kind, key, value) {
      const t = tables.get(kind);
      if (!t) return;
      for (const [id, row] of t) { if (row[key] === value) t.delete(id); }
    },
  };
}
// mock 题库引擎：classify（questions JOIN papers）→ 行测；题干查询 → 普通文本题
const localTiku = {
  get(sql, ...args) {
    if (sql.includes('JOIN papers')) return { paperId: 7, chapter: '判断推理', subjectName: '公务员·行测' };
    if (sql.includes('FROM questions')) return { questionId: args[0], type: 1, content: '本地错题去重测试题', contentHtml: '' };
    return null;
  },
  all() { return []; },
};

test('本地：同一题重复做错 → wrong 列表/分组计数/统计 全部按题去重', async () => {
  const store = mockStore();
  const records = createRecordsApi(store, localTiku);
  for (let i = 0; i < 2; i++) {
    await records.addRecord({ questionId: 6001, subject: '公务员·行测', chapter: '判断推理', correct: false, paperId: 7 });
  }
  const w = await records.wrong({ limit: 10 });
  assert.equal(w.total, 1, `本地 wrong 列表应只 1 条: ${JSON.stringify(w.list && w.list.map((x) => x.questionId))}`);
  const g = await records.groups('wrong');
  const xc = g.find((x) => x.key === '公务员·行测');
  assert.ok(xc, `本地应有行测组: ${JSON.stringify(g)}`);
  assert.equal(xc.count, 1, `本地 groups.count 应按题去重: count=${xc.count}`);
  const st = await records.stats();
  assert.equal(st.wrong, 1, `本地 stats.wrong 应按题去重: ${JSON.stringify(st)}`);
});