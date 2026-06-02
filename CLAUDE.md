# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CUE 项目中枢是 Cue.AI 团队内部使用的 AI 研发交付指挥系统，管理任务分工、Git 追踪、AI 代码审阅、晚会闭环和自动企微推送。部署地址：https://hub.cueai.top

## 命令

```bash
npm run dev          # 启动服务（自动加载 .env）
npm run check        # 语法检查：自动扫描 server/ src/ scripts/ 下所有 .js/.mjs
npm run test:unit    # 单元测试：自动运行 scripts/test-*.mjs（新增测试文件无需改配置）
npm run test:regression  # 回归测试
npm run test:ci      # CI 全量：check + test:unit + test:regression
```

> 语法验证用 `node --check`（通过 `scripts/check-syntax.mjs` 自动扫描，无需手动维护文件列表）。服务启动在 `http://127.0.0.1:4317`，端口由 `PORT` 环境变量控制。

## 技术栈

- Node.js 18+ ES Modules，原生 `http` 入口 + Fastify v2 bridge
- LLM：`openai` SDK（`gpt-5.5` 规划/解释 + `gpt-5.4-mini` review map-chunk 高频低成本）
- 数据持久化：`server/data/db.json` 兼容层 + `server/data/v2.db` SQLite v2 层
- 前端：浏览器原生 ESM，无打包；`src/app.js` 仍是主控入口，新增代码优先走 `src/api/`、`src/state/`、`src/features/`

## 架构

```
server/index.js         ← HTTP 总入口：静态资源、/v2/app facade、Fastify /v2 bridge、legacy allowlist
server/store.js         ← JSON 兼容层读写 + in-memory cache + 数据迁移 + SQLite 防抖同步
server/v2/app.js        ← v2 鉴权 choke point + prefix router
server/v2/fastifyApp.js ← Fastify bridge，/v2/* 进入 handleV2
server/v2/routes/       ← v2 native resources：actors/events/pulls/reviews/observability/gateway 等
server/db/              ← SQLite 初始化、schema、写入 actor
server/services/
  claude.js             ← Claude API 封装（prompt caching、降级返回 null）
  planner.js            ← AI 任务规划（LLM 优先 → 规则引擎降级）
  reviewer.js           ← AI 代码审阅（LLM 优先 → 规则引擎降级）
  dailyBrief.js         ← 晚会作战包逻辑（对账、nextTargets、进度更新）
  riskEngine.js         ← 规则风险扫描 + 缓存的 AI 风险解释/健康度修正
  semanticLinker.js     ← AI 混合分析：任务/阶段/commit 语义关联、风险解释、健康度建议
  githubApi.js          ← GitHub REST API v3 封装（无需本地 clone）
  githubWebhook.js      ← Webhook 事件解析
  localGit.js           ← 本地 git 命令（fallback）
  wecom.js              ← 企业微信 Webhook 推送
server/data/
  seed.json             ← 初始数据（db.json 不存在时从此读取）
  db.json               ← legacy/compat 运行时数据（.gitignore 中，不提交）
  v2.db                 ← SQLite v2 运行时数据（.gitignore 中，不提交）
  openapi.js            ← GET /api/openapi.json 的规范定义
src/
  app.js                ← 主前端 shell（全局 state + legacy render/bindEvents，迁移中）
  api/                  ← domain API clients，负责 /api → /v2/app facade 映射或 native /v2 调用
  state/                ← domain stores/selectors
  features/             ← 已抽出的 feature renderer / interaction modules
  styles.css
index.html              ← 多个 section.view 对应导航页
```

### 路由匹配规则

`server/index.js` 先处理 `/v2/app/*` facade，再处理 Fastify `/v2/*`，再放行少量外部 legacy `/api/*`，最后禁用普通 v1 `/api/*`。legacy `handleApi` 和 route modules 仍是顺序匹配，**路由定义顺序即优先级**。新增路由前确认没有同路径的重复定义（历史上曾出现 POST `/api/reports/evening` 重复定义导致下面的路由永远无法命中）。

### Store 层

`store.js` 维护一个 in-memory `cache`。`loadStore()` 单例读取，`saveStore()` 全量覆盖写入，`updateStore(mutator)` 提供 structuredClone + 原子更新。`migrateStore()` 在每次启动时自动补全缺失字段（加新字段时在这里设默认值）。写入后会防抖同步到 SQLite，供 v2 native routes 读取。生产环境 bootstrap 默认用户时必须显式配置 `HUB_ADMIN_PASSWORD`/`HUB_LOGIN_PASSWORD`，不能落到开发默认密码。

### V2 鉴权

`server/v2/app.js` 是 v2 native endpoints 的鉴权边界：
- `/v2/health`、`/v2/info`、`/v2/openapi.json`、`/v2/gateway/validate` 豁免。
- `cue_` API key 走 `gatewayAuth()`，tenant 从 key 记录读取。
- 登录 session 可访问非 gateway v2 routes，tenant 从 JWT 的 `orgId`/`tenantId` 读取。
- legacy `CUE_API_KEY` 仅作外部系统兼容，tenant 固定为 `default`。
- 其余匿名请求返回 401，不能通过 `X-Tenant-Id` 自行落入 default tenant。

### LLM 调用约定

所有 LLM 调用走 `callClaude(systemPrompt, userPrompt)`，返回文本或 `null`（失败/无 key 时）。System prompt 上有 `cache_control: { type: 'ephemeral' }` — **不要把会变化的内容（日期、用户输入）放进 system prompt**，否则破坏缓存。每个调用方都必须处理 `null` 并降级。

### 晚会流程（核心业务逻辑）

1. **17:45 自动触发**（调度器）：`generateEveningReport(date)` 是唯一权威入口，同时完成规则引擎对账（`buildEveningReport`）+ LLM 文本增强 + 快照持久化（commits/assignments 快照写入 `store.eveningReports[date]`）+ `applyEveningReportProgress`（更新任务进度）+ 企微推送。
2. **企微格式**：企微 Markdown 不支持表格，用 `buildPreMeetingWeComMsg` 和 `buildMeetingSummaryWeComMsg` 生成列表格式消息，严禁在企微推送中使用 `|` 表格语法。
3. **对照分析**：`GET /api/reports/compare` 必须使用 `eveningEntry.commits`（快照），不能从 `store.activities` 实时查询。

### AI 产品经理（docsManager）

`server/services/docsManager.js` 实现从目标仓库 docs/ 抓取计划 → LLM 解析任务 → 写回进度文档的完整流程。

三个 API 端点（均在 `/api/projects/:id/` 下）：
- **`POST /sync-docs`** — 列举 docs/*.md（跳过：商业计划、用户场景、核心指标、技术选型、功能优先级、阶段进度追踪），LLM 解析结构化候选任务，按优先级默认选择少量近期可领取任务导入 hub 任务板，并将完整解析快照存入 `store.docTasks[projectId]`。
- **`POST /update-docs`** — 基于 `store.docTasks[projectId]`（快照）+ hub 任务真实状态 + 今日分工，生成 `docs/阶段进度追踪.md` 并通过 GitHub PUT API 写回目标仓库。
- **`POST /daily-scan`** — 全流程串联：sync-commits（复用 scanGitHubProject）→ sync-docs → update-docs，每步独立 try/catch 并在响应 `steps` 字段中报告各步结果。

注意事项：
- `store.docTasks` 是 `{ [projectId]: parsedTask[] }` 字典，在 `migrateStore()` 中默认为 `{}`。
- `DOC_TASK_IMPORT_LIMIT` 控制每次从候选任务中自动导入多少个到任务板，默认 8，接口可用 `?limit=` 临时覆盖，最大 20。
- `buildProgressMarkdown` 生成的 ✅/🔶/⬜ 状态以 hub 任务状态为准，hub 无记录时才用文档原始状态。
- 写回 GitHub 需要 `GITHUB_TOKEN` 有 repo 写权限（classic token 选 `repo`，fine-grained 选 `Contents: write`）。
- `PROGRESS_DOC_PATH` = `docs/阶段进度追踪.md`，固定路径。

### GitHub 同步

`scanGitHubProject`（远端 API，无需本地 clone）优先于 `scanLocalGitProject`。选择逻辑：项目有 `githubOwner` 字段则走 GitHub API，否则走本地 git。GitHub 作者名通过 `authorMap`（`githubApi.js` 第 73 行）映射到中文团队成员名。

### AI 混合分析（semanticLinker）

`POST /api/ai/refresh-analysis` 会触发 Claude 对任务、阶段、commit 和风险候选做语义分析，并缓存到 `store.semanticLinks`、`store.riskAnalyses`、`store.healthAnalysis`。

设计原则：
- 规则负责召回候选、硬阻断和兜底。
- Claude 负责语义关联、置信度、原因和建议动作。
- 页面读取缓存结果，不能在 `GET /api/state` 时直接调用 LLM。
- P1 硬风险不能被 LLM 降级。

## 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API Key，缺失时 LLM 功能降级为规则引擎 |
| `OPENAI_BASE_URL` | 代理地址（可选，如 Azure / LiteLLM） |
| `OPENAI_MODEL` | 主力模型（默认 `gpt-5.5`，规划/解释/生成类） |
| `OPENAI_MINI_MODEL` | 轻量模型（默认 `gpt-5.4-mini`，review map-chunk 高频场景） |
| `GITHUB_TOKEN` | GitHub PAT，缺失时匿名限速 60次/小时 |
| `VOYAGE_API_KEY` | Voyage AI API Key，设置后 /v2/memory 向量搜索自动从 Feature Hashing 升级为 Voyage AI 嵌入（voyage-3-lite，512d），无需其他配置 |
| `DOC_TASK_IMPORT_LIMIT` | docs 候选任务每轮自动导入上限，默认 8，最大 20 |
| `WECOM_WEBHOOK_URL` | 企微群机器人 Webhook URL |
| `CUE_API_KEY` | 写接口鉴权（配置后所有 POST/PATCH/DELETE 需要请求头 `X-CUE-API-Key`） |
| `HUB_URL` | 对外访问地址，默认 `https://hub.cueai.top`，用于企微消息中的链接 |
| `MEETING_HOUR` | 晚会时间（24h，默认 18），系统在 `MEETING_HOUR-1:45` 自动推送作战包 |
| `PORT` | 服务端口（默认 4317） |

`.env` 文件由 `server/index.js` 顶部代码加载，**不覆盖已由系统环境注入的变量**（生产环境变量优先）。启动时终端会打印各变量配置状态。

## 代码审阅级别

AI Review 输出固定四级：`Pass` / `Warning` / `Block` / `Escalate`。LLM 返回的原始字符串经 `normalizeLevel(raw, score)` 规范化（含中文映射），不能直接使用 `result.level`。

## 前端约定

- `state` 是全局单例对象，所有数据存在这里
- `render*` 函数只读 `state`，不发请求
- `getMeetingDate()` 返回晚会日期选择器的值（Shanghai 时区本地日期），所有涉及日期的 API 调用必须用此函数，不能用 `new Date().toISOString().slice(0, 10)`（UTC 时区会差一天）
- `api(path, options)` 封装了 fetch + apiKey 请求头注入

## Commit 规范

遵循 `.github/CUE_AI_GITHUB_RULES.md` 定义的前缀：`feat:` / `fix:` / `docs:` / `refactor:` / `merge:`。标题必须说明业务意图，不能写 `update`、`fix bug`、`改一下`。

CI 规则（`.github/workflows/cue-github-policy.yml`）强制要求：
- 描述部分**至少 8 个字符**（含中文字符），否则 commit-policy 检查失败
- 合并到 main 的 merge commit 必须用 `merge:` 前缀，不能用 `fix:` / `refactor:`

## 团队成员

| 中文名 | GitHub 匹配模式 |
|--------|---------------|
| 田家铭 | jiaming, tian |
| 胡佳涛 | hjttu, hu |
| 罗子宽 | ryanlzk, luo |
| 林世棋 | lin |

新增成员在 `server/services/githubApi.js` 的 `authorMap` 数组中维护。
