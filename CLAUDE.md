# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

考公刷题（行测/申论/事业编）全栈应用：零依赖 Node 后端 + SQLite 题库 + 同一套前端同时服务浏览器与 Android（Capacitor）。零依赖指后端只依赖 Node 内置模块（`node:sqlite`、`node:http` 等），唯一 npm 依赖是 `sharp`。数据与构建细节见 `README.md`（版权/许可）与 `BUILD_MANUAL.md`（Android 打包）。

## 常用命令

- 启动服务：`node server.mjs 3000`（或 `npm start`；Windows 双击 `启动.bat`）。要求 **Node ≥ 22.5**（用到 `node:sqlite`）。
- 首次克隆：先 `node tools/reassemble-tiku.mjs` 重组 `tiku.db`（由 `tiku.db.part-*` 分卷还原，自带 MD5 校验）。服务启动时会检查 `tiku.db` 与 `tiku-index.db` 是否存在并给出指引。
- 跑全部测试：`npm test`（`node --test` 17 个文件）。
- 跑单个测试：`node --test test-<name>.mjs`。
- 重建 `tiku-index.db`：`node tools/build-index-db.mjs`（修改 tiku.db 后需要重建派生索引并随仓库分发）。
- Android 打包：`node build-app-assets.mjs` → `node build-skill-bundle.mjs` → 复制到 `app/android/app/src/main/assets/public/app-assets/` → `cd app/android && ./gradlew assembleDebug`。完整流程见 `BUILD_MANUAL.md`。

**测试注意事项**：`npm test` 里多个文件（`test-local-api`、`test-local-queries`、`test-random-practice-count`、`test-local-ai`、`test-custom-practice`、`test-ability`、`test-diagnose`、`test-practice-leaf`、`test-ability-e2e`）直接打开 `app-assets/tiku_app.db`——该目录是构建产物、不入 git，跑这些测试前需先 `node build-app-assets.mjs`。不依赖构建产物的可独立运行：`test-custom-parser`、`test-native-engine`、`test-user-skills`、`test-local-handler`、`test-local-fixes`、`test-custom-bank-group`、`test-leaf-classifier`、`test-custom-practice-e2e`（e2e 需 `playwright-core` + 系统 Edge，会在随机端口起真实 server）。根目录的 `diag-*.mjs`、`make-icons-*.mjs` 等是一次性脚本，不在测试套件内。

## 核心架构：双模式同一前端

`public/` 前端在**两种模式下跑同一份 `app.js`**，接口层自动切换：

1. **服务器模式**：`server.mjs`（2855 行）提供静态文件 + `/api/*`。题库查询 `tiku.db`（只读 `DatabaseSync`），做题记录写 `practice.db`（可写，10s 超时）。
2. **本地/App 模式**（无服务器，离线）：`public/local-bootstrap.js` 检测 `window.Capacitor` 或 URL 带 `?local=1`，暴露 `window.__LOCAL_API_PROMISE__`；`app.js` 的 `api()` 检测到它就走 `public/local-handler.js`（基于 `lib/local-queries.mjs` 查询 + IndexedDB 记录 + `ai-local.js` 直调 AI）。题库用 sql.js 引擎（`public/sqljs-engine.js`）或原生桥 `window.NativeDB`（`MainActivity.java` 注入，App 主路径）。

**关键约定：`local-handler.js` / `local-queries.mjs` 的返回结构与 `server.mjs` 1:1 对齐，`app.js` 零改动。** 修改任何 API 返回结构时必须双端同步（`server.mjs` 与 `lib/local-queries.mjs` / `public/local-handler.js` 的 SQL 与组装函数逐字段一致，SQL 有注释「与 server.mjs 预编译语句 1:1」）。

## 数据库

- `tiku.db`（只读题库，随仓库分卷分发）：`papers`（subject/subjectName/category/name/chapters JSON）、`questions`（questionId 为粉笔原题 id，`answerIndex` 是 answer 转的数字索引——单选有效、`-1` 表示无法解析）、`materials`。
- `practice.db`（本地生成，不入 git）：做题记录 `practice_records`、`favorites`、`notes`、`custom_batches`/`custom_questions`（自定义题库）、`ai_explains`，外加三张**派生索引表** `question_categories`/`q_materials`/`q_material_map`——无用户数据，由随仓库分发的 `tiku-index.db` 首次运行时一次性灌入。
- `materials.db`（申论材料，随仓库分发）、`ai-config.db`（AI 配置，本地生成不入 git；测试用环境变量 `AI_CONFIG_DB` 指向临时库避免污染）。

判分统一走 `server.mjs` / `lib/local-queries.mjs`（`public/lib/local-queries.js` 为前端副本）的 `checkAnswer`：单选靠 `answerIndex`（或单数字 `answer`），多选靠 JSON 数组或逗号分隔数字，判断题靠 0/1 answer；真正无答案 (`ok: null`) 的题不判分。自定义题库题目在**导入时**由 `public/lib/custom-parser.js` 的 `normalizeAnswer` 把 "B" 规范化为 `answer_index`、把 "AB" 规范化为 `[0,1]` JSON；`material_id` 相同的题组成材料组（出题时同组连续、共用首份材料，双端 `groupCustomPracticeRows` 同构）。

## 知识点树与章节映射

- `lib/fenbi-tree.mjs`：`FENBI_TREE`（行测六大模块知识树）、`ESSAY_TREE`/`SHENLUN_TREE`/`ZONGYING_TREE`（申论/综应题型树）。`public/lib/fenbi-tree.js` 是同源码的前端副本。
- `lib/xingce-chapter-map.mjs`：真题章节名 → 树节点映射（`mapChapterToNode`），`public/lib/xingce-chapter-map.js` 为前端副本。
- 年份/难度过滤约定（双端一致，`server.mjs` 与 `lib/local-queries.mjs` 里逻辑相同）：默认只出近十年试卷（取 `papers.name` 前 4 位年份）；难度用粉笔 1–9，`random`/缺省不限。

## AI 智能体（`lib/ai-agents.mjs`）

五个智能体：行测解析、申论批改、识图转写（多模态 OCR）、学习进度顾问、题目解析员（自定义导入）。要点：

- 每个智能体独立 `base_url`/`api_key`/`model`，走 OpenAI 兼容协议；**配置存 `ai-config.db`，每次调用实时读库——改完即生效**；`prompt_history` 表带版本历史。
- 技能注入：字段填 skill 名称时，解析优先级为 **用户导入的 `user_skills` 表 > 本地 skill 文件夹（`.reasonix/skills`）> 纯文本**。`SKILL.md` + `references/*.md` 注入 prompt（排除 examples/ 与 README）。
- App 端对应 `public/ai-local.js`：配置存 localStorage（默认值 `public/ai-agents.default.json`），直调 OpenAI 兼容接口，结果缓存 IndexedDB，未配置时返回可读降级提示。
- 接口：`/api/ai/explain`、`/api/ai/ocr`、`/api/ai/structure`、`/api/ai/grade`、`/api/ai/material`、`/api/skills`（技能库导入）。

## 前端结构（`public/`）

- 单页 `index.html` + `app.js`（~5600 行）。视图是 `store.state.view` 状态机 + 每视图一个 `renderXxx()`：`renderHome`、`renderSubject`、`renderPractice`（刷题）、`renderReview`/`renderResult`（交卷）、`renderWrong`/`renderFavorites`/`renderNotes`、`renderAiSettings`、`renderCustomBank`/`renderCustomBatch`/`renderImport`（自定义题库）。URL 带 `?view=ai` 直达 AI 设置页。
- 判分核心：`public/app.js` 的 `judge(q, sel)`；多选采用「已选未确认 → 切题自动判分」交互（`confirmPendingMulti`）。
- 双端共用无 DOM 模块在 `public/lib/`：`custom-parser.js`（自定义题库解析/答案规范化）、`skill-importer.js`、`local-queries.js`、`fenbi-tree.js`、`xingce-chapter-map.js`——server.mjs 直接 `import './public/lib/custom-parser.js'`，改它会影响双端。
- `vendor/` 第三方分发包：pdfjs / sqljs / xlsx。`sw-local.js` 为离线 Service Worker，`idb-store.js` 为 IndexedDB 记录适配器（stores：records/favorites/custom_batches/custom_questions/notes，版本升级需 version+1 + onupgradeneeded 增量建表）。

## 其他注意

- `node:sqlite` 是实验特性，启动会打印 ExperimentalWarning，属预期。
- `.gitignore` 约定：所有 `*.db` 不入 git（例外：`materials.db`、`tiku-index.db` 随仓库分发；`tiku.db` 以分卷 `tiku.db.part-*` 形式入库）。`practice.db`、`ai-config.db`、`app-assets/`、爬虫脚本、cookie 文件均为本地产物，勿提交。
- 版权合规：`tiku.db`/`materials.db` 数据版权归粉笔等来源方，仅授权个人备考学习，勿商用/二次分发；`ref-skills/` 是第三方开源技能副本，保留各自上游许可（GPL/MIT 等）。`skills/` 是运行时技能库。
