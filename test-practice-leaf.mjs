// test-practice-leaf.mjs — Task 6：/api/practice 与本地 practice() 的细分考点 leaf 过滤
// 运行：node --test test-practice-leaf.mjs
// 本地矩阵部分需要 app-assets/tiku_app.db（跑测试前先 node build-app-assets.mjs）；server 冒烟为只读 GET。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi } from './lib/local-queries.mjs';
import { classifyLeaf } from './lib/leaf-classifier.mjs';

const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const engine = { get: (s, ...p) => db.prepare(s).get(...p), all: (s, ...p) => db.prepare(s).all(...p) };
const api = createLocalApi(engine, engine, {});

test('本地 practice(leaf)：仅返回命中该细分的题，且回放可命中', () => {
  const qs = api.practice('公务员·行测', { group: '判断推理', sub: '图形推理', leaf: '笔画数', n: 8 });
  for (const q of qs) {
    const t = q.content || ''; const a = q.analysis || '';
    assert.equal(classifyLeaf({ sub: '图形推理', content: t, analysis: a }), '笔画数');
  }
  assert.ok(qs.length >= 1, `图推·笔画数至少 1 题（实际 ${qs.length}）`);
});
test('本地 practice(leaf)：未命中返回空数组不抛错', () => {
  const qs = api.practice('公务员·行测', { group: '判断推理', sub: '图形推理', leaf: '不存在的考点', n: 8 });
  assert.deepEqual(qs, []);
});
// Important #1 回归：模块级「针对性训练」缺省 sub → 两端都应视为 '全部' 而非 [] / 抛错
test('本地 practice(group 无 sub)：缺省 sub 视为全部，返回组题不抛错', () => {
  const qs = api.practice('公务员·行测', { group: '判断推理', n: 8 });
  assert.ok(qs.length >= 1, `判断推理（无 sub）至少 1 题（实际 ${qs.length}）`);
});

// ---------- server /api/practice leaf 冒烟（只读 GET，不写 practice.db） ----------
import { spawn } from 'node:child_process';
import net from 'node:net';

async function pickFreePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 5600 + Math.floor(Math.random() * 800);
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(port, () => s.close(() => res(true)));
    });
    if (free) return port;
  }
  throw new Error('无法分配空闲测试端口');
}

async function withServer(fn) {
  const port = await pickFreePort();
  const srv = spawn(process.execPath, ['server.mjs', String(port)], {
    stdio: 'ignore',
    env: { ...process.env, AI_CONFIG_DB: `/tmp/practice-leaf-${Date.now()}-${Math.random().toString(36).slice(2)}.db` },
  });
  let exited = false;
  const exitedP = new Promise((res) => srv.once('exit', () => { exited = true; res(); }));
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch {}
      if (exited) break; // 子进程已退出（如端口冲突）→ 别再空等
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn(port);
  } finally {
    srv.kill();
    await exitedP; // 等子进程真正退出释放端口
  }
}

const Q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

test('server /api/practice?leaf=笔画数：逐题复核命中该细分，且至少 1 题', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/api/practice?${Q({
      subject: '公务员·行测', group: '判断推理', sub: '图形推理', leaf: '笔画数', n: 8,
    })}`);
    assert.equal(res.status, 200);
    const qs = await res.json();
    assert.ok(Array.isArray(qs) && qs.length >= 1, `server 笔画数至少 1 题（实际 ${qs.length}）`);
    for (const q of qs) {
      assert.equal(classifyLeaf({ sub: '图形推理', content: q.content || '', analysis: q.analysis || '' }), '笔画数');
    }
  });
});

test('server /api/practice?leaf=不存在的考点：返回空数组', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/api/practice?${Q({
      subject: '公务员·行测', group: '判断推理', sub: '图形推理', leaf: '不存在的考点', n: 8,
    })}`);
    assert.equal(res.status, 200);
    const qs = await res.json();
    assert.deepEqual(qs, []);
  });
});

test('server /api/practice 无 sub 参数：缺省视为 全部，返回组题', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/api/practice?${Q({
      subject: '公务员·行测', group: '判断推理', n: 5,
    })}`);
    assert.equal(res.status, 200);
    const qs = await res.json();
    assert.ok(Array.isArray(qs) && qs.length >= 1, `server 判断推理（无 sub）至少 1 题（实际 ${qs.length}）`);
  });
});
