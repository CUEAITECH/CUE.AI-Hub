# PR 流全面切换设计文档

**日期：** 2026-05-20  
**作者：** Dirtortian × Claude  
**状态：** 待实现

---

## 1. 背景与目标

CUE Project Hub 当前以 commit 为最小工作单元：每次 push 触发 webhook → reviewer 评分 → 进度估算 → 晚会对账。这套流程的主要缺陷：

- 一次功能可能对应 5-20 个 commit，评审噪音大，进度抖动
- commit 粒度下无法判断"功能是否真正完成"
- PR-Agent（Qodo AI）本身针对 PR 单元设计，在 commit 流下功能无法完全发挥
- 团队没有统一的 PR 习惯，导致 review 体验割裂

**目标：** 以 Pull Request 为最小交付单元，将 PR-Agent 作为开发侧代码 review 引擎（运行在 GitHub Actions），Hub 作为业务侧合规追踪系统（中文 AC 验收、任务进度、晚会对账），两者通过 pr-agent webhook sink 打通数据流。

---

## 2. 核心约束与不变量

| 约束 | 说明 |
|------|------|
| 技术栈不变 | Node.js 18+ ESM，零框架，`@anthropic-ai/sdk` 唯一依赖 |
| 数据格式向后兼容 | `store.reviews` 保留，`store.pulls` 新增，历史数据迁移写在 `migrateStore()` |
| C+ bypass 合规 | `hotfix/*` 分支可直连 main，但必须在 24h 内补 PR；通过 `main-push-policy.yml` 记录并追踪 |
| 晚会对账不断流 | 迁移期间（Phase 0-2）晚会仍走原 commit 流；Phase 3 完成后切换为 PR 流 |
| PR-Agent 部署方式 | GitHub Actions（方案 B）：零服务器维护，每仓库一个 `pr-agent.yml`，Hub 通过 `/api/webhooks/pr-agent` 接收结果 |
| 双轨并行 | PR-Agent 输出 Markdown review（给开发者看），Hub 解析其合规结论（中文 AC 对账） |
| LLM 调用规范 | 不变：`callClaude(system, user)`，system 不含动态内容，结果可 null |

---

## 3. 数据模型

### 3.1 `store.pulls`（新增集合）

```js
{
  id: string,                    // createId()
  projectId: string,
  number: number,                // GitHub PR number
  title: string,
  body: string,                  // PR description (含 AC checklist)
  state: 'open' | 'merged' | 'closed',
  author: string,                // authorMap 映射后的中文名
  headBranch: string,
  baseBranch: string,
  linkedTaskIds: string[],       // 解析出的任务引用，如 ['task-xxx']
  prAgentReview: {               // PR-Agent 输出（从 webhook 接收）
    score: number | null,        // 0-100
    compliance: {                // TicketCompliance schema
      done: string[],
      notDone: string[],
      needsHumanCheck: string[]
    } | null,
    issues: Array<{              // PR-Agent 报告的问题
      severity: 'critical' | 'major' | 'minor',
      file: string,
      line: number | null,
      description: string
    }>,
    rawUrl: string | null        // GitHub PR review comment URL
  } | null,
  hubReview: {                   // Hub 自身对 PR 的合规评估
    level: 'Pass' | 'Warning' | 'Block' | 'Escalate',
    compliance: {
      taskId: string,
      done: string[],
      notDone: string[],
      needsHumanCheck: string[]
    } | null,
    issues: Array<{ severity, file, line, description }>,
    createdAt: string            // ISO datetime
  } | null,
  commits: string[],             // commit SHA 列表（快照）
  mergedAt: string | null,
  createdAt: string,
  updatedAt: string
}
```

### 3.2 `store.reviews` 变更

原有 `reviews` 继续存在（历史兼容），但对于 PR 流产生的 review，新增字段 `pullId: string | null`。迁移：所有旧 review 补 `pullId: null`。

### 3.3 `store.eveningReports` 扩展

每份晚会报告新增 `pulls: []`（当日 merged PR 快照），格式与 `store.pulls` 条目一致，用于对账时不受后续状态变化影响。

---

## 4. 模块变更矩阵

### 4.1 新增模块

| 模块 | 路径 | 职责 |
|------|------|------|
| `pullPipeline.js` | `server/services/pullPipeline.js` | PR 入库流水线：fetchPR → resolve tasks → hubReview → persist |
| `prAgentParser.js` | `server/services/prAgentParser.js` | 解析 GitHub PR review comments（fetchPRDetail 结果）→ `prAgentReview` / TicketCompliance 结构 |
| `pullRoutes.js` | `server/routes/pullRoutes.js` | GET /api/pulls, GET /api/pulls/:id, PATCH /api/pulls/:id/decision |

### 4.2 改动模块

| 模块 | 变更概要 |
|------|---------|
| `githubApi.js` | 新增 `fetchProjectPRs(owner, repo, since)` / `fetchPRDetail(owner, repo, number)` |
| `githubSync.js` | `syncGitHubProjectIntoStore` 新增 PR 同步分支，调用 `pullPipeline.js` |
| `webhookRoutes.js` | 新增 `POST /api/webhooks/pr-agent`（接收 PR-Agent Actions 推来的结果）；原 `pull_request` 事件处理走 `pullPipeline` |
| `githubWebhook.js` | 新增 `pull_request` / `pull_request_review` 事件解析 |
| `dailyBrief.js` | `applyEveningReportProgress` 优先用 `store.pulls` 对应 PR 的合规结论；`buildEveningReport` 加入 PR 维度统计 |
| `riskEngine.js` | `buildMetrics` Review cleanliness 维度改为读 `store.pulls`；`scanRisks` 新增 "PR 卡超 48h 未合并" 风险 |
| `wecom.js` | `buildPreMeetingWeComMsg` / `buildMeetingSummaryWeComMsg` 加入 PR 维度（当日 merged PR 数、Block PR 数） |
| `stageChecklist.js` | 无变更（阶段检查清单与 PR 无直接关联） |
| `store.js` | `migrateStore()` 新增 `pulls: []`；review 补 `pullId: null` / `issues: []`；pull 补默认字段 |
| `scheduler.js` | 新增 PR 同步到 `githubSyncIntervalMinutes` 周期内 |
| `src/app.js` | 新增 `#viewPulls` 列表页 / PR 详情侧滑页；任务详情页 compliance card 优先读 PR 数据 |
| `index.html` | 新增 `<section class="view" id="viewPulls">` 导航项 |
| `src/styles.css` | PR 列表卡片、PR 详情侧滑、合并状态 badge 样式 |
| `server/index.js` | 注册 `pullRoutes`，传入 `pullPipeline` 依赖 |

### 4.3 不变模块

`reviewer.js`（compliance 接口保持），`complianceAggregator.js`，`planner.js`，`semanticLinker.js`，`assignmentBrief.js`，`bindingEngine.js`，`auth.js`，`claude.js`，`docsManager.js`

---

## 5. PR-Agent 部署方案（GitHub Actions + Hub sink）

### 5.1 每仓库 `.github/workflows/pr-agent.yml`

```yaml
name: PR-Agent Review
on:
  pull_request:
    types: [opened, reopened, synchronize]
  pull_request_review_comment:
    types: [created]

jobs:
  pr_agent_job:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
      contents: read
    steps:
      - uses: Codium-ai/pr-agent@main
        env:
          OPENAI_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_BASE: https://api.anthropic.com/v1
          CONFIG.AI_PROVIDER: anthropic
          github_action_config.auto_review: "true"
          github_action_config.auto_improve: "false"
          github_action_config.auto_describe: "true"

      # Sink: 把 PR-Agent 结果推给 Hub
      - name: Notify Hub
        if: always()
        run: |
          curl -s -X POST ${{ vars.HUB_URL }}/api/webhooks/pr-agent \
            -H "Content-Type: application/json" \
            -H "X-CUE-API-Key: ${{ secrets.CUE_API_KEY }}" \
            -d '{
              "event": "pr_agent_review",
              "repo": "${{ github.repository }}",
              "pr_number": ${{ github.event.pull_request.number }},
              "run_id": "${{ github.run_id }}"
            }'
```

Hub 收到 sink 通知后，调用 `fetchPRDetail` 从 GitHub 拉取 PR-Agent 留下的 review comment，解析合规结论，更新 `store.pulls[n].prAgentReview`。

### 5.2 `POST /api/webhooks/pr-agent` 处理流程

```
1. 验证 X-CUE-API-Key
2. 提取 repo / pr_number
3. 找到对应 projectId（按 githubOwner/githubRepo 匹配）
4. fetchPRDetail → 拉最新 PR review comments
5. prAgentParser → 解析 TicketCompliance
6. updateStore：写入 store.pulls[n].prAgentReview
7. 触发 hubReview（若 PR 已关联任务）
8. 返回 200
```

---

## 6. PR 流晚会对账逻辑

当日（上海时区 00:00-23:59）merged 的 PR：
- 若 PR 关联了任务 → 取 `pr.hubReview.compliance`（优先）或 `pr.prAgentReview.compliance` 计算任务进度
- 若同一任务有多个 merged PR → 取最新 merge 的 PR compliance 作为快照（与原 complianceAggregator 逻辑一致）
- 未关联任务的 PR → 在晚会报告中单独列出，标注"待关联任务"

晚会报告新增 PR 维度摘要（企微消息）：
```
📋 今日 PR 汇总
  已合并：3 个  |  待 review：2 个  |  Block：1 个
```

---

## 7. C+ bypass 合规机制

直推 main（hotfix）场景：
1. `main-push-policy.yml` GitHub Actions 工作流检测 push-to-main（非 merge commit）
2. 若推送分支名以 `hotfix/` 开头 → 允许，但在 Hub 创建一条 `store.bypasses` 记录（含 commitSHA、author、deadline = 24h 后）
3. `scheduler.js` 每小时检查 `store.bypasses`：超 deadline 未关联 PR → 触发企微告警
4. 若推送分支名**不以** `hotfix/` 开头 → GitHub Actions fail，阻止合并（不影响 Hub 正常运行）

---

## 8. 前端 PR 列表页（`#viewPulls`）

### 页面结构

```
导航栏新增：PR 列表（#viewPulls）

PR 列表页：
  - 筛选：项目 / 状态(open|merged|closed) / 作者
  - PR 卡片：编号 + 标题 + 作者 + 状态 badge + compliance summary（✅/❌/⚠️）
  - 点击卡片 → 侧滑详情（同 task 详情侧滑风格）

PR 详情侧滑：
  - PR 基本信息（标题、分支、作者、时间）
  - 关联任务列表（可跳转）
  - PR-Agent review 合规卡（三桶展示）
  - Hub review 合规卡
  - issue 列表（severity badge + file:line）
  - 人工决策按钮（Pass / Escalate）
```

---

## 9. 实施分阶段计划

### Phase 0 — 基础设施（1-2天）

- `store.js` migrate：`pulls: []`，review 补 `pullId/issues`，新增 `bypasses: []`
- `docs/PR-WORKFLOW.md` 草稿（团队使用说明，含 PR 模板、命名规范、C+ bypass 规则）
- PR 模板：`.github/pull_request_template.md`（AC checklist 格式，Hub 解析用）
- `pr-agent.yml` skeleton（Actions 文件，env 留空，不激活）

### Phase 1 — Hub PR 数据层（2-3天）

- `githubApi.js`：`fetchProjectPRs` / `fetchPRDetail`
- `prAgentParser.js`：TicketCompliance 解析
- `pullPipeline.js`：完整 PR 入库流水线
- `githubSync.js`：同步周期内加 PR 同步
- `webhookRoutes.js`：`POST /api/webhooks/pr-agent` + `pull_request` webhook
- `pullRoutes.js`：GET list / GET detail / PATCH decision
- `server/index.js`：注册路由

### Phase 2 — PR-Agent Actions 激活（1天）

- 填写 `pr-agent.yml` 中的 env（Anthropic key、Hub URL、CUE_API_KEY）
- 在 GitHub 仓库 Secrets/Variables 配置
- 发一个测试 PR，验证 sink → Hub 流程端到端

### Phase 3 — 晚会/健康度/企微切换（2天）

- `dailyBrief.js`：PR 优先对账逻辑
- `riskEngine.js`：Review cleanliness 改读 `store.pulls`，新增 PR 卡 48h 风险
- `wecom.js`：企微消息加 PR 维度
- `buildMetrics`：健康度 "PR 合规率" 维度

### Phase 4 — 前端 PR 页面（2天）

- `index.html`：新增 `#viewPulls` section
- `src/app.js`：`renderPullList` / `openPullDetail` / PR 合规卡
- `src/styles.css`：PR 卡片、侧滑、badge 样式

### Phase 5 — 分支保护 & C+ bypass（1天）

- `main-push-policy.yml`：检测直推 main
- `store.bypasses` 追踪 + scheduler 告警
- GitHub 仓库 Ruleset 配置（require PR reviews）

### Phase 6 — 团队培训文档终稿（0.5天）

- `docs/PR-WORKFLOW.md` 完整版（含截图位置占位、操作步骤、FAQ）
- `docs/开发进度.md` 更新

---

## 10. 迁移风险与缓解

| 风险 | 概率 | 缓解措施 |
|------|------|---------|
| 团队不适应 PR 流，绕过直推 main | 中 | C+ bypass 机制 + 24h 追踪；Phase 5 前保留直推权限 |
| PR-Agent sink 回调失败 | 低 | sink 步骤 `if: always()`；Hub 日志可查；手动触发 resync |
| PR-Agent 误报导致任务进度异常 | 中 | `needsHumanCheck` 桶不计入 done，仅供参考；人工 Pass 按钮覆盖 |
| 历史 commit review 数据失效 | 低 | `store.reviews` 保留，历史对账不受影响；`pullId: null` 标记旧数据 |
| Phase 2-3 切换期间晚会对账空白 | 低 | Phase 3 合并后同一天切换；切换前一天全量 PR 回填 |

---

## 11. 成功验收标准

- [ ] 任意团队成员开 PR → 5 分钟内 PR-Agent 自动留 review comment → Hub 收到 sink 更新 `store.pulls`
- [ ] 晚会对账页面优先展示 PR 合规结论（而非 commit 数量）
- [ ] `#viewPulls` 页面可筛选/查看 PR 详情及关联任务
- [ ] hotfix 直推 main → `store.bypasses` 记录 → 超 24h 未补 PR → 企微告警
- [ ] `docs/PR-WORKFLOW.md` 新人可独立阅读并完成第一个 PR
