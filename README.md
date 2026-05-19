# CUE 项目中枢

CUE 项目中枢是 Cue.AI 团队内部使用的 AI 研发交付指挥系统。把阶段目标、任务分工、GitHub 提交、AI Review、异步站会、晚会复盘、风险提醒和企业微信机器人串成可追踪的研发闭环。

**公网地址：** https://hub.cueai.top  
**跟踪仓库：** `CUEAITECH/Cue.AI`（产品仓库）  
**自身代码：** `CUEAITECH/CUE.AI-Hub`

---

## 核心功能

### 外层登录与项目入口
- 访问 Hub 时先进入独立登录页，选择要管理的项目，再输入内部账号密码
- 登录成功后进入单一项目上下文，页面内不再显示仓库切换、仓库新增或仓库删除入口
- 当前项目 ID 会保存在浏览器本地，下次进入时默认使用上一次选择的项目
- 默认只初始化一个项目管理员账号；项目管理员可以在登录页为当前项目注册开发账号
- 开发账号绑定具体项目，后续任务认领、站会、审阅确认可以继续接入成员身份审计
- 登录接口：`POST /api/auth/login`
- 注册账号接口：`POST /api/auth/users`，需要项目管理员凭据或管理员会话
- 默认项目管理员：`admin / cueai`，生产环境必须通过 `HUB_ADMIN_USER`、`HUB_ADMIN_PASSWORD` 覆盖
- 页面右上角连接状态按访问来源展示：`localhost/127.0.0.1` 显示本地 API，`hub.cueai.top` 等公网域名显示远端 API

### 任务看板
- 创建、编辑、删除任务，追踪进度、负责人、风险等级和截止日期
- 关联 GitHub commit / PR / branch 作为完成证据
- 任务详情页展示完整上下文：进度、证据、AI 审阅、领取记录

### 分工领取
- 任务卡片直接点成员名字一键认领，无需填写表单
- 认领立即生效，AI 任务细则（brief）异步生成，详情页自动轮询展示
- 同一人同一任务同一天只保留一条记录，防重复领取
- **跨日续显**：前一天未完成且今日未重新认领的分工，自动带「续」标签显示在分工页，不丢失上下文
- 按优先级排序展示前 10 条任务；打回的审阅修复任务自动置顶

### AI 代码审阅
- 每次 GitHub 同步自动对新 commit 运行 AI Review
- 四级结论：`Pass` / `Warning` / `Block` / `Escalate`
- **人工审阅子页面**：左栏待办队列，右栏展示 commit 详情、提交人、diff、AI 发现的问题
- AI 按需生成 2-3 个具体解决方案（带工作量评估），选择后一键建任务跟进
- 决策：**通过** 或 **打回原负责人**（自动建任务，置顶出现在分工领取）
- 决策结果记录到审阅历史，不重复触发 LLM
- 晚会前 2 小时自动推送企业微信提醒

### 路径图
- 按开发阶段分组展示节点（阶段标题 + 背景色区分），阶段状态由节点自动推断
- LLM 从 `docs/` 文档中提炼阶段划分，一键扫描时同步更新
- 大计划调整需人工审批：默认展示 AI 主方案 + 不更改，点「更多方案」懒加载 2 个备选（保守/激进），可选择后批准

### 风险引擎
- 规则扫描：任务到期未完成、超 24 小时无更新、缺少 Git 关联
- AI 混合分析：语义关联任务/commit/阶段，生成置信度和建议行动
- 健康度评分（0-100），项目级风险汇总

### 晚会闭环
每日 18:00 晚会，17:45 自动生成作战包推送企微：
1. **会前**：提交 → AI Review → 风险扫描 → 作战包推送
2. **会中**：成员在分工页点名认领任务
3. **会后**：生成会后总结推送企微，包含今日分工和明日重点

### AI 产品经理
- 从目标仓库 `docs/` 读取计划文档，LLM 解析结构化候选任务
- **同步读取阶段划分**：扫描文档时同步生成 2-5 个开发阶段（后端基础 / 多端联调 / 验收上线等），写入路径图
- 自动导入优先级最高的近期任务到任务板
- 将 hub 任务真实进度写回目标仓库 `docs/阶段进度追踪.md`

### 企业微信集成
- 晚会作战包、会后总结、人工审阅提醒自动推送
- 风险摘要可手动触发推送
- **AI 插件**：企业微信内直接查询任务列表、认领任务、提交站会、更新进度、记录任务完成/晚会出席反馈（通过 OpenAPI spec 自动发现工具）
- `WECOM_WEBHOOK_URL` 负责出站推送；成员回复要写回 Hub 时，需要由企业微信智能机器人/API 插件调用 `/api/wecom/command` 或 `/api/wecom/attendance`
- 对团队只暴露一个机器人名称：`WECOM_BOT_NAME`（默认 `CUE项目中枢`）。出站 webhook 和入站 API 插件都使用同一个名称，成员只需要记住 `@CUE项目中枢`
- 考勤反馈支持带 `@机器人` 的原始消息，例如：`@CUE项目中枢 林世棋正常完成`、`@CUE项目中枢 林世棋延迟出席`
- `/api/wecom/command` 是模块化指令入口，不调用大语言模型。建议在企业微信智能机器人里配置快捷按钮：`每日排名`、`每周排名`、`晚会统计`、`任务完成统计`、`今日考勤`、`菜单`

企业微信群内建议固定成两类入口：

```text
每日晚报：只负责定时推送提醒。
CUE项目中枢：成员 @ 它或点击按钮完成查询/回写。
```

成员常用操作：

```text
@CUE项目中枢 菜单
@CUE项目中枢 每日排名
@CUE项目中枢 每周排名
@CUE项目中枢 晚会统计
@CUE项目中枢 任务完成统计
@CUE项目中枢 今日考勤
@CUE项目中枢 林世棋正常完成
@CUE项目中枢 林世棋正常出席
```

### 异步站会
- 成员提交昨日完成、今日计划、阻塞项
- AI 汇总后推送企微

---

## 部署

### 环境要求
- Node.js 18+
- PM2（进程管理）

### 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API Key，缺失时降级为规则引擎 |
| `GITHUB_TOKEN` | GitHub PAT，缺失时匿名限速 60次/小时 |
| `WECOM_WEBHOOK_URL` | 企业微信群机器人 Webhook |
| `WECOM_BOT_NAME` | 成员在群里看到和 @ 的统一机器人名称，默认 `CUE项目中枢` |
| `CUE_API_KEY` | 写接口鉴权（可选，不配置则写接口开放） |
| `HUB_ADMIN_USER` | 初始项目管理员账号（默认 `admin`，兼容旧变量 `HUB_LOGIN_USER`） |
| `HUB_ADMIN_PASSWORD` | 初始项目管理员密码（默认 `cueai`，兼容旧变量 `HUB_LOGIN_PASSWORD`） |
| `CUE_SESSION_SECRET` | Hub 登录会话签名密钥（可选，默认复用 `CUE_API_KEY` / 管理员密码） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 邮箱验证码发信配置；未配置时验证码仅在页面提示中显示 |
| `MEETING_HOUR` | 晚会时间（默认 18），作战包在 `MEETING_HOUR-1:45` 推送 |
| `PORT` | 服务端口（默认 4317） |
| `HUB_URL` | 对外访问地址，用于企微消息链接 |

### 启动

```bash
npm install
npm run dev        # 开发
pm2 start server/index.js --name cue-project-hub  # 生产
```

### 自动部署（GitHub Actions）

每次 push 到 `main` 分支自动通过 rsync 部署到服务器并重启 PM2。使用 `webfactory/ssh-agent` 注入 SSH 私钥，`db.json` 和 `.env` 排除在同步之外，服务器数据不受代码更新影响。

需在 GitHub 仓库 Settings → Secrets 配置：

| Secret | 说明 |
|--------|------|
| `SERVER_HOST` | 服务器公网 IP |
| `SERVER_USER` | SSH 用户名 |
| `DEPLOY_PATH` | 部署路径，如 `/opt/CUE.AI-Hub` |
| `HANGZHOU_SERVER` | 服务器 SSH 私钥（原始 PEM 格式） |

### 数据管理

**自动备份：** 每次数据写入前，`store.js` 自动将 `db.json` 备份为 `db.backup.json`，始终保留上一个版本。

**紧急恢复：**
```bash
cp /opt/CUE.AI-Hub/server/data/db.backup.json /opt/CUE.AI-Hub/server/data/db.json
pm2 restart cue-project-hub --update-env
```

**重置为初始数据（危险，不可恢复）：**
```bash
# 建议先手动备份
cp /opt/CUE.AI-Hub/server/data/db.json ~/db.$(date +%Y%m%d).json
# 再删除，重启后从 seed.json 重新初始化
rm /opt/CUE.AI-Hub/server/data/db.json && pm2 restart cue-project-hub --update-env
```

---

## 技术架构

```
server/index.js              HTTP 启动、鉴权、调度器、静态文件、共享编排函数
server/store.js              JSON 文件读写 + in-memory cache + 数据迁移
server/routes/
  index.js                   routeModules 顺序分发器
  systemRoutes.js            health/config/state/openapi/tasks/members 读接口
  planningRoutes.js          路径图、AI 混合分析、风险扫描、计划调整审批
  projectRoutes.js           项目配置、GitHub 同步、docs 同步、daily-scan
  taskRoutes.js              任务 CRUD、AI 进度估算、AI 排期应用
  reviewRoutes.js            AI Review、人工审阅队列、解决方案、审阅修复任务
  assignmentRoutes.js        晚会分工领取、任务细则生成
  standupRoutes.js           异步站会、站会汇总
  reportRoutes.js            日报、晚报、会后总结、分工 vs commit 对照
  wecomRoutes.js             企业微信插件工具接口
  webhookRoutes.js           GitHub webhook 接收与签名校验
server/services/
  claude.js                  Claude API 封装（prompt caching，失败返回 null）
  reviewer.js                AI 代码审阅（LLM + 规则降级）
  planner.js                 AI 任务规划
  riskEngine.js              风险扫描 + 健康度计算
  semanticLinker.js          AI 语义关联分析（任务/阶段/commit）
  bindingEngine.js           显式绑定引擎（activity/assignment → task/deliverable）
  dailyBrief.js              晚会作战包逻辑
  assignmentBrief.js         任务细则生成（异步）
  docsManager.js             AI 产品经理：读写目标仓库 docs/
  githubApi.js               GitHub REST API v3
  wecom.js                   企业微信推送
server/data/
  seed.json                  初始数据
  db.json                    运行时数据（.gitignore，不提交）
src/app.js                   单文件前端（无框架，浏览器原生 ESM）
src/styles.css
index.html                   8 个页面 section
```

**Phase 0 路由拆分状态：** 已完成。`server/index.js` 不再直接承载业务 API 分支，所有对外 API 已按领域拆到 `server/routes/*`。本阶段只做行为保持型重构，不改变现有 JSON 数据模型，也不启动 Deliverable/Phase 外键迁移。后续 Phase 1 才进入交付项中心数据模型迁移。

**Phase 1 数据模型迁移状态：** 已完成兼容层。`migrateStore` 会从旧 `currentStage.checklist` 生成顶层 `deliverables[]`，从旧 `currentStage.phases` 生成顶层 `phases[]`，并为 `tasks`、`activities`、`assignments` 补齐 `deliverableId` / `projectId` 等 FK 字段。`GET /api/state` 已返回 `deliverables`、`phases` 和 `deliverableProgress`。

**Phase 2 显式绑定引擎状态：** 已完成。路径图评分已切换为 FK-first：任务优先按 `task.deliverableId` 关联交付项，commit 和 assignment 优先按 `activity.deliverableId` / `activity.taskId` / `assignment.deliverableId` / `assignment.taskId` 取证；没有显式 FK 时才回退到语义链接和关键词规则。GitHub 同步与 webhook 入库会尝试为新 activity 持久化 `taskId` / `deliverableId`，Hub 和企业微信认领任务时也会写入 `deliverableId`。`migrateStore` 会在读库时调用 `rebindStoreExplicitRefs`，为旧 task、activity、assignment 尽量补齐 FK。`/api/state` 和 `/api/stage/checklist` 会返回每个节点的 `binding` 诊断信息，前端路径图显示“显式 FK / AI 语义 / 关键词兜底”的来源、强弱和解释。回归测试与 smoke 测试覆盖 FK 优先、commit 绑定、assignment 绑定、历史回填、绑定诊断和 Phase 0/1 兼容路径。

**Phase 3 双向文档同步状态：** 已完成第一刀。`fetchProjectDocs` 会读取 `docs/阶段进度追踪.md`，但 `parseDocsForTasks` 不再从该文件生成任务；`parseProgressDoc` 只读取 ✅/🔶/⬜ 状态。`sync-docs` 会按 `deliverableTitle` 查找或创建 deliverable，并把导入任务写入 `deliverableId`；如果进度文档将某个交付项标为 ✅，Hub 只写入 `docSuggestComplete`，等待人工确认，不会自动完成。`update-docs` 已切换为 deliverable-first，从 `store.deliverables` 生成阶段进度追踪文档。

**Phase 3.2 任务完成确认状态：** 已完成。分工领取或任务详情中的“确认任务完成”会先更新 assignment，再同步把关联 task 标记为 `已完成`、`progress=100`，并记录 `completionSource=assignment`。任务详情会展示所属 deliverable、文档侧完成建议和完成证据；路径图只提示交付项/文档状态，不替代成员对具体任务的完成确认。

**Phase 4 多项目上下文状态：** 已完成前两刀。`GET /api/state?projectId=...` 和 `GET /api/stage/checklist?projectId=...` 已按项目过滤任务、提交、分工、审阅、风险、阶段和交付项，同时保留完整 `projects[]` 供入口选择。`projectRoutes` 支持项目创建、更新和保守删除；默认项目和已有研发数据的项目不能删除。企业微信插件接口 `summary`、`risks`、`tasks`、`claim`、`standup`、`progress` 均支持 `projectId`，OpenAPI 已暴露该参数。前端入口已改为外层登录页：先选择项目并登录，进入后固定在该项目上下文，不再在 Hub 内显示项目切换或新增仓库入口。下一刀计划是把普通任务、分工、站会、风险扫描 API 全部统一支持 `projectId`，让前端、企微和直接 API 调用保持完全一致。

**数据存储：** `server/data/db.json`，进程内 in-memory cache，单例读写。

**LLM 调用：** 所有调用走 `callClaude(systemPrompt, userPrompt)`，返回文本或 `null`（失败/无 key 时）。System prompt 固定，不含日期/用户输入，保持 prompt cache 有效。每个调用方必须处理 `null` 并降级。

**时区：** 所有日期操作使用 `Asia/Shanghai`，通过 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })` 转换。

## 评分标准

当前每日、每周、每月评分规则以 `server/services/scoring.js` 为准，前端排行榜和企业微信排名都复用这一套逻辑。

### 工作日口径

- 仅在公司工作日生成任务/晚会评分。
- 当前代码中，`周三` 和 `周六` 视为固定休息日，不产生日评分。
- 休息日产生的 commit 会顺延计入下一个工作日。
- 所有评分日期统一按 `Asia/Shanghai` 时区计算。

### 每日评分

每日总分满分 `100`，由两部分组成：

- `贡献分`：满分 70 分。
- `考勤分`：满分 30 分。

计算公式：

```text
贡献原始分 = 任务交付 + 有效 Commit + Review 质量 + 闭环表现
贡献分 = round(贡献原始分 * 0.7)
考勤分 = round(考勤原始分 * 3)
每日总分 = clamp(贡献分 + 考勤分, 0, 100)
```

#### 1. 任务交付贡献

- 满分 `40` 分。
- 只统计“当天认领”的 assignment。
- 若当天没有认领任务，按中性分 `28` 分处理。
- 按任务优先级加权计算完成率：
  - `P0` 权重 `1.5`
  - `P1` / 高风险 权重 `1.3`
  - `P2` / 中风险 权重 `1.1`
  - 其他默认权重 `1`
- 核心公式：

```text
完成率 = 已完成权重 / 总权重
任务交付分 = clamp(40 * 完成率 - 逾期扣分, 0, 40)
```

- 若任务未完成且 `due/dueDate` 早于当天，会产生逾期扣分。
- 逾期扣分按未完成逾期任务的权重占比折算，最大扣 `12` 分。

#### 2. 有效 Commit 贡献

- 满分 `25` 分。
- 只统计记到当天的 `commit activity`。
- 工作日之外产生的 commit，会按顺延规则归到下一个工作日。
- 已绑定 `taskId` 或 `deliverableId`` 的 commit 视为“有效绑定 commit”。
- 计分公式：

```text
commit 分 = clamp(绑定 commit 数 * 8 + 未绑定 commit 数 * 3 - max(0, 未绑定数 - 绑定数) * 2, 0, 25)
```

- 这意味着：
  - 绑定任务/交付项的 commit 分值更高。
  - 未绑定 commit 不是完全没分，但过多会触发额外扣分。

#### 3. Review 质量

- 满分 `20` 分。
- 统计当天由该成员产生的 review 记录。
- 若当天没有 AI Review，按中性分 `14` 分处理。
- 当天只要 Review 已覆盖，且没有未处理的 `Block` / `Escalate`，这一项不扣分，直接记满 `20` 分。
- 只有 `Block` / `Escalate` 在当天仍处于“未处理”状态时才扣分。
- “未处理”的判定口径：review 记录里还没有 `humanDecision`。
- 计分公式：

```text
Review 分 = clamp(20 - 未处理 Block 扣分 - 未处理 Escalate 扣分, 0, 20)
```

- 每条未处理 `Block` 扣 `5` 分。
- 每条未处理 `Escalate` 扣 `7` 分。
- 已经被人工标记为 `acknowledged`、`needs-fix`、`exempted` 的 review，不再重复扣分。

#### 4. 闭环表现

- 满分 `15` 分。
- 基础分 `5` 分。
- 有当天站会记录：`+4`
- 当天同时有 assignment 和 commit：`+4`
- 当天有任一 assignment 标记完成：`+2`

#### 5. 考勤分

- 折算后满分 `30` 分。
- 来自两类考勤记录，各占 50%：
  - `meeting`：晚会出勤
  - `task_completion`：任务完成反馈
- 系统分别记录两层状态：
  - `reportedStatus`：成员是否在机器人要求的时间窗口内做了汇报
  - `actualStatus`：成员实际是否完成任务/正常出席，或是否请假
- 两项先各自换算成 `0-10` 的原始分，再取平均，形成 `0-10` 的考勤原始分。
- 最后按 30% 权重折算成最终考勤分：

```text
考勤原始分 = round(晚会分 * 0.5 + 任务完成分 * 0.5)
考勤分 = round(考勤原始分 * 3)
```

状态分值如下：

| 状态 | 晚会出勤 | 任务完成反馈 |
|------|---------|-------------|
| `normal` | 10 | 10 |
| `delayed` | 10 | 8 |
| `approved_leave` | 10 | 10 |
| `temp_leave` / `temporary_leave` | 7 | 7 |
| `unreported_done` | 7 | 7 |
| `reported_incomplete` | 4 | 4 |
| `absent` | 0 | 0 |
| 其他 / 未知 | 6 | 6 |

#### 5.1 任务完成反馈口径

机器人每日会在群里发送：

```text
今日任务完成确认
请在 17:00-18:00 之间 @CUE项目中枢 回复：
- 姓名正常完成
- 姓名延迟完成
示例：@CUE项目中枢 林世棋正常完成
延迟完成默认要求第二个工作日补齐；如果后续请假，系统会把连续工作日作为一个评分窗口取平均。
```

评分规则：

- 在 `17:00-18:00` 内回复 `正常完成`，且任务实际完成：记满分。
- 在 `17:00-18:00` 内回复 `延迟完成`，且后续在规则窗口内补齐：不扣分。
- 没有在时间区间内汇报，但任务实际完成：扣小部分出勤分。
- 已汇报，但任务实际没有完成：扣分中等。
- 没汇报且没完成：扣分最多。
- 提前请假：不扣分。
- 临时请假：轻扣分。

当前实现对应原始分值：

| 情况 | 原始分 |
|------|------|
| 已汇报且完成 / 已说明延迟并补齐 | 10 |
| 未汇报但完成 | 7 |
| 已汇报但未完成 | 4 |
| 未汇报且未完成 | 0 |
| 提前请假 | 10 |
| 临时请假 | 7 |

#### 5.2 晚会出席口径

机器人每日会在群里发送：

```text
晚会出席确认
请在 18:25 前 @CUE项目中枢 回复：
- 姓名正常出席
- 姓名延迟出席
示例：@CUE项目中枢 林世棋正常出席
18:25-18:35 回复按临时请假/迟到处理；18:35 后仍无记录默认缺勤，可由人事管理补录。
```

评分规则：

- 在规定窗口内说明 `正常出席` 或 `延迟出席`，且实际正常参加：不扣分。
- 没有在窗口内汇报，但实际正常出勤：扣小部分出勤分。
- 已汇报，但实际没有按时正常出勤：扣分中等。
- 没汇报且没正常出勤：扣分最多。
- 提前请假：不扣分。
- 18:25-18:35 内回复或临时请假：轻扣分。

当前实现对应原始分值：

| 情况 | 原始分 |
|------|------|
| 已汇报且正常出席 / 已说明延迟出席 | 10 |
| 未汇报但正常出席 | 7 |
| 已汇报但未正常出席 | 4 |
| 未汇报且未正常出席 | 0 |
| 提前请假 | 10 |
| 临时请假 / 18:25-18:35 内说明 | 7 |

#### 5.3 考勤统计与查看方式

- 指挥栏下提供独立的“考勤统计”板块。
- 支持按周查看考勤，可切换查看任意一周。
- 周表格按成员展示每日两项记录：
  - 任务完成反馈
  - 晚会出勤
- 同时展示请假情况和周均考勤分排行，便于人事和管理者一眼识别异常成员。
- 当前权限口径：
  - `admin`、项目创始人和 `hr_manager` 可修改出勤记录
  - `project_admin` 和 `developer` 仅可读取出勤状况

### 每周评分

- 每周分不是重新跑一套独立规则，而是“本周所有工作日每日总分的平均值”。
- 只统计从“本周周一”开始，到查询日期为止的工作日。
- 若查询日期晚于今天，则自动截断到今天。

计算公式：

```text
每周总分 = round(本周各工作日 dailyScore 的平均值)
每周贡献分 = round(本周各工作日 contributionScore 的平均值)
每周考勤分 = round(本周各工作日 attendancePoints 的平均值)
```

- 排行默认按 `weeklyScore` 倒序。
- 若分数相同，再按 `contributionScore` 倒序。

### 每月评分与奖金口径

- 每月分同样是“当月各工作日每日总分的平均值”。
- `baseBonus` 估算公式：

```text
baseBonus = round(月评分 / 100 * totalBonus)
```

- `attendanceBonus` 额外全勤奖发放条件：
  - 当月 `attendanceBonusEligible` 比例 >= `90%`
  - 且 `monthlyScore >= 75`

- `attendanceBonusEligible` 的判定条件是：某日 `meetingStatus === normal` 且 `taskStatus === normal`。

--- 

## 团队成员

| 中文名 | GitHub 匹配模式 |
|--------|----------------|
| 田家铭 | jiaming, tian |
| 胡佳涛 | hjttu, hu |
| 罗子宽 | ryanlzk, luo |
| 林世棋 | lin |

新增成员在 `server/services/githubApi.js` 的 `authorMap` 数组中维护。

---

## 开发

```bash
npm run check    # 语法检查（node --check，无测试框架）
npm run dev      # 启动开发服务器，http://127.0.0.1:4317
```

Commit 规范：`feat:` / `fix:` / `docs:` / `refactor:` / `merge:` + 中文业务意图描述。不允许 `update`、`fix bug`、`改一下` 等无意义标题。
