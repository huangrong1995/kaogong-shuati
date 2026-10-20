// test-migration.mjs — 存量迁移：旧 schema practice.db（无 user_id / 无 users 表）启动迁移
// 覆盖：
//   - 预置旧表数据 → 启动 server → 自动加 user_id 列 / 重建 favorites・notes・ai_explains / 建 users・invites・sessions
//   - 首用户注册 → 六表存量全部绑定 owner（user_id IS NULL → owner.id）；第二用户全空
//   - 重启（同一库）不重复迁移：无 orphan 行、无数据丢失、bootstrap 不再重新生成
// 运行：node --test test-migration.mjs（独立临时库，测完关闭）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { makeTempDb, startAuthServer, registerUser, authFetch, openDb } from './auth-test-helper.mjs';

let dbPath, s, owner, server2;

// 预置一个"旧版本" practice.db：只有六张用户表（无 user_id / 无 users / 无 invites / 无 sessions），
// 外加派生索引表与 materials，模拟账号体系上线前的库。
async function seedLegacyDb(path) {
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE practice_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      paper_id INTEGER DEFAULT NULL,
      subject TEXT NOT NULL,
      chapter TEXT NOT NULL DEFAULT '',
      question_type INTEGER DEFAULT 0,
      selected TEXT DEFAULT '',
      is_correct INTEGER,
      cost_ms INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      group_key TEXT DEFAULT '',
      sub_key TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL UNIQUE,
      subject TEXT DEFAULT '',
      chapter TEXT DEFAULT '',
      group_key TEXT DEFAULT '',
      sub_key TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL UNIQUE,
      subject TEXT DEFAULT '',
      chapter TEXT DEFAULT '',
      note TEXT DEFAULT '',
      group_key TEXT DEFAULT '',
      sub_key TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE custom_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT DEFAULT '自定义',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE custom_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      material TEXT DEFAULT '',
      options TEXT DEFAULT '[]',
      answer TEXT DEFAULT '',
      answer_index INTEGER DEFAULT -1,
      analysis TEXT DEFAULT ''
    );
    CREATE TABLE ai_explains (
      question_id INTEGER NOT NULL,
      selected TEXT NOT NULL DEFAULT 'none',
      correct TEXT NOT NULL DEFAULT 'none',
      content TEXT NOT NULL,
      image_note TEXT,
      model TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (question_id, selected, correct)
    );
    CREATE TABLE materials (
      paper_id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      name TEXT DEFAULT '',
      text TEXT NOT NULL,
      pages INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  // 存量数据：一条做错记录、一条收藏、一条笔记、一个自定义批次+题、一条 AI 缓存
  d.prepare("INSERT INTO practice_records (question_id, subject, chapter, is_correct, cost_ms) VALUES (12345, '公务员·行测', '判断推理', 0, 500)").run();
  d.prepare("INSERT INTO favorites (question_id, subject, chapter) VALUES (12345, '公务员·行测', '判断推理')").run();
  d.prepare("INSERT INTO notes (question_id, subject, chapter, note) VALUES ('12345', '公务员·行测', '判断推理', '旧笔记')").run();
  const b = d.prepare("INSERT INTO custom_batches (name, subject) VALUES ('旧批次', '自定义')").run();
  const bid = Number(b.lastInsertRowid);
  d.prepare("INSERT INTO custom_questions (batch_id, prompt, options, answer, answer_index) VALUES (?, '旧自定义题', '[\"A. x\",\"B. y\"]', 'A', 0)").run(bid);
  d.prepare("INSERT INTO ai_explains (question_id, selected, correct, content) VALUES (12345, 'none', 'false', '旧解析缓存')").run();
  d.close();
}

test('旧库迁移 → 首用户注册绑定存量 → 第二用户空 → 重启不重迁移', async () => {
  // 1. 预置旧库
  dbPath = makeTempDb('migration');
  await seedLegacyDb(dbPath);

  // 2. 启动 server（PRACTICE_DB 指向旧库）→ 自动迁移 + 生成 bootstrap 码
  s = await startAuthServer({ prefix: 'migration', dbPath });

  // 3. 首用户注册 → 存量绑定 owner
  owner = await registerUser(s.base, { username: 'migowner', inviteCode: s.bootCode });
  assert.equal(owner.user.role, 'owner');
  const api = authFetch(s.base, owner.cookie);

  // 4. 断言六表存量绑定 owner（无 orphan）
  const db = openDb(s.dbPath);
  try {
    const orphan = db.prepare(`
      SELECT (SELECT COUNT(*) FROM practice_records WHERE user_id IS NULL)
           + (SELECT COUNT(*) FROM favorites WHERE user_id IS NULL)
           + (SELECT COUNT(*) FROM notes WHERE user_id IS NULL)
           + (SELECT COUNT(*) FROM custom_batches WHERE user_id IS NULL)
           + (SELECT COUNT(*) FROM custom_questions WHERE user_id IS NULL)
           + (SELECT COUNT(*) FROM ai_explains WHERE user_id IS NULL) AS n`).get().n;
    assert.equal(orphan, 0, `存量应全部绑定 owner，仍有无主 ${orphan} 条`);
    const uid = db.prepare("SELECT id FROM users WHERE username = 'migowner'").get().id;
    const recN = db.prepare('SELECT COUNT(*) n FROM practice_records WHERE user_id = ?').get(uid).n;
    assert.equal(recN, 1, 'practice_records 存量应绑定 owner');
    const favN = db.prepare('SELECT COUNT(*) n FROM favorites WHERE user_id = ?').get(uid).n;
    assert.equal(favN, 1, 'favorites 存量应绑定 owner');
    const noteN = db.prepare('SELECT COUNT(*) n FROM notes WHERE user_id = ?').get(uid).n;
    assert.equal(noteN, 1, 'notes 存量应绑定 owner');
    const batchN = db.prepare('SELECT COUNT(*) n FROM custom_batches WHERE user_id = ?').get(uid).n;
    assert.equal(batchN, 1, 'custom_batches 存量应绑定 owner');
    const qN = db.prepare('SELECT COUNT(*) n FROM custom_questions WHERE user_id = ?').get(uid).n;
    assert.equal(qN, 1, 'custom_questions 存量应绑定 owner');
    const aiN = db.prepare('SELECT COUNT(*) n FROM ai_explains WHERE user_id = ?').get(uid).n;
    assert.equal(aiN, 1, 'ai_explains 存量应绑定 owner');
  } finally { db.close(); }

  // 5. 业务端点可见存量（owner 视角）
  const wrong = await (await api('/api/records/wrong')).json();
  assert.ok(wrong.list.some((x) => String(x.questionId) === '12345'), 'owner 应看到旧错题');
  const notes = await (await api('/api/notes')).json();
  assert.ok(notes.list.some((x) => x.note === '旧笔记'), 'owner 应看到旧笔记');
  const fav = await (await api('/api/favorites')).json();
  assert.ok(fav.list.some((x) => String(x.questionId) === '12345'), 'owner 应看到旧收藏');

  // 6. 第二用户注册 → 全空（无存量）
  const g = await (await api('/api/invites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxUses: 1, days: 7 }),
  })).json();
  const second = await registerUser(s.base, { username: 'miguser2', inviteCode: g.data.code });
  assert.equal(second.user.role, 'user');
  const api2 = authFetch(s.base, second.cookie);
  const r2wrong = await (await api2('/api/records/wrong')).json();
  assert.equal(r2wrong.total, 0, '第二用户应无存量错题');
  const r2notes = await (await api2('/api/notes')).json();
  assert.equal(r2notes.total, 0, '第二用户应无存量笔记');
  const r2batches = await (await api2('/api/custom/batches')).json();
  assert.equal(r2batches.batches.length, 0, '第二用户应无存量批次');

  // 7. 重启（同库）→ 不重复迁移：数据仍在、无 orphan、users 数量不变、bootstrap 不再新增
  s.server.kill();
  await new Promise((r) => setTimeout(r, 300));
  const s2 = await startAuthServer({ prefix: 'migration-restart', dbPath });
  server2 = s2.server;
  const base2 = s2.base;
  assert.ok(base2, '重启 server 应就绪');

  // 重启后：owner 会话仍有效（sessions 持久化）、数据未丢、无 orphan、用户数不变
  const ownerApi = authFetch(base2, owner.cookie);
  const me = await (await ownerApi('/api/auth/me')).json();
  assert.equal(me.data.user.username, 'migowner', '重启后 owner 会话应仍有效');
  const wrong2 = await (await ownerApi('/api/records/wrong')).json();
  assert.ok(wrong2.list.some((x) => String(x.questionId) === '12345'), '重启后旧错题仍在');

  const db3 = openDb(s.dbPath);
  try {
    const usersN = db3.prepare('SELECT COUNT(*) n FROM users').get().n;
    assert.equal(usersN, 2, '重启后用户数不变（应为 2）');
    const orphan2 = db3.prepare('SELECT COUNT(*) n FROM practice_records WHERE user_id IS NULL').get().n;
    assert.equal(orphan2, 0, '重启后无 orphan 记录');
    const bootN = db3.prepare('SELECT COUNT(*) n FROM invites WHERE bootstrap = 1 AND used_count = 0').get().n;
    assert.equal(bootN, 0, '重启后不应再生 bootstrap 码（已有用户）');
    // 六表各一行且属于 owner
    const uid = db3.prepare("SELECT id FROM users WHERE username = 'migowner'").get().id;
    for (const t of ['practice_records', 'favorites', 'notes', 'custom_batches', 'custom_questions', 'ai_explains']) {
      const n = db3.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).get(uid).n;
      assert.equal(n, 1, `${t} 重启后应仍有 1 行归 owner`);
    }
  } finally { db3.close(); }
});

after(async () => {
  s?.server?.kill();
  if (server2) server2.kill();
  const { rmSync } = await import('node:fs');
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
});
