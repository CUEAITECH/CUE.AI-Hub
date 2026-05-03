# CUE 项目中枢

CUE 项目中枢是独立于 CUE 课堂产品的新产品线，用 AI 管理研发交付闭环：阶段目标拆解、任务分工、Git 活动追踪、AI 提交审阅、异步站会、风险检测与自动提醒。

它不是再增加一个填表工具，而是尽量从 Git、PR、Review、CI 和站会回复中自动获取真实信号，让管理者看到项目风险，让成员少做重复汇报。

## 产品定位

CUE 项目中枢是 Cue.AI 团队内部先用起来的 AI 研发项目指挥系统。

核心目标：

- 把阶段目标自动拆成任务、负责人、截止时间和验收标准。
- 自动抓取 commit、push、PR、review、CI 和工作区状态。
- 对每次关键提交或 PR 进行 AI 审阅。
- 自动发现延期、无进展、PR 卡住、无 Git 关联、提交不规范等风险。
- 用私聊提醒、管理者日报和风险队列替代人工反复催进度。

## 开发阶段对照清单

项目中枢以 `GET /api/stage/checklist` 作为阶段目标对照入口。清单会把当前阶段拆成目标项，并自动对照：

- 当前任务和负责人
- 今日/昨日任务领取
- Cue.AI 仓库 Git 提交证据
- AI Review 结论
- 缺口项，例如缺少关联任务、缺少 Git 证据、晚会未领取、存在阻断 Review

晚会分工应优先围绕这个清单里的 `阻塞`、`高风险`、`待补证据` 项展开，而不是只看当前任务列表。

## 当前 MVP 能力

- AI 阶段目标拆解
- 任务看板：负责人、截止时间、进度、Git 信号、风险等级
- Cue.AI 内部项目接入
- 本地 Git 仓库扫描
- 最近 commit 和未提交文件追踪
- AI 代码审阅队列
- 团队负载与响应状态看板
- 自动提醒规则
- 本地 Node API
- JSON 文件持久化
- GitHub webhook 接收器
- 规则型 AI Review 与风险引擎

## 本地运行

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:4317
```

当前版本不需要安装第三方依赖，只使用 Node.js 内置模块。

## API

- `GET /api/state`：读取完整项目中枢状态
- `GET /api/projects`：读取已配置项目
- `POST /api/projects/:id/sync-local-git`：同步本地 Git 仓库
- `GET /api/tasks`：读取任务
- `POST /api/tasks`：创建任务
- `PATCH /api/tasks/:id`：更新任务
- `POST /api/plans`：根据阶段目标生成任务
- `POST /api/plans/apply`：把生成的任务应用到任务板
- `POST /api/reviews`：对提交标题、diff、文件列表运行 AI Review
- `POST /api/risks/scan`：扫描任务和审阅风险
- `POST /api/webhooks/github`：接收 GitHub webhook 事件

## Cue.AI 内部试点

默认接入项目：

```text
Cue.AI -> CUEAITECH/Cue.AI
```

点击页面中的 `同步 GitHub 远端` 后，系统会：

- 读取当前分支
- 通过 GitHub API 读取最近 commit
- 将已知 Git 作者映射到团队成员
- 为同步到的 commit 生成 AI Review
- 刷新项目健康度、风险队列和活动流

## GitHub Webhook

Webhook 地址：

```text
http://your-host/api/webhooks/github
```

建议启用事件：

- `push`
- `pull_request`
- `pull_request_review`

可选签名校验：

```bash
GITHUB_WEBHOOK_SECRET=your_secret npm run dev
```

## AI 规则引擎

当前版本先使用确定性规则，保证不依赖 API Key 也能运行：

- 排期引擎：根据阶段目标关键词生成任务、负责人、截止时间、依赖和验收标准。
- 审阅引擎：检测 token、密钥、认证、支付、权限、调试语句、TODO、大 PR、缺少测试、缺少任务关联。
- 风险引擎：检测任务延期、临近截止低进度、24 小时无更新、无 Git 关联、阻断级 AI Review。
- Cue.AI 同步：通过 GitHub API 扫描 `CUEAITECH/Cue.AI` 仓库，导入最近 commit 和 AI Review 结果。

下一步会把真实 LLM Provider 接入这些引擎，同时保留规则引擎作为兜底。

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

[.github/CUE_AI_GITHUB_RULES.md](./.github/CUE_AI_GITHUB_RULES.md)

## 产品拆分原则

- `CUEAITECH/Cue.AI`：当前项目中枢默认跟踪的真实产品仓库
- `CUEAITECH/CUE-Project-Hub`：项目中枢自身代码仓库

两个项目保持独立仓库、独立路线图和独立部署。CUE 项目中枢默认只跟踪 `Cue.AI` 产品仓库；自身仓库仅用于开发和部署项目中枢。
