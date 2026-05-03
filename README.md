# CUE 项目中枢

CUE 项目中枢是 Cue.AI 团队内部使用的 AI 研发交付指挥系统。它的目标不是再增加一个填表工具，而是把阶段目标、任务分工、GitHub 提交、AI Review、异步站会、晚会复盘、风险提醒和企业微信机器人串成一个可追踪的研发闭环。

当前公网部署地址：

```text
https://hub.cueai.top
```

当前默认跟踪的真实产品仓库：

```text
CUEAITECH/Cue.AI
```

项目中枢自身代码仓库：

```text
CUEAITECH/CUE-Project-Hub
```

两个仓库的职责必须分开：`Cue.AI` 是被管理和跟踪的产品项目，`CUE-Project-Hub` 是项目中枢自身代码。项目中枢默认只跟踪 `CUEAITECH/Cue.AI`，自身仓库只用于开发和部署项目中枢。

## 已完成能力

### 1. 真实 Cue.AI 仓库接入

项目中枢已经从旧的本地演示仓库口径切换到真实 GitHub 远端：

```text
CUEAITECH/Cue.AI
```

已完成内容：

- 默认项目配置指向 `CUEAITECH/Cue.AI`。
- GitHub API 同步优先于本地 Git 扫描，无需在服务器 clone 目标产品仓库。
- 已清理旧数据里残留的 `cue-project-hub`、`cue-project-hub-api`、`OmniNexus-Edu-copilot` review 口径。
- 启动时 `server/store.js` 会自动迁移旧数据：
  - 旧 OmniNexus 仓库别名归并到 `CUEAITECH/Cue.AI`
  - 旧 demo review 被剔除
  - 旧 `cue-project-hub#...` linkedRef 会改成 `CUEAITECH/Cue.AI#...`
- `/api/state` 中的项目和 review repo 应统一显示为 `CUEAITECH/Cue.AI`。

服务器验证命令：

```bash
curl -s https://hub.cueai.top/api/state | grep -E '"githubFullRepo"|"repo"|"cue-project-hub"|"OmniNexus"'
```

期望结果：只出现 `CUEAITECH/Cue.AI`，不再出现 `cue-project-hub` 或 `OmniNexus`。

### 2. GitHub 自动同步

项目中枢已经支持自动抓取 GitHub 远端数据。

已完成内容：

- 服务启动 15 秒后自动同步一次。
- 默认每 10 分钟同步一次。
- 每次同步从 `CUEAITECH/Cue.AI` 拉取最近 commit。
- 只对新 commit 生成 AI Review，避免重复消耗 Claude。
- 修复了重复同步时同项目旧提交可能被清空的问题。
- 同步完成后会刷新：
  - 项目状态
  - activities
  - reviews
  - risks
  - metrics
  - 阶段目标对照清单

相关环境变量：

```env
GITHUB_SYNC_INTERVAL_MINUTES=10
GITHUB_SYNC_LIMIT=20
GITHUB_SYNC_DIFF_LIMIT=5
```

含义：

- `GITHUB_SYNC_INTERVAL_MINUTES`：自动同步间隔，单位分钟。设为 `0` 可关闭。
- `GITHUB_SYNC_LIMIT`：每轮最多拉取多少条 commit。
- `GITHUB_SYNC_DIFF_LIMIT`：每轮最多对多少条最新 commit 拉取 diff 并生成 AI Review。

PM2 日志中看到以下内容表示自动同步已启用：

```text
GITHUB_AUTO_SYNC   ✅ 每 10 分钟同步一次
[Scheduler] GitHub 已同步 CUEAITECH/Cue.AI：新增 X 条提交，新增 Y 条 Review
```

### 3. Claude AI Review 接入

项目中枢已经接入 Claude API。当前 AI Review 不是纯模板。

调用路径：

- `server/services/claude.js` 统一封装 Claude 调用。
- `server/services/reviewer.js` 优先调用 Claude，失败时降级到规则引擎。
- `server/services/planner.js` 优先调用 Claude，失败时降级到规则引擎。
- 日报、晚报、站会总结、计划调整也会优先调用 Claude。

已验证行为：

- 配置 `ANTHROPIC_API_KEY` 后，`/api/config` 中 `llmEnabled` 为 `true`。
- `POST /api/reviews` 会生成更具体的审阅建议。
- LLM 输出解析失败时，会记录日志并降级到规则引擎，不会中断服务。

相关环境变量：

```env
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=
```

### 4. 企业微信 API 插件接入

企业微信 API 插件已经打通只读查询链路。

插件基础 URL：

```text
https://hub.cueai.top
```

已完成两个企业微信友好接口：

```text
GET /api/wecom/summary
GET /api/wecom/risks
```

这两个接口都返回一个简单的 `summary` 字符串，避免企业微信插件配置复杂的 array/object 输出参数。

推荐配置工具：

工具 1：

- 工具名称：`getWeComProjectSummary`
- 工具路径：`/api/wecom/summary`
- 请求方法：`GET`
- 输入参数：无
- 输出参数：`summary`，类型 `String`

工具 2：

- 工具名称：`getWeComRiskSummary`
- 工具路径：`/api/wecom/risks`
- 请求方法：`GET`
- 输入参数：无
- 输出参数：`summary`，类型 `String`

企业微信里已验证机器人可以回答：

```text
你现在有什么功能，项目进展如何？
```

当前只读查询链路已经可用。写入链路，例如提交站会、领取任务、更新进度，接口已有基础能力，但企业微信插件工具还需要继续配置和打磨。

### 5. 任务分工领取栏

原先分工领取能力主要藏在接口和独立页面里，不够明显。现在已经补到基础操作流里。

已完成内容：

- 总览任务表新增 `今日领取` 列。
- 每个任务可以直接看到今天谁领取、领取状态是什么。
- 总览任务表每行提供 `领取` 快捷按钮。
- `分工领取` 页面顶部新增固定领取栏：
  - 选择领取人
  - 选择任务
  - 填写今日计划说明
  - 确认领取
- 领取、完成、取消后会刷新总览任务表和分工页。

相关接口：

```text
GET /api/assignments
POST /api/assignments
PATCH /api/assignments/:id
DELETE /api/assignments/:id
```

分工领取的目标不是简单记录“谁拿了什么”，而是作为晚会对账的输入。晚会报告会对照昨日领取、今日 GitHub commit 和 AI Review 风险，判断任务是否真的推进。

### 6. 开发阶段对照清单

这是当前最关键的新增能力。此前任务分工主要依据任务列表和晚会规则，现在新增了一个阶段目标对照层，避免“任务在流动，但不知道是否对准当前阶段目标”。

接口：

```text
GET /api/stage/checklist
```

当前默认阶段：

```text
CUE 项目中枢 MVP
目标日期：2026-05-15
```

当前默认阶段清单包含 5 个目标项：

1. 真实仓库信号接入
2. AI Review 阻断规则闭环
3. 站会与任务领取闭环
4. 阶段目标拆解与调整
5. 企业微信项目指挥入口

每个目标项会自动对照：

- 关联任务
- 负责人
- 任务状态和进度
- Cue.AI Git commit 证据
- AI Review 结论
- 今日/昨日任务领取
- 缺口项

缺口项包括：

- 缺少关联任务
- 缺少 Git 提交证据
- 晚会未领取或未登记
- 存在阻断 Review

对照清单输出状态：

- `已完成`
- `推进中`
- `高风险`
- `阻塞`
- `待补证据`

前端总览页的“当前阶段”模块下已经展示这份清单，并新增独立的“路径图”页签。路径图把每个阶段目标渲染成类似游戏副本的路线节点，节点中展示负责人、进度、状态、关联任务、Git/Review/领取证据和下一步缺口。之后晚会分工应该优先围绕路径图里的 `阻塞`、`高风险`、`待补证据` 节点展开，而不是只看当前任务列表。

### 7. AI 产品经理：从目标仓库文档生成任务

Claude 刚刚新增的重点能力已经合入 `main`：项目中枢现在不只看 GitHub commit，也可以读取 `Cue.AI` 目标仓库的 `docs/` 计划文档，把阶段计划解析成可执行任务，并把执行进度写回目标仓库。

核心模块：

```text
server/services/docsManager.js
```

已完成内容：

- 从目标仓库 `CUEAITECH/Cue.AI` 读取 `docs/*.md`。
- 自动跳过商业计划、用户场景、核心指标、技术选型、功能优先级、README、既有阶段进度追踪等非任务文档。
- 调用 Claude 将开发计划解析成结构化任务：
  - 标题
  - 负责人
  - 优先级
  - 来源文档
  - 任务描述
  - 截止时间
  - 状态
- 按 `title + sourceDoc` 去重后导入项目中枢任务板。
- 默认只从候选任务中选择少量 P0/P1 近期可领取任务导入，避免一次性把整阶段 backlog 全部塞进任务板。
- 将解析快照缓存到 `store.docTasks[projectId]`，用于后续进度对照。
- 基于当前任务真实状态、今日分工领取情况和文档解析任务，生成 `docs/阶段进度追踪.md`。
- 通过 GitHub Contents API 将 `docs/阶段进度追踪.md` 写回 `CUEAITECH/Cue.AI` 仓库。

前端总览页的 Cue.AI 项目卡片已经新增两个操作按钮：

```text
从文档导入任务
更新文档进度
```

相关接口：

```text
POST /api/projects/:id/sync-docs
POST /api/projects/:id/update-docs
POST /api/projects/:id/daily-scan
```

接口含义：

- `sync-docs`：读取目标仓库 `docs/`，用 Claude 解析候选任务，并默认导入少量近期可领取任务。
- `update-docs`：把 Hub 内的任务状态、今日领取情况写回 `docs/阶段进度追踪.md`。
- `daily-scan`：串联 GitHub commit 同步、文档任务导入、阶段进度写回，适合后续做每日自动任务。

默认导入数量由环境变量控制：

```env
DOC_TASK_IMPORT_LIMIT=8
```

也可以临时通过 query 参数覆盖：

```text
POST /api/projects/cue_ai_classroom/sync-docs?limit=5
POST /api/projects/cue_ai_classroom/daily-scan?limit=5
```

这部分解决了一个关键问题：任务分工不再只依赖 Hub 里的默认 seed 数据，而是可以从 `Cue.AI` 当前阶段文档里提取。后续晚会分工应该以“目标仓库 docs 计划 -> AI 解析任务 -> Hub 任务板 -> 成员领取 -> GitHub 证据 -> 进度写回”作为主链路。

注意事项：

- `update-docs` 需要 `GITHUB_TOKEN` 具备目标仓库内容写权限。
- 如果目标仓库属于组织，token 的 Resource owner 必须选组织，并完成对应仓库授权或 SSO/审批。
- 当前导入任务仍建议在晚会前由负责人快速复核，避免 Claude 将背景说明误解析成开发任务。
- `docs/阶段进度追踪.md` 是自动生成文件，后续应避免人工大段改写；人工修正建议回到原始计划文档或 Hub 任务板。

### 8. 晚会闭环

项目中枢已经具备晚会前后闭环的基础能力。

会前：

- 同步 Cue.AI GitHub commit
- 扫描 AI Review 风险
- 对照前一天任务领取和今日 commit
- 生成会前报告
- 生成下一步细化目标

会中：

- 成员领取任务
- 登记今日计划
- 登记阻塞项
- 记录站会信息

会后：

- 生成会后总结
- 更新任务进度
- 更新阶段进度
- 输出计划调整建议
- 可推送企业微信

核心入口：

```text
POST /api/reports/evening
GET /api/reports/evening
GET /api/reports/compare
POST /api/meeting/summary
GET /api/plan-adjustments
```

调度器会在晚会前自动生成作战包。默认晚会时间为 18:00，系统会在 17:45 自动触发。

相关环境变量：

```env
MEETING_HOUR=18
```

### 9. 数据持久化和迁移

项目中枢使用 JSON 文件持久化：

```text
server/data/db.json
```

该文件不提交到 Git，生产运行时会持续写入。初始数据来自：

```text
server/data/seed.json
```

`server/store.js` 负责：

- 读取 seed/db
- in-memory cache
- 全量保存
- 结构迁移
- 旧数据修正

目前已经加入的迁移包括：

- 补齐 `projects`
- 补齐 `assignments`
- 补齐 `standups`
- 补齐 `eveningReports`
- 补齐 `reports`
- 补齐 `planAdjustments`
- 补齐 `currentStage`
- 补齐 `currentStage.checklist`
- 补齐 `docTasks`
- 旧 repo 名统一归并到 `CUEAITECH/Cue.AI`
- 删除旧 seed demo review
- 删除 activity diff，避免 db.json 过大

## 当前 MVP 能力总览

当前已经具备的能力：

- Cue.AI 真实仓库接入
- GitHub 远端自动同步
- GitHub 作者映射到中文成员
- Cue.AI docs 计划文档读取
- Claude 解析开发任务
- 解析任务导入 Hub 任务板
- 自动生成并写回 `docs/阶段进度追踪.md`
- AI Review 队列
- Claude 优先、规则引擎兜底
- 风险扫描
- 任务看板
- 分工领取
- 异步站会
- 会前报告
- 会后总结
- 日报
- 晚报
- 昨日任务领取 vs 今日 commit 对照
- 阶段开发目标对照清单
- 开发路径图 / 副本路线视图
- 企业微信只读查询插件
- 企业微信 Markdown 推送基础能力
- API Key 写接口鉴权
- Nginx + HTTPS 部署
- PM2 后台运行
- JSON 持久化和自动迁移

当前仍需继续完善的能力：

- 企业微信写接口工具配置，例如领取任务、提交站会、更新进度。
- 文档解析任务导入前的人工确认和批量编辑。
- `docs/阶段进度追踪.md` 与 Hub 任务 ID 的双向映射。
- AI 自动把 commit 更准确地关联到阶段目标和任务。
- 阶段目标清单可在前端编辑。
- 风险项能一键转成晚会分工。
- 企业微信用户 userid 与团队成员映射。
- GitHub Webhook 签名生产化配置。
- 更细粒度权限和审计日志。

## 本地运行

要求：

```text
Node.js >= 18
```

安装依赖：

```bash
npm install
```

启动：

```bash
npm run dev
```

默认访问：

```text
http://127.0.0.1:4317
```

语法检查：

```bash
npm run check
```

## 生产部署

当前生产部署方式：

- 阿里云 ECS
- Node.js
- PM2
- Nginx
- Let's Encrypt HTTPS
- 域名：`hub.cueai.top`

服务目录：

```text
/opt/CUE-Project-Hub
```

更新生产代码：

```bash
cd /opt/CUE-Project-Hub
git pull --ff-only origin main
npm run check
pm2 restart cue-project-hub --update-env
```

检查服务：

```bash
pm2 status
pm2 logs cue-project-hub --lines 120 --nostream
curl -i http://127.0.0.1:3000/api/health
curl -i https://hub.cueai.top/api/health
```

当前 Nginx 反代应指向：

```text
http://127.0.0.1:3000
```

PM2 启动后日志里应看到：

```text
地址：http://127.0.0.1:3000
Hub：https://hub.cueai.top
GITHUB_AUTO_SYNC   ✅ 每 10 分钟同步一次
```

## 环境变量

参考 `.env.example`。

核心配置：

```env
PORT=3000
HOST=127.0.0.1

ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=

GITHUB_TOKEN=
GITHUB_SYNC_INTERVAL_MINUTES=10
GITHUB_SYNC_LIMIT=20
GITHUB_SYNC_DIFF_LIMIT=5
DOC_TASK_IMPORT_LIMIT=8

CUE_API_KEY=
WECOM_WEBHOOK_URL=
HUB_URL=https://hub.cueai.top
MEETING_HOUR=18
```

说明：

- `PORT` / `HOST`：生产环境应与 Nginx upstream 保持一致。
- `ANTHROPIC_API_KEY`：启用 Claude。
- `ANTHROPIC_BASE_URL`：第三方代理地址，可留空。
- `GITHUB_TOKEN`：访问组织私有仓库或提升 GitHub API 限额。
- `DOC_TASK_IMPORT_LIMIT`：从 Cue.AI docs 解析出的候选任务中，每轮最多导入多少个到 Hub 任务板，默认 8，最大 20。
- `CUE_API_KEY`：写接口鉴权。配置后所有 `POST/PATCH/DELETE /api/*` 需要请求头 `X-CUE-API-Key`。
- `WECOM_WEBHOOK_URL`：企业微信群机器人 Webhook。用于主动推送。
- `HUB_URL`：企微消息中的链接地址。
- `MEETING_HOUR`：晚会时间，默认 18。

## API 总览

### 状态查询

```text
GET /api/health
GET /api/config
GET /api/state
GET /api/stage/checklist
GET /api/openapi.json
```

### 项目和 GitHub 同步

```text
GET /api/projects
PATCH /api/projects/:id
POST /api/projects/:id/sync-github
POST /api/projects/:id/sync-local-git
POST /api/projects/:id/sync-docs
POST /api/projects/:id/update-docs
POST /api/projects/:id/daily-scan
```

当前主项目 ID：

```text
cue_ai_classroom
```

虽然 ID 仍保留历史命名，但它现在代表的是：

```text
CUEAITECH/Cue.AI
```

其中 `sync-docs`、`update-docs`、`daily-scan` 是 AI 产品经理链路：

- `sync-docs` 从 `CUEAITECH/Cue.AI/docs` 解析候选任务，并按优先级选取少量任务导入 Hub。
- `update-docs` 写回 `CUEAITECH/Cue.AI/docs/阶段进度追踪.md`。
- `daily-scan` 将 commit 同步、docs 解析、进度写回串成一次完整扫描。

### 任务

```text
GET /api/tasks
POST /api/tasks
PATCH /api/tasks/:id
DELETE /api/tasks/:id
```

### AI 排期

```text
POST /api/plans
POST /api/plans/apply
GET /api/plan-adjustments
```

### AI Review

```text
POST /api/reviews
```

### 风险

```text
POST /api/risks/scan
```

### 站会

```text
GET /api/standups
POST /api/standups
POST /api/standups/summarize
```

### 分工领取

```text
GET /api/assignments
POST /api/assignments
PATCH /api/assignments/:id
DELETE /api/assignments/:id
```

### 报告和晚会

```text
POST /api/reports/daily
GET /api/reports/evening
POST /api/reports/evening
GET /api/reports/compare
POST /api/meeting/summary
```

### 企业微信

```text
GET /api/wecom/summary
GET /api/wecom/risks
POST /api/wecom/push
```

### GitHub Webhook

```text
POST /api/webhooks/github
```

## 企业微信配置记录

企业微信 API 插件配置：

- 插件名称：`CUE 项目中枢`
- 插件 URL：`https://hub.cueai.top`
- 请求头：只读工具可留空
- 授权方式：只读工具可不启用

已建议配置的只读工具：

```text
getWeComProjectSummary -> GET /api/wecom/summary -> 输出 summary:String
getWeComRiskSummary    -> GET /api/wecom/risks   -> 输出 summary:String
```

企业微信能返回的内容包括：

- 当前项目状态
- 当前健康度
- 当前阶段进展
- 当前重点任务
- 今日风险
- 晚会优先处理事项
- 最近提交
- AI Review 阻断信息

后续要继续配置的写入工具：

```text
claimTask      -> POST /api/assignments
submitStandup  -> POST /api/standups
scanRisks      -> POST /api/risks/scan
generateReport -> POST /api/reports/daily
```

写接口需要请求头：

```text
X-CUE-API-Key: <CUE_API_KEY>
```

## Cue.AI GitHub 提交原则

所有 Cue.AI 仓库后续统一遵守以下规则：

1. 每个任务必须先有明确目标、负责人、截止时间和验收标准。
2. 每个分支必须对应一个任务或明确的修复目标。
3. 每个 commit 标题必须使用规范前缀，例如 `feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`、`merge:`。
4. commit 标题必须能说明业务或技术意图，不能只写 `update`、`fix bug`、`changes` 这类无信息标题。
5. 涉及功能开发、接口变更、权限、认证、支付、数据结构、部署配置的提交，必须关联任务、issue、PR 或阶段目标。
6. 单个 PR 应尽量聚焦一个目标；超过 500 行核心变更时，优先拆分。
7. 高风险模块必须补充测试说明或人工审阅说明。
8. 不能提交密钥、token、密码、私有证书、真实用户隐私数据。
9. PR 合并前必须通过 AI Review；阻断级问题必须先处理或由负责人明确豁免。
10. 站会、请假、延期和阻塞必须在项目中枢中留下可追踪记录。

更完整的仓库规则见：

```text
.github/CUE_AI_GITHUB_RULES.md
```

## 当前开发判断

目前 MVP 的关键基础链路已经成立：

```text
Cue.AI GitHub 仓库
  -> docs/阶段计划文档
  -> AI 产品经理解析任务
  -> Hub 任务板
  -> GitHub 自动同步
  -> AI Review
  -> 风险扫描
  -> 阶段目标对照清单
  -> 任务领取
  -> 晚会报告
  -> docs/阶段进度追踪.md 写回
  -> 企业微信查询
```

下一阶段开发不应该继续堆普通看板功能，而应该围绕“闭环是否真实”推进：

1. 让文档解析任务支持人工确认、批量调整和一键入板。
2. 让企业微信能直接完成领取任务、提交站会、更新进度。
3. 让 AI 根据阶段清单自动建议今晚该分配什么任务。
4. 让 commit/PR 更准确地关联任务和阶段目标。
5. 让 `docs/阶段进度追踪.md` 和 Hub 任务状态形成稳定双向对账。
6. 让风险项一键转成晚会行动项。
7. 加强权限、审计和数据备份。
