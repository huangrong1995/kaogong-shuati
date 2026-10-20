// test-auth.mjs — 账号体系：bootstrap 注册成 owner / 登录 / me / 注销 / 邀请码生命周期 / 会话过期
// 覆盖：
//   - 首用户用 bootstrap 码注册 → role=owner；未登录访问业务端点 401 LOGIN_REQUIRED
//   - 登录（统一错误 BAD_CREDENTIALS）/ me / logout（幂等）→ 退出后业务端点 401
//   - 邀请码：无效码注册失败 INVALID_INVITE；一次性码重复使用失败；owner 生成普通码 → 新用户注册成功且为 user 角色
//   - 非 owner 生成邀请码 → 403；bootstrap 码非 owner 侧不可用（已用过/被删）
//   - 会话过期：直接把 sessions 行 expires_at 改过去 → 业务端点 401（会话被清除）
// 运行：node --test test-auth.mjs（自动起 server 于随机端口 + 独立临时库，测完关闭）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startAuthServer, registerUser, loginUser, authFetch } from './auth-test-helper.mjs';

let s, owner, ownerApi, dbPath;

before(async () => {
  s = await startAuthServer({ prefix: 'auth' });
  dbPath = s.dbPath;
  owner = await registerUser(s.base, { username: 'owner1', inviteCode: s.bootCode });
  ownerApi = authFetch(s.base, owner.cookie);
});

after(() => { s.server.kill(); });

// ---------- 未登录 401 ----------
test('未登录访问业务端点 → 401 LOGIN_REQUIRED', async () => {
  const r = await fetch(s.base + '/api/subjects');
  assert.equal(r.status, 401);
  const b = await r.json();
  assert.equal(b.error, 'LOGIN_REQUIRED');
});

test('未登录访问受保护 auth 端点（me）→ 401', async () => {
  const r = await fetch(s.base + '/api/auth/me');
  assert.equal(r.status, 401);
});

// ---------- 注册成为 owner ----------
test('首用户用 bootstrap 码注册 → owner 角色 + Cookie + me 可读', async () => {
  assert.equal(owner.user.role, 'owner');
  assert.equal(owner.user.username, 'owner1');
  const r = await ownerApi('/api/auth/me');
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.data.user.id, owner.user.id);
  assert.equal(b.data.user.username, 'owner1');
  assert.equal(b.data.user.role, 'owner');
  assert.ok(b.data.user.createdAt, 'createdAt 应有值');
});

test('bootstrap 码已被用 → 第二次注册失败 INVALID_INVITE', async () => {
  const r = await fetch(s.base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner2', password: 'pass12345', inviteCode: s.bootCode }),
  });
  const b = await r.json();
  assert.equal(r.status, 200); // auth 端点失败为 200 + ok:false
  assert.equal(b.ok, false);
  assert.equal(b.error, 'INVALID_INVITE');
});

// ---------- 登录 / 统一错误 ----------
test('登录成功 → 新 Cookie + me 身份一致', async () => {
  const u = await loginUser(s.base, { username: 'owner1', password: 'pass12345' });
  assert.equal(u.user.username, 'owner1');
  assert.equal(u.user.role, 'owner');
  const me = await (await authFetch(s.base, u.cookie)('/api/auth/me')).json();
  assert.equal(me.data.user.id, owner.user.id);
});

test('错误密码 → 统一 BAD_CREDENTIALS（不泄露用户名是否存在）', async () => {
  for (const [u, p] of [['owner1', 'wrong-password'], ['nosuchuser', 'pass12345']]) {
    const r = await fetch(s.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    const b = await r.json();
    assert.equal(b.ok, false);
    assert.equal(b.error, 'BAD_CREDENTIALS');
    assert.equal(b.message, '用户名或密码错误');
  }
});

test('密码不足 8 位 → PASSWORD_WEAK', async () => {
  const r = await fetch(s.base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'weakpass', password: 'short', inviteCode: s.bootCode }),
  });
  const b = await r.json();
  assert.equal(b.ok, false);
  assert.equal(b.error, 'PASSWORD_WEAK');
});

// ---------- 注销 ----------
test('logout → 幂等 200；原 Cookie 失效 → 业务端点 401', async () => {
  // 用独立登录的会话测注销，避免注销掉共享的 ownerApi cookie
  const fresh = await loginUser(s.base, { username: 'owner1', password: 'pass12345' });
  const freshApi = authFetch(s.base, fresh.cookie);
  const r = await freshApi('/api/auth/logout', { method: 'POST' });
  assert.equal(r.status, 200);
  // 幂等：未登录也 200
  const r2 = await freshApi('/api/auth/logout', { method: 'POST' });
  assert.equal(r2.status, 200);
  // 旧 Cookie 已销毁
  const r3 = await freshApi('/api/auth/me');
  assert.equal(r3.status, 401);
});

// ---------- 邀请码生命周期（owner） ----------
test('owner 生成邀请码 → 新用户注册成功为 user 角色', async () => {
  const g = await ownerApi('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxUses: 1, days: 7 }) });
  const gb = await g.json();
  assert.equal(gb.ok, true);
  assert.ok(gb.data && gb.data.code, `应返回邀请码：${JSON.stringify(gb)}`);
  assert.equal(gb.data.maxUses, 1);

  const u2 = await registerUser(s.base, { username: 'user2', inviteCode: gb.data.code });
  assert.equal(u2.user.role, 'user');
  assert.notEqual(u2.user.id, owner.user.id);

  // 一次性码已被 user2 消耗 → 第三用户再用失败
  const r = await fetch(s.base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'user3', password: 'pass12345', inviteCode: gb.data.code }),
  });
  const b = await r.json();
  assert.equal(b.ok, false);
  assert.equal(b.error, 'INVALID_INVITE');
});

test('owner 生成多次数邀请码 → 可注册两次', async () => {
  const g = await ownerApi('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxUses: 2, days: 30 }) });
  const gb = await g.json();
  assert.equal(gb.data.maxUses, 2);
  await registerUser(s.base, { username: 'multi1', inviteCode: gb.data.code });
  await registerUser(s.base, { username: 'multi2', inviteCode: gb.data.code });
  const r = await fetch(s.base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'multi3', password: 'pass12345', inviteCode: gb.data.code }),
  });
  const b = await r.json();
  assert.equal(b.ok, false);
  assert.equal(b.error, 'INVALID_INVITE');
});

test('普通用户（非 owner）不能生成/查看/删除邀请码 → 403', async () => {
  const u2 = await loginUser(s.base, { username: 'user2', password: 'pass12345' });
  const api = authFetch(s.base, u2.cookie);
  for (const [p, opts] of [
    ['/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }],
    ['/api/invites', { method: 'GET' }],
    ['/api/invites/1', { method: 'DELETE' }],
  ]) {
    const r = await api(p, opts);
    assert.equal(r.status, 403, `${opts.method} ${p} 应 403`);
  }
});

test('invites/status 预检：有效码 true、无效码 false（公开端点）', async () => {
  const g = await ownerApi('/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxUses: 1, days: 1 }) });
  const gb = await g.json();
  const ok = await (await fetch(s.base + `/api/invites/status?code=${gb.data.code}`)).json();
  assert.equal(ok.valid, true);
  const bad = await (await fetch(s.base + `/api/invites/status?code=INVALID`)).json();
  assert.equal(bad.valid, false);
});

test('邀请码列表：owner 可见 bootstrap 码 + 生成的普通码', async () => {
  const r = await ownerApi('/api/invites');
  const rows = (await r.json()).data;
  assert.ok(Array.isArray(rows) && rows.length >= 2, `应有 bootstrap + 至少 1 个普通码：${rows.length}`);
  assert.ok(rows.some((x) => x.bootstrap === 1), 'bootstrap 码应在列表中');
});

// ---------- 会话过期 ----------
test('会话过期：sessions 行 expires_at 过期 → 业务端点 401 且会话被清除', async () => {
  const u = await loginUser(s.base, { username: 'multi1', password: 'pass12345' });
  // 可写句柄直接改 sessions（临时库；独立于只读断言句柄）
  const wdb = new (await import('node:sqlite')).DatabaseSync(dbPath);
  try {
    wdb.prepare("UPDATE sessions SET expires_at = datetime('now','localtime','-1 day') WHERE token_hash = ?")
      .run(crypto.createHash('sha256').update(u.sid).digest('hex'));
  } finally { wdb.close(); }
  const api = authFetch(s.base, u.cookie);
  const r = await api('/api/subjects');
  assert.equal(r.status, 401);
  const r2 = await api('/api/auth/me');
  assert.equal(r2.status, 401);
});
