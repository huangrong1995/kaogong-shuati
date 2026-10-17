# AI 能力诊断实现计划（雷达图 + AI 错题诊断 + 针对性训练）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在错题本里新增「AI 能力诊断」：六大模块雷达图（实际正确率 vs 按目标分数换算的达标线）+ AI 把薄弱定位到「大模块→子模块→细分考点」+ 针对薄弱考点一键出题。

**Architecture:** 能力矩阵双端同构聚合（server 用 SQL、本地用 JS 遍历 IndexedDB 记录，输出逐字段一致）；达标线公式为共享纯函数；细分考点用关键词表启发式分类（`leaf-classifier`）；AI 诊断新增智能体「错题诊断顾问」，server/local 各由后端组装 payload 再直调 LLM。

**Tech Stack:** Node 内置模块（node:sqlite / node:http）+ 前端 canvas 手绘雷达图（零依赖）。唯一 npm 依赖 sharp 与图表无关，**不得新增依赖**。

**Spec:** [AI 错题能力诊断 — 设计文档](../specs/2026-10-18-wrong-analysis-design.md)

## Global Constraints

- **双端 1:1**：任何新增 API 返回结构与组装 SQL，`server.mjs` 与 `lib/local-queries.mjs` / `public/local-handler.js` 必须逐字段一致（SQL/JQ 函数加注释「与 server.mjs 1:1」；app.js 的 `api()` 层零改动）。
- **零依赖**：前端图表 canvas 手绘；不引任何第三方库；后端只用 node 内置模块。
- **题库只读**：tiku.db / tiku-index.db / app-assets 全部只读；能力矩阵实时聚合 `practice_records`，不落新表。
- **AI 实时读库**：新增智能体存 `ai-config.db`（`lib/ai-agents.mjs` 的 `DEFAULT_AGENTS` 自动补种）；本地端存 `public/ai-agents.default.json`（`loadAgents` 自动合并新角色）。
- **达标判定透明**：达标线公式必须可解释、可在前端设置页调整并即时生效。
- **语义**：`practice_records` 中 `group_key`=科目、`sub_key`=章节树大模块（判断推理等）；`question_categories`（`PRIMARY KEY(question_id, subject)`）的 `category`=大模块、`sub`=子模块；`is_correct=0` 答错、`IS NULL` 主观题不计。
- **不破坏现有**：错题本/统计/练习现有端点结构冻结，`npm test` 全绿。

## Review Focus

- **记录含未分类/申论/综应 sub_key**：`sub_key=''` 或非六大模块名（申论/综应有自己的组名）的记录必须排除出矩阵且不报错——Task 2 测试覆盖。
- **is_correct 为 NULL（主观/判断题）**：不入矩阵，correct/rate 分母不受污染——Task 2 测试覆盖。
- **同一题在行测/职测 qc 均有行**：按 `qc.subject = r.subject` 关联，每次作答只计一次——Task 2 本地测试用同 qid 跨 subject 记录断言不重复计数。
- **leaf 参数命中为 0**：server 与本地都返回 `[]`（不抛错），前端提示「该考点题量不足」——Task 7 测试覆盖。
- **AI 未配置 api_key / 无错题**：`/api/ai/diagnose` 返回 200 + 可读 `notice`、`content: null`，绝不打 500——Task 5 测试覆盖。

---

### Task 1: 考点细分标签分类器 `leaf-classifier`

**Files:**
- Create: `lib/leaf-classifier.mjs`（node，同源码）
- Create: `public/lib/leaf-classifier.js`（浏览器副本，import 改相对路径）
- Test: `test-leaf-classifier.mjs`（独立运行，不依赖构建产物）

**Interfaces:**
- Consumes: `FENBI_TREE`（自导入 `./fenbi-tree.mjs` / `./fenbi-tree.js`，用于没有自定义标签的子模块做叶子回退）
- Produces:
  - `classifyLeaf({ sub, content, analysis }) -> string`（细分考点名，未命中 → `'未细分'`；入参缺省安全，`content`/`analysis` 均可空串）
  - `leafTags(sub) -> string[]`（某子模块可产出的细分考点名单，供前端/AI 展示用；无自定义标签时返回该子模块 FENBI leaves）
  - `LEAF_OVERRIDES`（常量，自定义标签表：`图形推理`、资料分析五子模块）

- [ ] **Step 1: 写失败测试**（`test-leaf-classifier.mjs`，纯文本匹配，样例解析文本取自真题口吻）

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLeaf } from './lib/leaf-classifier.mjs';

test('图推细分标签：笔画数命中最优先', () => {
  assert.equal(classifyLeaf({ sub: '图形推理', content: '从所给四个选项中，选择最合适填入问号处', analysis: '题干图形均为一笔画图形，奇点数为0，故选…' }), '笔画数');
});
test('图推：对称性', () => assert.equal(classifyLeaf({ sub: '图形推理', analysis: '题干图形均为轴对称图形，对称轴依次顺时针旋转' }), '对称性'));
test('图推：空间类六面体', () => assert.equal(classifyLeaf({ sub: '图形推理', analysis: '展开图折叠后，面1与面3相对' }), '六面体'));
test('图推：未命中归未细分', () => assert.equal(classifyLeaf({ sub: '图形推理', content: 'x', analysis: '不知所谓' }), '未细分'));
test('资料分析·增长', () => assert.equal(classifyLeaf({ sub: '增长', content: '2020年…同比增长…', analysis: '现期量=3553，增长率=15.3%' }), '增长率'));
test('资料分析·比重', () => assert.equal(classifyLeaf({ sub: '比重', analysis: '…占…的比重为48.6%，基期比重…' }), '基期比重'));
test('言语·逻辑填空回退 FENBI 叶子', () => assert.equal(classifyLeaf({ sub: '逻辑填空', analysis: '“望尘莫及”为成语，与语境搭配…' }), '成语填空'));
test('逻辑判断回退 FENBI 叶子', () => assert.equal(classifyLeaf({ sub: '逻辑判断', analysis: '最能削弱上述论证的选项是…' }), '削弱题型'));
test('缺解析/空文本不抛错', () => { classifyLeaf({ sub: '图形推理' }); classifyLeaf({}); assert.equal(classifyLeaf({ sub: '图形推理', analysis: '' }), '未细分'); });
```

- [ ] **Step 2: 运行确认失败**
  Run: `node --test test-leaf-classifier.mjs`
  Expected: FAIL（`ERR_MODULE_NOT_FOUND`：lib/leaf-classifier.mjs 不存在）

- [ ] **Step 3: 实现 `lib/leaf-classifier.mjs`**
  结构：
  - `LEAF_OVERRIDES = { '图形推理': [<细分标签数组>], '增长': [...], '比重': [...], '平均数': [...], '倍数': [...], '综合': [...] }`，每项标签配 `keywords: string[]`（含常见别名：笔画数→['笔画','一笔画','奇点','多笔画']；对称性→['对称','对称轴','中心对称']；增长率→['增长率','增速','增幅','同比']…）。
  - 匹配策略：文本 = `content + '\n' + analysis`，按 `LEAF_OVERRIDES[sub]` 的数组顺序**首个**命中返回（数组顺序即优先级：数量类标签 > 属性类，保证「既对称又数面」偏向更细的数量类）；`sub` 无自定义表 → 遍历 `FENBI_TREE` 中该 sub 的 `leaves` 各配关键词表，顺序命中返回。
  - 必需产出的细分标签集合（测试钉死，词项由你用真题样本调优补全）：
    - `图形推理`：笔画数 / 对称性 / 曲直性 / 开闭性 / 面数 / 线条数 / 交点 / 部分数 / 元素数量 / 平移 / 旋转 / 翻转 / 黑白运算 / 六面体 / 立体拼合 / 视图
    - `增长`：增长率 / 增长量 / 基期与现期 / 年均增长
    - `比重`：现期比重 / 基期比重 / 两期比重
    - `平均数`：现期平均数 / 平均数增长率
    - `倍数`：倍数与翻番 / 基期倍数
    - `综合`：综合分析
  - 纯函数，无模块级可变状态；文本先去掉 HTML 标签与全角空格再匹配。
- [ ] **Step 4: 运行确认通过**：`node --test test-leaf-classifier.mjs` → PASS（全部 9 条）
- [ ] **Step 5: 复制浏览器副本 `public/lib/leaf-classifier.js`**（`import … from './fenbi-tree.js'`），改测试临时 import 公共副本跑一遍保证两副本同源：`node -e "import('./public/lib/leaf-classifier.js').then(m=>console.log(m.classifyLeaf({sub:'图形推理',analysis:'一笔画'})))"` → 输出 `笔画数`
- [ ] **Step 6: 真题覆盖度抽样核查（不提交）**：对 `tiku.db` 的 `判断推理·图形推理` 抽 200 题跑 `classifyLeaf`，用真实命中分布调整关键词，目标：`未细分` 占比 < 40%，且必出 `笔画数/对称性/面数` 三档。调词后重跑 Step 4。
- [ ] **Step 7: Commit**
```bash
git add lib/leaf-classifier.mjs public/lib/leaf-classifier.js test-leaf-classifier.mjs
git commit -m "feat(ability): 新增考点细分标签分类器 leaf-classifier"
```

---

### Task 2: 达标线共享纯函数 + 能力矩阵（server `/api/ability` + 本地 `abilityMatrix`）

**Files:**
- Modify: `lib/local-queries.mjs`（新增导出 `computeTargetLines`、在 `createLocalApi` 返回值上加 `abilityMatrix`）
- Modify: `public/lib/local-queries.js`（同源码副本）
- Modify: `server.mjs`（新增 `GET /api/ability`，约在 `/api/records/stats` 段后插入）
- Modify: `public/local-handler.js`（新增 `GET /ability` 路由）
- Test: `test-ability.mjs`（本地矩阵测试需 `app-assets/tiku_app.db`，先 `node build-app-assets.mjs`；server 冒烟只读不动 practice.db）

**Interfaces:**
- Consumes: Task 1 的 `classifyLeaf`（服务端/本地组装 subs[].leaves 用）
- Produces:
  - `computeTargetLines(weights:number[], target:number, k:number=0.35): number[]` — 入参全为 0–1 小数，返回每组达标线小数。公式 `line_i = clamp(T + k·(w_i − w̄), 0.50, 0.90)`，`w̄` = weights 均值。
  - `abilityMatrix(records, params)`（挂在 `createLocalApi` 返回值上）：`records` 为原始记录数组，`params = { target, exam, k }`（target/k 为 0–1 小数，exam 为字符串透传）。返回结构：
```json
{
  "target": 0.72, "exam": "fujian", "k": 0.35,
  "weights": [{ "group": "判断推理", "w": 0.22 }, { } ×6],
  "groups": [{
    "group": "判断推理", "total": 42, "correct": 28, "rate": 67,
    "line": 76, "enough": true, "met": false,
    "subs": [{ "sub": "图形推理", "total": 15, "correct": 9, "rate": 60,
               "leaves": [{ "leaf": "笔画数", "total": 6, "correct": 2, "rate": 33 }, { "leaf": "未细分", … }] }]
  } ×6]
}
```
  五大口径（与设计文档 B1/B2 一致）：`rate`/`line`/`weights.w` 均为整数 %（1–100 或 0–100），`enough = total >= 5`，`met = enough && rate >= line`；`groups` 顺序 = FENBI_TREE 顶级顺序（政治理论/常识判断/言语理解与表达/数量关系/判断推理/资料分析）；`subs`/`leaves` 按 `total` 降序。

- [ ] **Step 1: 写失败测试**（`test-ability.mjs` 文件头先建，跑纯函数部分）

```javascript
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
  assert.equal(computeTargetLines([1, 0, 0, 0, 0, 0], 0.90)[0], 0.90); // 上界
  assert.equal(computeTargetLines([0, 1, 0, 0, 0, 0], 0.50)[1], 0.50); // 下界
});
```

- [ ] **Step 2: 运行确认失败** → `node --test test-ability.mjs` → FAIL（`computeTargetLines` 未导出）
- [ ] **Step 3: 在 `lib/local-queries.mjs` 实现 `computeTargetLines` 并导出**（顶部 `export function computeTargetLines`，纯函数；`public/lib/local-queries.js` 同步一份）
- [ ] **Step 4: 运行确认通过** → `node --test test-ability.mjs` → PASS 前 3 条
- [ ] **Step 5: 本地矩阵写测试（同文件追加）**

```javascript
const db = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
const engine = { get: (s, ...p) => db.prepare(s).get(...p), all: (s, ...p) => db.prepare(s).all(...p) };
const qapi = createLocalApi(engine, engine, {});
const CUR = Date.now();
const mk = (qid, subKey, ok, subject = '公务员·行测') => ({ question_id: qid, sub_key: subKey, subject, is_correct: ok, archived: 0, created_at: CUR });
const SIX = { qid: '图形推理', key: '判断推理' };

test('abilityMatrix：行测/职测聚合 + 排除主观与归档', () => {
  const records = [
    mk(100000, '判断推理', 1), mk(100000, '判断推理', 0), mk(100001, '图形推理', 0),   // 注: sub_key 用真实存在的 qid 才会进 subs 明细
    { ...mk(100002, '判断推理', null) },                                   // 主观题排除
    { ...mk(100003, '判断推理', 0), archived: 1 },                          // 归档排除
    { ...mk(100004, '', 0) },                                             // 未分类排除出矩阵
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
  const records = [mk(100000, '判断推理', 1), mk(100000, '判断推理', 0, '事业编·职测')]; // 同 qid 两科
  const m = qapi.abilityMatrix(records, { target: 0.7, exam: 'guokao' });
  const jt = m.groups.find((g) => g.group === '判断推理');
  assert.equal(jt.total, 2);                                             // 两次作答各自入账，不因 qc 双行而翻倍
});
```
  注意：Step 5 断言里的 `qid`（100000 等）要求 `app-assets/tiku_app.db` 中确实存在对应 question_id 且属判断推理；若不存在，改为从 `question_categories` 里 `SELECT question_id … LIMIT 1` 取真实 qid 再拼记录（实现时以真实库为准调整，其余断言不变）。
- [ ] **Step 6: 实现 `abilityMatrix`**（`lib/local-queries.mjs` 的 `createLocalApi` 返回值，`public/lib/local-queries.js` 同步）：
  1. 过滤：`archived=0 && is_correct != null && subject in {公务员·行测,事业编·职测} && sub_key ∈ 六模块`；
  2. 一次批量取 `question_categories`：`SELECT question_id, subject, category, sub FROM question_categories`（map：`qid|subject → {category, sub}`）；
  3. 逐记录归组：模块= `sub_key`；（sub,leaf）明细用 qc 映射（缺失的记录计入模块 total、不进 subs）；leaf 由 `classifyLeaf({ sub: qc.sub, content, analysis })` 得到，`content/analysis` 用一次批量 `SELECT questionId, content, analysis FROM questions WHERE questionId IN (…)` 取并缓存在 Map（每 qid 只查一次）；
  4. weights：`SELECT qc.category c, COUNT(DISTINCT qc.question_id) n FROM question_categories qc JOIN questions q ON q.questionId = qc.question_id JOIN papers p ON p.id = q.paperId WHERE qc.subject IN (?, ?) AND substr(p.name,1,4) BETWEEN '${YEAR_FROM}' AND '${YEAR_TO}' GROUP BY qc.category`，六大模块按 n 归一成 0–1 权重；全 0 时退化为均匀 `1/6`；
  5. `line` = `computeTargetLines(weights, target, k)` × 100 取整；组装上面定义的 JSON。
  （`lib/local-queries.mjs` 内 SQL 注明「与 server.mjs /api/ability 1:1」）
- [ ] **Step 7: 运行确认通过** → `node --test test-ability.mjs` → PASS 全部
- [ ] **Step 8: server 端 `/api/ability`**（`server.mjs`，插在 `/api/records/stats` 块之前）：
  - top 从 lib/local-queries.mjs import `computeTargetLines`；import `classifyLeaf` from `./lib/leaf-classifier.mjs`；
  - query：`target`（0–1 小数，缺省 0.7）、`exam`（字符串，缺省 'guokao'）、`k`（0–1 小数，缺省 0.35）；
  - 三条 SQL 与本地同构（注释「与 local-queries.mjs abilityMatrix 1:1」）：
    1. 明细：`SELECT r.sub_key mod_key, qc.sub sub, r.is_correct ok FROM practice_records r LEFT JOIN question_categories qc ON qc.question_id = r.question_id AND qc.subject = r.subject WHERE r.archived = 0 AND r.is_correct IS NOT NULL AND r.subject IN ('公务员·行测','事业编·职测') AND r.sub_key IN (…六模块…)`
    2. 题干/解析批量：`SELECT questionId, content, analysis FROM tiku.questions WHERE questionId IN (…)`（K 个占位符）
    3. weights（同 Step 6 的 `question_categories` SQL，加 `tiku.` 前缀）
  - JS 组装逻辑与本地 `abilityMatrix` 逐行同构（同一份归类代码，双端各写一版，注释互相指认）；
  - 返回 200 JSON。
- [ ] **Step 9: server 冒烟测试（同文件追加，只读）**
```javascript
import { spawn } from 'node:child_process';
import net from 'node:net';
const PORT = 4700 + Math.floor(Math.random() * 200); let server, base;
test('server /api/ability 冒烟：形状正确（不写 practice.db）', async (t) => {
  await new Promise((res) => { const s = net.createServer(); s.listen(PORT, () => { s.close(res); }); });
  server = spawn(process.execPath, ['server.mjs', String(PORT)], { stdio: 'ignore', env: { ...process.env, AI_CONFIG_DB: '/tmp/ability-test-ai.db' } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const r = await fetch(`http://localhost:${PORT}/api/ability?target=0.72&exam=fujian`);
  const m = await r.json();
  assert.equal(m.groups.length, 6);
  assert.deepEqual(m.groups.map((g) => g.group), ['政治理论', '常识判断', '言语理解与表达', '数量关系', '判断推理', '资料分析']);
  for (const g of m.groups) for (const k of ['total', 'correct', 'rate', 'line', 'enough', 'met', 'subs']) assert.ok(k in g);
  assert.equal(Math.abs(m.weights.reduce((a, b) => a + b.w, 0) - 100) < 5, true);
  server.kill(); server = null;
});
```
- [ ] **Step 10: 运行确认通过** → `node --test test-ability.mjs` → PASS 全部（先 `node build-app-assets.mjs`）
- [ ] **Step 11: local-handler 路由**（`public/local-handler.js`）：`localApi` 里 `if (route === 'GET /ability') return query.abilityMatrix(await store.getAll('records'), { target: Number(qs.get('target') || 0.7), exam: qs.get('exam') || 'guokao', k: qs.get('k') != null ? Number(qs.get('k')) : 0.35 });`
- [ ] **Step 12: Commit**
```bash
git add lib/local-queries.mjs public/lib/local-queries.js server.mjs public/local-handler.js test-ability.mjs
git commit -m "feat(ability): 能力矩阵 API（server + 本地双端 1:1）与达标线公式"
```

---

### Task 3: AI 智能体「错题诊断顾问」

**Files:**
- Modify: `lib/ai-agents.mjs`（`DEFAULT_AGENTS` 追加一条）
- Modify: `public/ai-agents.default.json`（追加同一条）

**Interfaces:**
- Consumes: —（无先例依赖）
- Produces: `role: 'wrong-diagnosis'` 的智能体，`getAgent('wrong-diagnosis')` 可查到、`listAgents()` 可见。Server 端由 `initAiConfig` 的补种循环自动写入 `ai_agents`；本地端 `loadAgents` 按 defaults 数组自动并入。

- [ ] **Step 1: 先读现有 `DEFAULT_AGENTS` 与 `public/ai-agents.default.json`，在二者各追加一条**（id 顺延 `7`；`api_key: ''`、`enabled: 0`，与既有条目一致）：
  - `name: '错题诊断顾问'`
  - `role: 'wrong-diagnosis'`
  - `description: '基于能力矩阵与错题清单做能力诊断，把薄弱定位到细分考点并给方法论建议'`
  - `skill: 'gongkao-huasheng13'`（复用行测方法论 skill，供「解题方法论建议」引用）
  - `base_url / model / temperature: 0.3 / max_tokens: 12000`，与 xingce-explainer 同款默认值
  - system_prompt 编译要点（范例照此写，禁止占位）：
    1. 角色：资深行测/职测讲师 + 备考规划师；
    2. 输入：一段 JSON（六大模块 `group/total/correct/rate/line/met/enough` + 每个未达标模块的错题清单，每题含 `group/sub/leaf/content/myAnswer/correctAnswer/analysis`）；
    3. 输出：按模块分节——本模块达标判定一句话、薄弱子模块确诊（引用 `sub` 与 `leaf`）、错题共性原因假设（只引用题面/解析里有的信息，**不得编造题目未提供的数据**）、方法论建议（引用注入的 skill 方法名）、优先级建议（按线下差距与题量权重排序）；
    4. 结构：`## 模块名` 小节 + 结尾「优先行动清单」有序列表 + 每个薄弱点给「针对性训练」建议（写明 group/sub/leaf，后端据此可一键出题）；
    5. 格式：纯文本 markdown，不输出虚构统计。
- [ ] **Step 2: 写测试**（`test-diagnose.mjs` 文件头）——服务端补种 + 可见性
```javascript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
test('DEFAULT_AGENTS 含 wrong-diagnosis', async () => {
  const { DEFAULT_AGENTS } = await import('./lib/ai-agents.mjs');
  assert.ok(DEFAULT_AGENTS.find((a) => a.role === 'wrong-diagnosis'));
});
```
- [ ] **Step 3: 补种到 ai_agents 表**：临时 `AI_CONFIG_DB=/tmp/diagnose-test-ai.db node -e "const {initAiConfig,getAgent}=await import('./lib/ai-agents.mjs'); await initAiConfig(); console.log(getAgent('wrong-diagnosis').role)"` → 输出 `wrong-diagnosis`；再补断 `getAgent('wrong-diagnosis').id === 7` 进 Step 2 测试（用 `AI_CONFIG_DB` 指临时库）。
- [ ] **Step 4: 运行确认通过** → `node --test test-diagnose.mjs` → PASS
- [ ] **Step 5: Commit**
```bash
git add lib/ai-agents.mjs public/ai-agents.default.json test-diagnose.mjs
git commit -m "feat(ai): 新增错题诊断顾问智能体（wrong-diagnosis）"
```

---

### Task 4: `/api/ai/diagnose`（server）——矩阵 + 错题 payload 组装 → callAgent

**Files:**
- Modify: `server.mjs`（新增 `POST /api/ai/diagnose`，放在 `/api/ai/explain` 块前）
- Modify: `test-diagnose.mjs`（追加两条）

**Interfaces:**
- Consumes: Task 2 `abilityMatrix` 的数据查询与 `computeTargetLines`；Task 3 `getAgent('wrong-diagnosis')`；Task 1 `classifyLeaf`
- Produces: `POST /api/ai/diagnose`，body `{ target, exam, k }` → 200 `{ content, model, error? }`（degrade 时 `{ notice, content: null }`）。健康返回的 `content` 为格式化诊断文本。

- [ ] **Step 1: 写失败测试（degrade 路径，不打 LLM）**
```javascript
test('server /api/ai/diagnose：未配置 api_key 返回可读降级', async (t) => {
  // 复用 Task 2 的 spawn 骨架；env 带 AI_CONFIG_DB=/tmp/diagnose-test-ai.db（该库 wrong-diagnosis 未配 key）
  const res = await fetch(`http://localhost:${PORT}/api/ai/diagnose`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 0.72, exam: 'fujian' }),
  });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.ok(typeof r.notice === 'string' && r.content === null);
});
test('server /api/ai/diagnose：无错题时提示暂无诊断', async (t) => {
  // 同上，但先在能力矩阵 API 下注：若 practice.db 恰好有错题，则此断言改为 == 200 即可结构不报错
  const res = await fetch(`http://localhost:${PORT}/api/ai/diagnose`, { /* 同上 */ });
  const r = await res.json();
  if (r.content === null) assert.ok(typeof r.notice === 'string');
});
```
- [ ] **Step 2: 实现 `/api/ai/diagnose`（server.mjs）**：
  1. `getAgent('wrong-diagnosis')`；`!agent || !agent.api_key` → 200 `{ notice: '错题诊断顾问 AI 尚未配置 api_key，请到「AI 设置」页面填写后重试。', content: null }`；
  2. 按 `/api/ability` 同款 SQL 取能力矩阵（复用 Task 2 的组装代码；把组装抽成一个内部 `buildAbility(pdb, target, exam, k)`，`/api/ability` 与 `/api/ai/diagnose` 共用）；
  3. 取错题：`SELECT question_id, selected, created_at FROM practice_records WHERE is_correct = 0 AND archived = 0 AND subject IN ('公务员·行测','事业编·职测') AND sub_key IN (六模块)`；join qc 得 `category/sub`，`classifyLeaf` 得 leaf，`qQuestionById.get(qid)` 取 `content/analysis`；
  4. 只取**未达标模块**的错题，每模块 ≤ 8 条、总 ≤ 40 条；`content` 截 140 字、`analysis` 截 240 字；组装 `wrongItems`；
  5. 全部模块都达标或错题空 → 200 `{ notice: '当前没有需要诊断的薄弱模块，先去刷题吧', content: null }`；
  6. 组装 JSON payload → `callAgent(agent, JSON.stringify(payload, null, 1))` → 返回 `{ content: r.content, model: agent.model }`；`r.error` 时返回 `{ notice: r.error, content: null }`。
- [ ] **Step 3: 运行确认通过** → `node --test test-diagnose.mjs` → PASS（两条 degrade 断言；含 step 4 组装测试在内全部绿）
- [ ] **Step 4: 追加 payload 组装纯测**（不依赖 LLM/服务器）——抽 `formatDiagnosisPrompt(matrix, wrongItems)` 到 `lib/local-queries.mjs` 并导出（public 副本同步；server import 共用）：
```javascript
import { formatDiagnosisPrompt } from './lib/local-queries.mjs';
test('formatDiagnosisPrompt：输出含矩阵摘要与错题细分标签', () => {
  const text = formatDiagnosisPrompt(
    { target: 0.72, groups: [{ group: '判断推理', rate: 50, line: 74, met: false, total: 20 }] },
    [{ group: '判断推理', sub: '图形推理', leaf: '笔画数', content: '…', myAnswer: 'B', correctAnswer: 'A', analysis: '一笔画…' }]
  );
  assert.ok(text.includes('判断推理') && text.includes('50') && text.includes('笔画数') && text.includes('一笔画'));
});
```
  `formatDiagnosisPrompt` 把矩阵缩略成每模块一行（group/rate/line/met）、错题按模块分组列出（每题一行 `[大模块·子模块·细分考点] 题干摘要 … 我答:… 正确:… 解析摘要` 换行可读）。server `/api/ai/diagnose` 步骤 2.6 用它。
- [ ] **Step 5: 运行全部** → `node --test test-diagnose.mjs test-ability.mjs` → PASS
- [ ] **Step 6: Commit**
```bash
git add server.mjs lib/local-queries.mjs public/lib/local-queries.js test-diagnose.mjs
git commit -m "feat(ai): POST /api/ai/diagnose 能力诊断（矩阵+错题→错题诊断顾问）"
```

---

### Task 5: 本地端诊断接线（`ai-local.js` → `local-handler.js`）

**Files:**
- Modify: `public/ai-local.js`（`createAiApi` 返回值加 `diagnose`）
- Modify: `public/local-handler.js`（`POST /ai/diagnose` 路由）
- Modify: `test-diagnose.mjs`（追加两三条，mock ai / tiku)

**Interfaces:**
- Consumes: Task 3 本地默认智能体、`formatDiagnosisPrompt`（public 副本）
- Produces: `ai.diagnose(payload) -> { content, model?, error? }`；本地 `POST /ai/diagnose` 与 server 响应形态一致。

- [ ] **Step 1: 写失败测试**（`test-diagnose.mjs` 追加，mock 直调路径）
```javascript
import { createLocalApi } from './lib/local-queries.mjs';
import { createLocalHandler } from './public/local-handler.js';
test('local-handler /ai/diagnose：组装 payload 并转发给 ai.diagnose', async () => {
  const db2 = new DatabaseSync('app-assets/tiku_app.db', { readOnly: true });
  const eng = { get: (s, ...p) => db2.prepare(s).get(...p), all: (s, ...p) => db2.prepare(s).all(...p) };
  const qapi = createLocalApi(eng, eng, {});
  let got = null;
  const fakeAi = { diagnose: async (p) => { got = p; return { content: 'ok', model: 'm' }; } };
  const handler = createLocalHandler({ query: qapi, records: null, store: { getAll: async () => [] }, ai: fakeAi });
  const r = await handler('api/ai/diagnose', { method: 'POST', body: JSON.stringify({ target: 0.7, exam: 'guokao' }) });
  assert.equal(r.content, 'ok'); assert.equal(r.model, 'm');
  assert.ok(got && typeof got === 'string' && got.length > 0); // payload 已组装为诊断 prompt 文本
});
```
- [ ] **Step 2: 实现 `ai-local.js` 的 `diagnose(payload)`**（挂到 `createAiApi` 返回值，放 `explain` 之后）：
  - `const agent = loadAgents(defaults).find((a) => a.role === 'wrong-diagnosis')`；缺 agent 或未配 key → `{ error: '…' }`（与 callChat 的未配置文案一致）
  - `return callChat(agent, String(payload), request)`；不缓存（矩阵高频变化、重复调用窜读旧结果）。
- [ ] **Step 3: 实现 `local-handler.js` 的 `POST /ai/diagnose` 路由**（放在 `POST /ai/explain` 路由旁）：
  - body `{ target, exam, k }`；
  - `const records = await store.getAll('records'); const matrix = query.abilityMatrix(records, { target, exam, k });`
  - 组装 vs server `/api/ai/diagnose` 同款的 wrongItems（records 过滤 `is_correct===0 && archived===0 && subject∈{行测,职测} && sub_key∈六模块`；归类/叶子经 `query` 提供的 tiku 查询 + `classifyLeaf`（public 副本）；每模块 ≤8 总 ≤40；未达标模块过滤；全空 → `{ notice: '当前没有需要诊断的薄弱模块，先去刷题吧', content: null }`）；
  - `const r = await ai.diagnose(formatDiagnosisPrompt(matrix, wrongItems));`
  - `return r.error ? { notice: r.error, content: null } : r;`
- [ ] **Step 4: 运行确认通过** → `node --test test-diagnose.mjs` → PASS
- [ ] **Step 5: 双端 health 复核**（同文件追加最小断言）：`handler('api/ai/diagnose', …)` 在 `fakeAi` 无 key 时返回 `{ notice… }`；并跑 `node --test test-local-handler.mjs` 确认原路由全部不回归。
- [ ] **Step 6: Commit**
```bash
git add public/ai-local.js public/local-handler.js test-diagnose.mjs
git commit -m "feat(ai): App 本地端错题诊断接线（ai-local.diagnose + local-handler /ai/diagnose）"
```

---

### Task 6: `/api/practice` 与本地 `practice()` 加 `leaf` 过滤

**Files:**
- Modify: `server.mjs`（`/api/practice` 大模块分支）
- Modify: `lib/local-queries.mjs` + `public/lib/local-queries.js`（`practice()` 大模块分支）
- Modify: `test-practice-leaf.mjs`（新建；server 只读 tiku、本地用 app-assets）

**Interfaces:**
- Consumes: Task 1 `classifyLeaf`
- Produces: `practice({ …, leaf })` 关键字过滤——传入细分考点时只返回命中该考点的题；未命中直接 `[]`。

- [ ] **Step 1: 写失败测试**（`test-practice-leaf.mjs`）
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLocalApi, checkAnswer } from './lib/local-queries.mjs';
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
```
- [ ] **Step 2: 运行确认失败** → `node --test test-practice-leaf.mjs` → FAIL（practice 不认 leaf：忽略该参数返回随机题）
- [ ] **Step 3: 实现 `lib/local-queries.mjs practice()`**（大模块分支）：
  - 签名解构加 `leaf`；在拿到 `qs`（`tiku.all(...) 全字段，含 content/analysis`）之后、`trimToMax` 之前：
  ```js
  const matched = leaf ? qs.filter((q) => classifyLeaf({ sub, content: q.content || '', analysis: q.analysis || '' }) === leaf) : qs;
  if (leaf && !matched.length) return [];
  return trimToMax(enrichGroups(tiku, practice, matched, subject, diffFilter), max);
  ```
  （`public/lib/local-queries.js` 同步）
- [ ] **Step 4: server 端 `/api/practice`**（大模块分支，`qs` 全字段已含 content/analysis）同逻辑：`const matched = leaf ? qs2.filter(...) : qs2; if (leaf && !matched.length) return json(res, 200, []); return json(res, 200, trimToMax(enrichGroups(matched, subject, diffFilter), max));`（`qs2` 为 server 的 `qs` 变量名，注意双端别名一致）
- [ ] **Step 5: server 冒烟测试（同文件追加）**：spawn 起 server（骨架同前），`GET /api/practice?subject=公务员·行测&group=判断推理&sub=图形推理&leaf=笔画数&n=8` → 200 数组，逐题 `classifyLeaf` 复核 === `'笔画数'`；`leaf=不存在的考点` → `[]`。
- [ ] **Step 6: 运行确认通过** → `node --test test-practice-leaf.mjs` → PASS 全部
- [ ] **Step 7: Commit**
```bash
git add server.mjs lib/local-queries.mjs public/lib/local-queries.js test-practice-leaf.mjs
git commit -m "feat(practice): 支持按细分考点 leaf 过滤出题（双端）"
```

---

### Task 7: 前端——错题本入口、`renderAbility` 视图、雷达图、针对性训练

**Files:**
- Create: `public/lib/radar-chart.js`（canvas，零依赖）
- Modify: `public/app.js`（新视图 renderAbility + 错题本入口 + setView 分发 + 设置持久化 + 针对性训练回调）
- Modify: `public/style.css`（能力诊断页样式）
- （无需改 server/local-handler——端点已在 Task 2/4/5 提供）

**Interfaces:**
- Consumes: `GET /api/ability?exam&target&k`、`POST /api/ai/diagnose`、`GET /api/practice?subject&group&sub&leaf&n`、`enterQuiz(questions, subject, mode, chapter, mock, limitSec, backMode)`
- Produces: 视图 `state.view='ability'`（可在启动 URL `?view=ability` 直达）；localStorage 键 `ability_settings_v1` = `{ exam, preset, custom, k }`。

- [ ] **Step 1: 写失败/占位测试**（`test-ability.mjs` 追加一条，防雷达组件 API 漂移）
```javascript
test('radar-chart 模块可加载且暴露 drawRadar', async () => {
  const m = await import('./public/lib/radar-chart.js');
  assert.equal(typeof m.drawRadar, 'function');
});
```
  先不写 `.js` 文件 → FAIL。
- [ ] **Step 2: 实现 `public/lib/radar-chart.js`**
  - `drawRadar(canvas, { labels: string[], values: number[], lineValues: number[], met: boolean[] })`
  - `values`/`lineValues` 为 0–1，数量=轴的个数（6）；`met` 供达标轴描边置亮；
  - devicePixelRatio 适配；颜色随主题用 `getComputedStyle(canvas)` 读 CSS 变量（`--primary`/`--text-2`/`--text-3`/`--card-bg`/`--line`）；实线多边形=实际正确率，虚线多边形=达标线，图例回到调用方绘制；
  - 网格：同心多边形 + 径向刻度标签（模块名 8 字内换行、0/50/100 刻度）；窗口 resize 重绘交由调用方监听；宽高自适配容器。绘制参数（间距/线宽/透明度）由实现者定，以深浅主题截图验收。
- [ ] **Step 3: `renderAbility()`（app.js）**——放在 `renderWrongList` 之后：
  - `setView('ability')`；标题「AI 能力诊断」；
  - **目标设置卡**：考试选择（国考/福建省考 两个按钮）、档位三选（打底/稳妥上岸(默认)/高分挑战）+ 自定义目标分输入；下方**换算说明**随选择即时显示「目标分 72 → 达标正确率 72% → 各模块达标线：言语 78 / 数量 62 …」（由后端返回的 `groups[].line` 回填）。预设分见设计文档：国考 62/68/75；福建省考 65/72/78；`target = 预设分/100`。设置持久化到 `localStorage['ability_settings_v1']`，改动即重拉 `/api/ability`。
  - **雷达图卡**：canvas 容器 + 图例（实线=我的正确率，虚线=达标线）；数据 = `groups[].rate/100` vs `groups[].line/100`；
  - **六大模块卡网格**（桌面 3 列/移动 1 列）：每卡 模块名 + `rate%` 大字 + 达标徽章（✔ 达标 / ✕ 未达标 / ⚠ 数据不足(<5 题)）+ `题量` + 专属「针对性训练」按钮。点击卡片展开：
    - 子模块列表：`sub · rate%（答对 x/总量）` + 进度条 + 每子模块「训练」按钮；
    - 子模块内**细分考点分布**：`subs[].leaves[]` 每条 `leaf · rate%（答对 x/总量）` + 单列「训练」按钮；
  - **训练回调**：`async (group, sub, leaf) => { const qs = await api('/api/practice?subject=公务员·行测&group=…&sub=…&leaf=…&n=10'); if (!qs.length) { toast('该考点暂无题可练'); return; } enterQuiz(qs, '公务员·行测', 'practice', chapter, mock, null, action(back)); }`（无 leaf 时省略参数；subject 固定行测——问卷两科同池，与矩阵口径一致）；
  - **AI 诊断区**：按钮「AI 能力诊断」→ 禁用+loading → `POST /api/ai/diagnose { target, exam, k }` → `content` 渲染进 pre-wrap 容器（复用 `.ab-body` 样式）；`notice` 则灰显提示；成功后可「复制报告」；
  - 空态：`groups` 全 `total===0` → 雷达区显示「暂无做题数据，去刷题」空态，AI 按钮禁用。
- [ ] **Step 4: 视图分发接线**：
  - `setView` 分支：`else if (top.name === 'ability') renderAbility();`（约 417 行）；
  - 返回处理 `goBack`：`else if (src && src.name === 'ability') renderAbility();`；
  - 启动路由：`if (name === 'ability') renderAbility();`（约 5612 行，与 `?view=ai` 并列）；
  - 底部导航/错题本入口：`renderWrongTab` 的 `.wrong-actions` 里**加第一个按钮** `<button class="btn btn-ghost" id="wrong-ability">${ico('chart',15)} 能力诊断</button>`（title「AI 能力诊断：雷达图 + 薄弱定位」），onclick → `renderAbility()`；两处渲染（renderWrongTab 与 renderWrongList 的 card head）都加。
- [ ] **Step 5: CSS**（`public/style.css`，追加 `/* ---------- AI 能力诊断 ---------- */` 块）：
  - `.ability-settings`（flex gap 折叠/自动换行，设置项 chip 化对齐现有 `.mock-tabs` 风格）、`.ability-radar`（canvas 宽 100% max 520px 居中）、`.ability-modules`（grid，桌面 3 列 / ≤980px 1 列，复用 `.list-grid` 断点）、`.ability-module`（card）、`.am-stat`（rate 大字 + met 徽章三色：绿/红/灰）、`.ability-sub-row`、`.ability-leaf-row`（缩进 + 小字号 + 「训练」小按钮）、`.ai-diag`（诊断报告容器，pre-wrap、深色主题自动反色）。
  - 移动端 `.wrong-actions` 已有 `.btn` wrap 行为，能力诊断按钮若挤则允许换行（`flex-wrap: wrap`）。
- [ ] **Step 6: 回归**：`node --test`（先 `node build-app-assets.mjs`）。重点确认 `test-local-handler`、`test-ability`、`test-practice-leaf`、`test-diagnose` 全绿，其余 11 个既有测试文件不回归。
- [ ] **Step 7: 截图验收 + 手动交互冒烟**：起本地 server（端口 3000），用既有 CDP Edge 截图工具链拍：错题本 tab 页（新增按钮可见）、能力诊断页浅色/深色（雷达图两多边形+图例+模块卡+达标徽章）、展开模块卡（子模块条+细分考点行+训练按钮）、AI 诊断降级提示（未配 key）；核对移动端 390px 无横向滚动。截图存 `shots/`，可展示给用户。
- [ ] **Step 8: Commit**
```bash
git add public/lib/radar-chart.js public/app.js public/style.css
git commit -m "feat(frontend): AI 能力诊断视图（雷达图+达标线+薄弱点针对性训练）"
```

---

### Task 8: 模拟本地模式端到端冒烟

**Files:**
- Modify: `test-diagnose.mjs` 或新 `test-ability-e2e.mjs`（optional，若时间允许）

**Interfaces:**
- Consumes: 全链（ability → practice leaf → diagnose）
- Produces: 一条「本地模式无服务器」端到端断言（浏览器侧 handler + 全查 + 全 AI mock）

- [ ] **Step 1: 本地模式 e2e**（`test-ability-e2e.mjs`）：用 `createLocalHandler` + 真实 `app-assets/tiku_app.db` + 内存 store（预置 5–10 条行测记录：可行做对、数题做错，覆盖 ≥2 大模块）+ mock `ai.diagnose`：
  - `GET /ability` → 断言 `groups` 各模块 rate/line/met 与手工计算一致；
  - `GET /practice?...&leaf=笔画数` → 逐题复核；
  - `POST /ai/diagnose` → 断言 mock 收到含细分标签的 prompt 文本。
- [ ] **Step 2: 运行确认通过** → `node --test test-ability-e2e.mjs` → PASS
- [ ] **Step 3: Commit**
```bash
git add test-ability-e2e.mjs
git commit -m "test(ability): 本地模式端到端冒烟（矩阵+leaf 出题+AI 诊断）"
```

---

## Self-Review 结果

- **Spec 覆盖**：设计文档 §1 达标线（Task 2）、§2 权重差异化公式（Task 2 `computeTargetLines`）、§3 细分标签（Task 1 + Task 6 + Task 4）、§4 错题诊断顾问（Task 3/4/5）、§5 API 双端 1:1（Task 2/4/5/6）、§6 前端（Task 7）、§7 降级（Task 4 测试 + 前端空态 Task 7）、附录 B1–B6 全部落进上述任务（B4 前端传 target/exam、B5 leaf 双端、B6 local-handler 组装）。附录 A 进面分 → Task 7 预设分。
- **Step 扫描**：每步只留一个可写动作；无「TBD」占位；函数体只在测试钉死的断言里给出具体值，正文以签名/口径/结构描述。
- **类型一致**：`computeTargetLines(weights, target, k)` 在 Task 2 定义、Task 2/4 消费；`classifyLeaf({sub,content,analysis})`Task 1 定义、Task 2/4/6 消费；`formatDiagnosisPrompt(matrix, wrongItems)` Task 4 定义、Task 5 复用。无改名冲突。
- **Review Focus**：未分类/申论 sub_key 排除（Task 2 Step 5）、is_correct NULL 排除（Task 2 Step 5）、跨 subject 单次计数（Task 2 Step 5）、leaf 空命中返回 []（Task 6 测试）、AI 未配置降级（Task 4 Step 1）——五条均有测试钉死。
- **比例**：计划 9 任务 ≈ 设计文档 1.5 倍长度，代码块只出现在测试与必需的公式/结构定义处，无逐行代码转述。