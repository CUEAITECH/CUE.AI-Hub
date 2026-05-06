# CUE 项目中枢

CUE 项目中枢是 Cue.AI 团队内部使用的 AI 研发交付指挥系统。把阶段目标、任务分工、GitHub 提交、AI Review、异步站会、晚会复盘、风险提醒和企业微信机器人串成可追踪的研发闭环。

**公网地址：** https://hub.cueai.top  
**跟踪仓库：** `CUEAITECH/Cue.AI`（产品仓库）  
**自身代码：** `CUEAITECH/CUE.AI-Hub`

---

## 核心功能

### 任务看板
- 创建、编辑、删除任务，追踪进度、负责人、风险等级和截止日期
- 关联 GitHub commit / PR / branch 作为完成证据
- 任务详情页展示完整上下文：进度、证据、AI 审阅、领取记录

### 分工领取
- 任务卡片直接点成员名字一键认领，无需填写表单
- 认领立即生效，AI 任务细则（brief）异步生成，详情页自动轮询展示
- 同一人同一任务同一天只保留一条记录，防重复领取
- **跨日续显**：前一天未完成且今日未重新认领的分工，自动带「续」标签显示在分工页，不丢失上下文

### AI 代码审阅
- 每次 GitHub 同步自动对新 commit 运行 AI Review
- 四级结论：`Pass` / `Warning` / `Block` / `Escalate`
- **人工审阅子页面**：左栏待办队列，右栏展示 commit 详情、提交人、diff、AI 发现的问题
- AI 按需生成 2-3 个具体解决方案（带工作量评估），选择后一键建任务跟进
- 决策结果（通过 / 需修复 / 豁免）记录到审阅历史，不重复触发 LLM
- 晚会前 2 小时自动推送企业微信提醒

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
- 自动导入优先级最高的近期任务到任务板
- 将 hub 任务真实进度写回目标仓库 `docs/阶段进度追踪.md`

### 企业微信集成
- 晚会作战包、会后总结、人工审阅提醒自动推送
- 风险摘要可手动触发推送
- **AI 插件**：企业微信内直接查询任务列表、认领任务、提交站会、更新进度（通过 OpenAPI spec 自动发现工具）

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
| `CUE_API_KEY` | 写接口鉴权（可选，不配置则写接口开放） |
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

---

## 技术架构

```
server/index.js              路由总入口（顺序 if-else 匹配）
server/store.js              JSON 文件读写 + in-memory cache + 数据迁移
server/services/
  claude.js                  Claude API 封装（prompt caching，失败返回 null）
  reviewer.js                AI 代码审阅（LLM + 规则降级）
  planner.js                 AI 任务规划
  riskEngine.js              风险扫描 + 健康度计算
  semanticLinker.js          AI 语义关联分析（任务/阶段/commit）
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

**数据存储：** `server/data/db.json`，进程内 in-memory cache，单例读写。

**LLM 调用：** 所有调用走 `callClaude(systemPrompt, userPrompt)`，返回文本或 `null`（失败/无 key 时）。System prompt 固定，不含日期/用户输入，保持 prompt cache 有效。每个调用方必须处理 `null` 并降级。

**时区：** 所有日期操作使用 `Asia/Shanghai`，通过 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })` 转换。

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
