// auth-test-helper.mjs — 账号体系测试公共设施（Phase 4 测试改造）
// 提供：空闲端口探测、临时 practice.db/AI_CONFIG_DB 独立库、起真实 server、
//       从临时库读 bootstrap 码、注册用户拿 cookie、带 cookie 的 fetch 封装。
// 用法（node:test before 内）：
//   const s = await startAuthServer({ prefix: 'practice-leaf' });
//   const { cookie } = await registerUser(s.base, { username: 'tester', inviteCode: s.bootCode });
//   const api = authFetch(s.base, cookie); await api('/api/practice?...');
//   // after: await s.server.kill();
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** 探测空闲端口（避免与其它并行 server 撞号） */
export async function pickFreePort(min = 5200, max = 6800) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = min + Math.floor(Math.random() * (max - min));
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(port, () => s.close(() => res(true)));
    });
    if (free) return port;
  }
  throw new Error('无法分配空闲测试端口');
}

/** 生成唯一临时库路径（practice.db / AI 配置库各一个） */
export function makeTempDb(prefix) {
  return `/tmp/${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`;
}

/** 轮询等待 server 就绪；超时或子进程退出则抛错 */
export async function waitReady(base, server, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  server.once('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server 启动失败（子进程已退出）：${base}`);
    try { const r = await fetch(base + '/'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server 启动超时：${base}`);
}

/**
 * 起一个带独立 practice.db + AI 配置库的 server，并返回 bootstrap 码。
 * @param {object} [opts]
 * @param {string} [opts.prefix] 临时库文件前缀（默认 'auth'）
 * @param {number} [opts.port]   指定端口（默认自动探测）
 * @param {string} [opts.dbPath] 预先就绪的 practice.db 路径（如迁移测试的旧库种子；缺省自动新建临时库）
 */
export async function startAuthServer({ prefix = 'auth', port, dbPath } = {}) {
  const useExisting = !!dbPath;
  const finalDb = useExisting ? dbPath : makeTempDb(prefix);
  const aiPath = makeTempDb(prefix + '-ai');
  // 指定端口先探测，被占则退回空闲端口（node --test 多文件并行时防撞号）
  let chosenPort = port ?? (await pickFreePort());
  if (port) {
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(port, () => s.close(() => res(true)));
    });
    if (!free) chosenPort = await pickFreePort();
  }
  const srv = spawn(process.execPath, ['server.mjs', String(chosenPort)], {
    stdio: 'ignore',
    env: { ...process.env, PRACTICE_DB: finalDb, AI_CONFIG_DB: aiPath },
  });
  const base = `http://localhost:${chosenPort}`;
  try {
    await waitReady(base, srv);
  } catch (e) {
    srv.kill();
    throw e;
  }
  const db = new DatabaseSync(finalDb, { readOnly: true });
  const boot = db.prepare('SELECT code FROM invites WHERE bootstrap = 1 ORDER BY id LIMIT 1').get();
  db.close();
  if (!boot) { srv.kill(); throw new Error(`临时库 ${finalDb} 缺少 bootstrap 邀请码`); }
  return { base, dbPath: finalDb, aiPath, port: chosenPort, server: srv, bootCode: boot.code };
}

/**
 * 注册用户并返回 sid cookie（首个注册者为 owner）。
 * @returns {{ user: object, sid: string, cookie: string }}
 */
export async function registerUser(base, { username, password = 'pass12345', inviteCode }) {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, inviteCode }),
  });
  const body = await res.json();
  const setCookie = res.headers.get('set-cookie') || '';
  const sid = (setCookie.match(/sid=([^;]+)/) || [])[1] || null;
  if (!body.ok || !sid) throw new Error(`注册失败：${JSON.stringify(body)}`);
  return { user: body.data.user, sid, cookie: `sid=${sid}` };
}

/**
 * 登录用户（返回新 cookie）。
 * @returns {{ user: object, sid: string, cookie: string }}
 */
export async function loginUser(base, { username, password = 'pass12345' }) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  const setCookie = res.headers.get('set-cookie') || '';
  const sid = (setCookie.match(/sid=([^;]+)/) || [])[1] || null;
  if (!body.ok || !sid) throw new Error(`登录失败：${JSON.stringify(body)}`);
  return { user: body.data.user, sid, cookie: `sid=${sid}` };
}

/** 封装带 Cookie 的 fetch（path 相对 base；GET 自动带 Cookie，POST 传 body 自动 JSON） */
export function authFetch(base, cookie) {
  return (path, opts = {}) => fetch(base + path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
}

/** 直接读临时库（只读断言）；调用方负责 close() */
export function openDb(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}
