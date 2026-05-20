# PR 流全面切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CUE Project Hub 从 commit 流全面切换为 PR 流：store 新增 `pulls`/`bypasses`，Hub 通过 `/api/webhooks/pr-agent` 接收 GitHub Actions 推送的 PR-Agent 结果，晚会对账优先使用 PR 合规数据，前端新增 PR 列表页，C+ bypass 机制追踪 hotfix 直推。

**Architecture:** `prAgentParser.js` 从 GitHub PR review comments 解析 TicketCompliance 结构；`pullPipeline.js` 负责 PR 完整入库流水线（fetchPR → resolve tasks → hubReview → persist）；`pullRoutes.js` 暴露 REST 接口。PR-Agent 运行在 GitHub Actions，通过 sink HTTP 请求通知 Hub；Hub 再拉取 PR detail 解析结果。晚会对账在 Phase 3 切换为 PR 优先逻辑。

**Tech Stack:** Node.js 18+ ESM，原生 `http` 模块，`@anthropic-ai/sdk`，GitHub REST API v3。无测试框架，用 `npm run check`（`node --check`）做语法验证。

---

## 文件清单

| 动作 | 路径 | 说明 |
|------|------|------|
| 修改 | `server/store.js` | migrateStore 新增 pulls/bypasses/review.pullId |
| 新建 | `.github/pull_request_template.md` | PR AC checklist 模板 |
| 新建 | `.github/workflows/pr-agent.yml` | PR-Agent Actions + Hub sink |
| 新建 | `server/services/prAgentParser.js` | 解析 PR review comments → TicketCompliance |
| 新建 | `server/services/pullPipeline.js` | PR 入库流水线 |
| 新建 | `server/routes/pullRoutes.js` | GET/PATCH /api/pulls |
| 修改 | `server/services/githubApi.js` | 新增 fetchProjectPRs / fetchPRDetail |
| 修改 | `server/routes/webhookRoutes.js` | 新增 /api/webhooks/pr-agent 端点 |
| 修改 | `server/services/githubSync.js` | syncGitHubProjectIntoStore 加 PR 同步分支 |
| 修改 | `server/index.js` | 注册 pullRoutes，传入 pullPipeline 依赖 |
| 修改 | `server/services/dailyBrief.js` | 晚会对账 PR 优先逻辑 |
| 修改 | `server/services/riskEngine.js` | PR 合规率维度 + 48h 卡 PR 风险 |
| 修改 | `server/services/wecom.js` | 企微消息加 PR 汇总行 |
| 修改 | `index.html` | 新增 #viewPulls section + 导航项 |
| 修改 | `src/styles.css` | PR 卡片、侧滑、badge 样式 |
| 修改 | `src/app.js` | renderPullList / openPullDetail / PR 合规卡 |
| 新建 | `.github/workflows/main-push-policy.yml` | 检测直推 main |
| 修改 | `server/scheduler.js` | bypass 超时告警周期任务 |
| 新建 | `docs/PR-WORKFLOW.md` | 团队 PR 工作流使用说明 |
| 修改 | `docs/开发进度.md` | 记录 Phase 7 PR 流迁移 |

---

## Phase 0 — 基础设施

### Task 1: store.js 迁移 — 新增 pulls / bypasses / review.pullId

**Files:**
- Modify: `server/store.js`

- [ ] **Step 1: 在 migrateStore 的 `next` 默认值对象中新增两个集合**

在 `server/store.js` 的 `migrateStore` 函数里，找到 `next` 对象定义（`const next = { tasks: [], members: [], ...`），在 `aiPromptTraces: [],` 这行后面加入：

```js
    pulls: [],
    bypasses: [],
```

完整的 next 对象末尾应该是：
```js
    aiPromptTraces: [],
    pulls: [],
    bypasses: [],
    currentStage: defaultCurrentStage,
    ...store
```

- [ ] **Step 2: 在 reviews 迁移块末尾补 pullId 字段**

找到这段代码（当前最后一行是 `return Object.hasOwn(withCompliance, 'issues') ...`）：

```js
      return Object.hasOwn(withCompliance, 'issues') ? withCompliance : { ...withCompliance, issues: [] };
```

改为：

```js
      const withIssues = Object.hasOwn(withCompliance, 'issues') ? withCompliance : { ...withCompliance, issues: [] };
      return Object.hasOwn(withIssues, 'pullId') ? withIssues : { ...withIssues, pullId: null };
```

- [ ] **Step 3: 在 reviews 迁移之后加 pulls 迁移块**

在 `next.reviews = ...` 的 `.map()` 结束后（即 review 迁移块之后），加入：

```js
  // 为已有 pull 补全必需字段
  next.pulls = (next.pulls || []).map((pull) => ({
    prAgentReview: null,
    hubReview: null,
    linkedTaskIds: [],
    commits: [],
    mergedAt: null,
    ...pull
  }));
  // 为已有 bypass 补全必需字段
  next.bypasses = (next.bypasses || []).map((bypass) => ({
    prLinked: false,
    alertSent: false,
    ...bypass
  }));
```

- [ ] **Step 4: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

预期输出：无错误（只有文件名列出，没有 error）

- [ ] **Step 5: 提交**

```bash
git add server/store.js
git commit -m "feat: store 迁移 — 新增 pulls/bypasses 集合，review 补 pullId 字段"
```

---

### Task 2: PR 模板 + pr-agent.yml skeleton

**Files:**
- Create: `.github/pull_request_template.md`
- Create: `.github/workflows/pr-agent.yml`

- [ ] **Step 1: 创建 PR 模板**

创建文件 `.github/pull_request_template.md`：

```markdown
## 关联任务

<!-- 填写任务 ID，格式：task_xxx 或 #issue号，Hub 自动解析关联 -->
任务：

## 变更说明

<!-- 这次 PR 改了什么，为什么 -->

## 验收清单（AC）

<!-- 逐条列出，PR-Agent 和 Hub 会解析这里做合规对账 -->
- [ ] 
- [ ] 
- [ ] 

## 测试说明

<!-- 如何验证这次改动 -->

## 风险说明

<!-- 有没有可能影响线上的边界情况 -->
```

- [ ] **Step 2: 创建 pr-agent.yml skeleton（env 留空，不填 secrets）**

创建文件 `.github/workflows/pr-agent.yml`：

```yaml
name: PR-Agent Review
# Phase 2 时填入真实 secrets 后激活
# 目前 defaults.run 留空，Actions 不会实际执行 PR-Agent

on:
  pull_request:
    types: [opened, reopened, synchronize]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]

jobs:
  pr_agent_job:
    # Phase 2 时把 'false' 改为 true
    if: ${{ false }}
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
      contents: read
    steps:
      - name: PR-Agent Review
        uses: Codium-ai/pr-agent@main
        env:
          OPENAI_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_BASE: https://api.anthropic.com/v1
          CONFIG.AI_PROVIDER: anthropic
          github_action_config.auto_review: "true"
          github_action_config.auto_improve: "false"
          github_action_config.auto_describe: "true"

      - name: Notify Hub (sink)
        if: always()
        run: |
          PR_NUMBER="${{ github.event.pull_request.number }}"
          if [ -z "$PR_NUMBER" ]; then
            echo "No PR number found, skipping Hub notification"
            exit 0
          fi
          curl -sf -X POST "${{ vars.HUB_URL }}/api/webhooks/pr-agent" \
            -H "Content-Type: application/json" \
            -H "X-CUE-API-Key: ${{ secrets.CUE_API_KEY }}" \
            -d "{\"event\":\"pr_agent_review\",\"repo\":\"${{ github.repository }}\",\"pr_number\":${PR_NUMBER},\"run_id\":\"${{ github.run_id }}\"}" \
            || echo "Hub notification failed (non-fatal)"
```

- [ ] **Step 3: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 4: 提交**

```bash
git add .github/pull_request_template.md .github/workflows/pr-agent.yml
git commit -m "feat: 新增 PR 模板和 pr-agent.yml skeleton（Phase 2 激活）"
```

---

## Phase 1 — Hub PR 数据层

### Task 3: githubApi.js — fetchProjectPRs + fetchPRDetail

**Files:**
- Modify: `server/services/githubApi.js`

- [ ] **Step 1: 在文件末尾新增 fetchProjectPRs 函数**

在 `githubApi.js` 文件末尾（`scanGitHubProject` 函数的结束大括号之后）追加：

```js
/**
 * 获取仓库近期 Pull Request 列表
 * @param {string} owner
 * @param {string} repo
 * @param {object} options - { state: 'all'|'open'|'closed', since: ISO string, per_page: number }
 */
export async function fetchProjectPRs(owner, repo, options = {}) {
  const params = new URLSearchParams();
  params.set('state', options.state || 'all');
  params.set('sort', 'updated');
  params.set('direction', 'desc');
  params.set('per_page', String(Math.min(options.per_page || 30, 100)));
  const rawPRs = await ghFetch(`/repos/${owner}/${repo}/pulls?${params}`);

  const since = options.since ? new Date(options.since) : null;
  const filtered = since
    ? rawPRs.filter((pr) => new Date(pr.updated_at) >= since)
    : rawPRs;

  return filtered.map((pr) => ({
    number: pr.number,
    title: pr.title || '',
    body: pr.body || '',
    state: pr.merged_at ? 'merged' : pr.state,
    author: mapOwner(pr.user?.login || '', '', ''),
    authorLogin: pr.user?.login || '',
    headBranch: pr.head?.ref || '',
    baseBranch: pr.base?.ref || '',
    htmlUrl: pr.html_url || '',
    mergedAt: pr.merged_at || null,
    createdAt: pr.created_at || new Date().toISOString(),
    updatedAt: pr.updated_at || new Date().toISOString()
  }));
}

/**
 * 获取单个 PR 详情，含 review comments（PR-Agent 留在 reviews 字段）
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 */
export async function fetchPRDetail(owner, repo, prNumber) {
  const [pr, reviews, comments] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`),
    ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`),
    ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`)
  ]);

  return {
    number: pr.number,
    title: pr.title || '',
    body: pr.body || '',
    state: pr.merged_at ? 'merged' : pr.state,
    author: mapOwner(pr.user?.login || '', '', ''),
    authorLogin: pr.user?.login || '',
    headBranch: pr.head?.ref || '',
    baseBranch: pr.base?.ref || '',
    htmlUrl: pr.html_url || '',
    mergedAt: pr.merged_at || null,
    createdAt: pr.created_at || new Date().toISOString(),
    updatedAt: pr.updated_at || new Date().toISOString(),
    commits: [],  // 如需 commit 列表可单独调用 /pulls/:n/commits
    reviews: (reviews || []).map((r) => ({
      id: r.id,
      user: r.user?.login || '',
      body: r.body || '',
      state: r.state,
      submittedAt: r.submitted_at || '',
      htmlUrl: r.html_url || ''
    })),
    reviewComments: (comments || []).map((c) => ({
      id: c.id,
      user: c.user?.login || '',
      body: c.body || '',
      path: c.path || '',
      line: c.line || c.original_line || null,
      createdAt: c.created_at || ''
    }))
  };
}
```

- [ ] **Step 2: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 3: 提交**

```bash
git add server/services/githubApi.js
git commit -m "feat: githubApi 新增 fetchProjectPRs / fetchPRDetail"
```

---

### Task 4: prAgentParser.js — 解析 PR review comments → TicketCompliance

**Files:**
- Create: `server/services/prAgentParser.js`

- [ ] **Step 1: 创建 prAgentParser.js**

PR-Agent 会在 PR 上发 review comment，comment body 包含类似以下结构（Markdown）：

```
## PR Review Checklist
- [x] AC item 1
- [ ] AC item 2
- [~] AC item 3 (needs human check)
```

或者是自由文本 review，需要 Hub 自己用 LLM 解析。

创建 `server/services/prAgentParser.js`：

```js
/**
 * prAgentParser.js
 * 从 GitHub PR review comments（fetchPRDetail 结果）解析 PR-Agent 的输出，
 * 提取 TicketCompliance 结构（done / notDone / needsHumanCheck）
 *
 * PR-Agent 机器人的 login 通常是 "github-actions[bot]" 或 "pr-agent[bot]"
 */

const PR_AGENT_BOT_PATTERNS = [/pr-agent/i, /codiumai/i, /github-actions\[bot\]/i];

/**
 * 判断 review 是否来自 PR-Agent bot
 */
function isPrAgentBot(userLogin = '') {
  return PR_AGENT_BOT_PATTERNS.some((pattern) => pattern.test(userLogin));
}

/**
 * 从 Markdown checklist 文本中提取三桶
 * 支持格式：
 *   - [x] done item
 *   - [ ] not done item
 *   - [~] needs human check
 *   - ~~item~~ (strikethrough = notDone)
 */
function parseChecklistFromMarkdown(text = '') {
  const done = [];
  const notDone = [];
  const needsHumanCheck = [];

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // [x] or [X]
    const doneMatch = trimmed.match(/^[-*]\s+\[x\]\s+(.+)/i);
    if (doneMatch) { done.push(doneMatch[1].trim()); continue; }
    // [~] needs human check
    const humanMatch = trimmed.match(/^[-*]\s+\[~\]\s+(.+)/i);
    if (humanMatch) { needsHumanCheck.push(humanMatch[1].trim()); continue; }
    // [ ] not done
    const notDoneMatch = trimmed.match(/^[-*]\s+\[\s\]\s+(.+)/i);
    if (notDoneMatch) { notDone.push(notDoneMatch[1].trim()); continue; }
  }

  return { done, notDone, needsHumanCheck };
}

/**
 * 尝试从 PR-Agent review body 提取打分（"Score: 85" 格式）
 */
function extractScore(text = '') {
  const match = text.match(/score[:\s]+(\d+)/i);
  return match ? Math.min(100, Math.max(0, Number(match[1]))) : null;
}

/**
 * 提取 PR-Agent 报告的 issues（severity + description）
 * PR-Agent 通常以 "🔴 Critical", "🟡 Major", "🟢 Minor" 格式输出
 */
function extractIssues(text = '') {
  const issues = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/critical|blocker/i.test(trimmed) && trimmed.length < 300) {
      issues.push({ severity: 'critical', file: '', line: null, description: trimmed.slice(0, 200) });
    } else if (/major|warning/i.test(trimmed) && trimmed.length < 300) {
      issues.push({ severity: 'major', file: '', line: null, description: trimmed.slice(0, 200) });
    }
  }
  return issues.slice(0, 10);
}

/**
 * 主入口：解析 fetchPRDetail 结果中的 PR-Agent review，返回 prAgentReview 对象
 *
 * @param {object} prDetail - fetchPRDetail 的返回值
 * @returns {{
 *   score: number|null,
 *   compliance: { done: string[], notDone: string[], needsHumanCheck: string[] } | null,
 *   issues: Array<{ severity, file, line, description }>,
 *   rawUrl: string|null
 * }}
 */
export function parsePrAgentReview(prDetail) {
  const { reviews = [], reviewComments = [] } = prDetail;

  // 找到 PR-Agent 的 review（优先找 review body，再找 review comments）
  const agentReview = reviews.find((r) => isPrAgentBot(r.user));
  const agentComments = reviewComments.filter((c) => isPrAgentBot(c.user));

  if (!agentReview && agentComments.length === 0) {
    // PR-Agent 还没有跑完，或者没有配置
    return null;
  }

  const allText = [
    agentReview?.body || '',
    ...agentComments.map((c) => c.body || '')
  ].join('\n\n');

  const { done, notDone, needsHumanCheck } = parseChecklistFromMarkdown(allText);
  const score = extractScore(allText);
  const issues = extractIssues(allText);

  // 如果没有解析出任何 checklist 项，compliance 为 null（PR-Agent 没有输出 AC checklist）
  const compliance = (done.length + notDone.length + needsHumanCheck.length) > 0
    ? { done, notDone, needsHumanCheck }
    : null;

  return {
    score,
    compliance,
    issues,
    rawUrl: agentReview?.htmlUrl || agentComments[0]?.createdAt || null
  };
}
```

- [ ] **Step 2: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 3: 提交**

```bash
git add server/services/prAgentParser.js
git commit -m "feat: 新增 prAgentParser — 解析 PR review comments 提取 TicketCompliance"
```

---

### Task 5: pullPipeline.js — PR 入库流水线

**Files:**
- Create: `server/services/pullPipeline.js`

- [ ] **Step 1: 创建 pullPipeline.js**

```js
/**
 * pullPipeline.js
 * PR 入库流水线：fetchPR → resolve tasks → hubReview → persist
 *
 * 调用方：
 *   - githubSync.js（定时同步）
 *   - webhookRoutes.js（GitHub PR webhook / PR-Agent sink）
 */

import { fetchProjectPRs, fetchPRDetail, parseRepo } from './githubApi.js';
import { parsePrAgentReview } from './prAgentParser.js';
import { reviewChange } from './reviewer.js';
import { bindActivityToExplicitRefs } from './bindingEngine.js';
import { createId } from '../store.js';

/**
 * 从 PR body 和 title 解析关联任务 ID
 * 支持格式：task_xxx、#issue号（转换为 task 引用需 store 辅助）
 */
function extractLinkedTaskIds(title = '', body = '', store = {}) {
  const text = `${title}\n${body}`;
  const tasks = store.tasks || [];

  // 显式 task_xxx 引用
  const explicitIds = [...text.matchAll(/\btask_[\w]+/gi)].map((m) => m[0]);
  const validExplicit = explicitIds.filter((id) => tasks.some((t) => t.id === id));

  // 用 bindingEngine 的逻辑（构造一个 commit-like activity）
  if (validExplicit.length) return [...new Set(validExplicit)];

  const fakeActivity = {
    id: `pr_bind_${Date.now()}`,
    type: 'commit',
    title: title.slice(0, 120),
    files: [],
    repo: ''
  };
  const bound = bindActivityToExplicitRefs(fakeActivity, store);
  return bound.taskId ? [bound.taskId] : [];
}

/**
 * 将 GitHub PR 原始数据（来自 fetchProjectPRs 或 fetchPRDetail）
 * 映射为 store.pulls 条目格式
 */
function normalizePullEntry(prData, projectId, linkedTaskIds = []) {
  return {
    id: `pull_${prData.number}_${projectId}`,
    projectId,
    number: prData.number,
    title: prData.title || '',
    body: prData.body || '',
    state: prData.state || 'open',
    author: prData.author || '',
    headBranch: prData.headBranch || '',
    baseBranch: prData.baseBranch || '',
    linkedTaskIds,
    prAgentReview: null,
    hubReview: null,
    commits: prData.commits || [],
    mergedAt: prData.mergedAt || null,
    createdAt: prData.createdAt || new Date().toISOString(),
    updatedAt: prData.updatedAt || new Date().toISOString()
  };
}

/**
 * 对 PR 执行 Hub 自身的合规评估（调用 reviewer.js）
 * 返回 hubReview 对象或 null
 */
async function buildHubReview(prDetail, linkedTaskIds, store) {
  const tasks = store.tasks || [];
  const linkedTask = linkedTaskIds.length
    ? tasks.find((t) => t.id === linkedTaskIds[0])
    : null;

  try {
    const result = await reviewChange({
      repo: `${prDetail.number}`,
      title: prDetail.title,
      owner: prDetail.author,
      diff: prDetail.body || '',
      files: [],
      task: linkedTask || null
    });

    return {
      level: result.level || 'Pass',
      compliance: linkedTask && result.compliance ? { taskId: linkedTask.id, ...result.compliance } : null,
      issues: result.issues || [],
      createdAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('[pullPipeline] hubReview failed:', err.message);
    return null;
  }
}

/**
 * 同步单个 PR 进 store
 * - 若已存在（按 pull id）则更新；否则新增
 * - 返回 { isNew: boolean, pull: object }
 */
export async function upsertPullIntoStore(prDetail, projectId, updateStore, store) {
  const linkedTaskIds = extractLinkedTaskIds(prDetail.title, prDetail.body, store);
  const hubReview = await buildHubReview(prDetail, linkedTaskIds, store);
  const prAgentReview = parsePrAgentReview(prDetail);

  const pullId = `pull_${prDetail.number}_${projectId}`;
  const existing = (store.pulls || []).find((p) => p.id === pullId);

  const pullEntry = {
    ...(existing || normalizePullEntry(prDetail, projectId, linkedTaskIds)),
    title: prDetail.title,
    body: prDetail.body,
    state: prDetail.state,
    author: prDetail.author,
    headBranch: prDetail.headBranch,
    baseBranch: prDetail.baseBranch,
    linkedTaskIds,
    hubReview,
    prAgentReview: prAgentReview || existing?.prAgentReview || null,
    mergedAt: prDetail.mergedAt || existing?.mergedAt || null,
    updatedAt: new Date().toISOString()
  };

  let isNew = false;
  await updateStore((draft) => {
    const idx = (draft.pulls || []).findIndex((p) => p.id === pullId);
    if (!Array.isArray(draft.pulls)) draft.pulls = [];
    if (idx === -1) {
      draft.pulls.unshift(pullEntry);
      isNew = true;
    } else {
      draft.pulls[idx] = pullEntry;
    }
    draft.pulls = draft.pulls.slice(0, 500);
    return draft;
  });

  return { isNew, pull: pullEntry };
}

/**
 * 批量同步项目的近期 PR（供 githubSync.js 调用）
 *
 * @param {object} project - store.projects 条目
 * @param {object} store   - 当前 store 快照
 * @param {function} updateStore
 * @param {object} options - { since: '7 days ago' }
 * @returns {{ added: number, updated: number, pulls: object[] }}
 */
export async function syncProjectPRs(project, store, updateStore, options = {}) {
  const { owner, repo } = parseRepo(project);
  if (!owner || !repo) return { added: 0, updated: 0, pulls: [] };

  const sinceDays = parseInt((options.since || '14 days ago').replace(/\s*days?\s*ago/i, '')) || 14;
  const sinceDate = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  let prs;
  try {
    prs = await fetchProjectPRs(owner, repo, { state: 'all', since: sinceDate, per_page: 30 });
  } catch (err) {
    console.error(`[pullPipeline] fetchProjectPRs failed for ${owner}/${repo}:`, err.message);
    return { added: 0, updated: 0, pulls: [] };
  }

  let added = 0;
  let updated = 0;
  const results = [];

  for (const pr of prs) {
    try {
      // 拉取完整详情（含 review comments，用于 prAgentParser）
      const prDetail = await fetchPRDetail(owner, repo, pr.number);
      const { isNew, pull } = await upsertPullIntoStore(prDetail, project.id, updateStore, store);
      if (isNew) added++;
      else updated++;
      results.push(pull);
    } catch (err) {
      console.error(`[pullPipeline] failed on PR #${pr.number}:`, err.message);
    }
  }

  return { added, updated, pulls: results };
}

/**
 * 处理 PR-Agent sink 通知（来自 /api/webhooks/pr-agent）
 * 拉取对应 PR 详情，更新 store
 *
 * @param {{ repo: string, pr_number: number }} payload
 * @param {object} store
 * @param {function} updateStore
 * @returns {object|null} 更新后的 pull 条目
 */
export async function handlePrAgentSink(payload, store, updateStore) {
  const { repo = '', pr_number } = payload;
  if (!repo || !pr_number) return null;

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return null;

  // 找对应的 project
  const project = (store.projects || []).find((p) => {
    const full = p.githubFullRepo || `${p.githubOwner}/${p.repository}`;
    return full.toLowerCase() === repo.toLowerCase();
  });

  if (!project) {
    console.warn(`[pullPipeline] PR-Agent sink: no project found for repo ${repo}`);
    return null;
  }

  try {
    const prDetail = await fetchPRDetail(owner, repoName, pr_number);
    const { pull } = await upsertPullIntoStore(prDetail, project.id, updateStore, store);
    console.log(`[pullPipeline] PR #${pr_number} upserted (project: ${project.id})`);
    return pull;
  } catch (err) {
    console.error(`[pullPipeline] handlePrAgentSink failed:`, err.message);
    return null;
  }
}
```

- [ ] **Step 2: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 3: 提交**

```bash
git add server/services/pullPipeline.js
git commit -m "feat: 新增 pullPipeline — PR 入库流水线（upsert / sync / pr-agent sink）"
```

---

### Task 6: pullRoutes.js — REST 接口

**Files:**
- Create: `server/routes/pullRoutes.js`

- [ ] **Step 1: 创建 pullRoutes.js**

```js
export function createPullRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError
}) {
  return async function pullRoutes(req, res, url) {
    // GET /api/pulls  — 列表（支持 ?projectId=&state=&author= 筛选）
    if (req.method === 'GET' && url.pathname === '/api/pulls') {
      const store = await loadStore();
      let pulls = store.pulls || [];
      const { projectId, state, author } = Object.fromEntries(url.searchParams);
      if (projectId) pulls = pulls.filter((p) => p.projectId === projectId);
      if (state) pulls = pulls.filter((p) => p.state === state);
      if (author) pulls = pulls.filter((p) => p.author === author);
      sendJson(res, 200, { pulls });
      return true;
    }

    // GET /api/pulls/:id
    if (req.method === 'GET' && url.pathname.match(/^\/api\/pulls\/[^/]+$/)) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const store = await loadStore();
      const pull = (store.pulls || []).find((p) => p.id === id);
      if (!pull) { sendError(res, 404, 'pull not found'); return true; }
      sendJson(res, 200, { pull });
      return true;
    }

    // PATCH /api/pulls/:id/decision  — 人工决策（Pass / Escalate）
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/pulls\/[^/]+\/decision$/)) {
      const id = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
      const { json } = await readBody(req);
      const allowed = ['Pass', 'Escalate', 'acknowledged', 'needs-fix', 'exempted'];
      const decision = allowed.includes(json?.humanDecision) ? json.humanDecision : null;
      if (!decision) { sendError(res, 400, 'invalid humanDecision'); return true; }

      let updated = null;
      await updateStore((draft) => {
        const idx = (draft.pulls || []).findIndex((p) => p.id === id);
        if (idx === -1) return draft;
        updated = {
          ...draft.pulls[idx],
          humanDecision: decision,
          humanNote: String(json?.humanNote || '').trim() || '',
          humanAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        draft.pulls[idx] = updated;
        return draft;
      });

      if (!updated) { sendError(res, 404, 'pull not found'); return true; }
      sendJson(res, 200, { pull: updated });
      return true;
    }

    return false;
  };
}
```

- [ ] **Step 2: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 3: 提交**

```bash
git add server/routes/pullRoutes.js
git commit -m "feat: 新增 pullRoutes — GET /api/pulls 列表、详情、人工决策接口"
```

---

### Task 7: webhookRoutes.js — 新增 /api/webhooks/pr-agent 端点

**Files:**
- Modify: `server/routes/webhookRoutes.js`

- [ ] **Step 1: 在 createWebhookRoutes 的参数解构中加入 pullPipeline 依赖**

找到：
```js
export function createWebhookRoutes({
  createId,
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  verifyGitHubSignature,
  parseGitHubEvent,
  reviewChange,
  generatePlanAdjustment,
  persistPlanAdjustment,
  buildMetrics,
  scanRisks,
  githubWebhookSecret,
  bindActivityToExplicitRefs,
  importDocsForProject
}) {
```

改为：
```js
export function createWebhookRoutes({
  createId,
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  verifyGitHubSignature,
  parseGitHubEvent,
  reviewChange,
  generatePlanAdjustment,
  persistPlanAdjustment,
  buildMetrics,
  scanRisks,
  githubWebhookSecret,
  bindActivityToExplicitRefs,
  importDocsForProject,
  handlePrAgentSink,
  cueApiKey
}) {
```

- [ ] **Step 2: 在 return async function webhookRoutes 的第一行，加入 /api/webhooks/pr-agent 路由**

找到：
```js
  return async function webhookRoutes(req, res, url) {
    if (req.method !== 'POST' || url.pathname !== '/api/webhooks/github') return false;
```

改为：
```js
  return async function webhookRoutes(req, res, url) {
    // PR-Agent sink（GitHub Actions 通知 Hub：PR-Agent 已完成 review）
    if (req.method === 'POST' && url.pathname === '/api/webhooks/pr-agent') {
      // 验证 CUE_API_KEY（复用同一把 key）
      const provided = req.headers['x-cue-api-key'];
      if (cueApiKey && provided !== cueApiKey) {
        sendError(res, 401, 'invalid api key');
        return true;
      }
      const { json } = await readBody(req);
      if (!json || !json.repo || !json.pr_number) {
        sendError(res, 400, 'missing repo or pr_number');
        return true;
      }
      const currentStore = await loadStore();
      const pull = handlePrAgentSink
        ? await handlePrAgentSink(json, currentStore, updateStore)
        : null;
      sendJson(res, 202, { received: true, pull: pull ? { id: pull.id, number: pull.number } : null });
      return true;
    }

    if (req.method !== 'POST' || url.pathname !== '/api/webhooks/github') return false;
```

- [ ] **Step 3: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 4: 提交**

```bash
git add server/routes/webhookRoutes.js
git commit -m "feat: webhookRoutes 新增 /api/webhooks/pr-agent sink 端点"
```

---

### Task 8: githubSync.js — 定时同步加 PR 分支

**Files:**
- Modify: `server/services/githubSync.js`

- [ ] **Step 1: 在文件顶部 import 区加入 syncProjectPRs**

找到文件第一行：
```js
import { hasGitHubConfig, scanGitHubProject } from './githubApi.js';
```

改为：
```js
import { hasGitHubConfig, scanGitHubProject } from './githubApi.js';
import { syncProjectPRs } from './pullPipeline.js';
```

- [ ] **Step 2: 在 syncGitHubProjectIntoStore 函数末尾，return 语句之前，加入 PR 同步**

找到 `syncGitHubProjectIntoStore` 函数末尾的 return 语句：
```js
  return {
    project: nextStore.projects.find((item) => item.id === project.id),
    source: 'github-api',
    addedActivities: addedActivityCount,
    addedReviews: addedReviewCount,
    activities: lightweightActivities,
    reviews: commitReviews,
    metrics: buildMetrics(nextStore, alerts),
    alerts
  };
```

在 return 之前插入 PR 同步（fire-and-forget，不阻塞 commit 同步）：

```js
  // PR 同步（fire-and-forget，不阻塞 commit 同步流程）
  syncProjectPRs(project, nextStore, updateStore, { since: '14 days ago' })
    .then(({ added, updated }) => {
      if (added || updated) {
        console.log(`[GitHubSync] PR 同步 ${project.githubFullRepo}：新增 ${added} 条，更新 ${updated} 条`);
      }
    })
    .catch((err) => console.error('[GitHubSync/PRSync]', err.message));

  return {
```

- [ ] **Step 3: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 4: 提交**

```bash
git add server/services/githubSync.js
git commit -m "feat: githubSync 定时同步加入 PR 分支（fire-and-forget）"
```

---

### Task 9: server/index.js — 注册 pullRoutes 并传入 pr-agent 依赖

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: 在 import 区加入新模块的 import**

在 `server/index.js` 文件顶部，找到现有 import 块，在最后一个 import 之后加入：

```js
import { createPullRoutes } from './routes/pullRoutes.js';
import { handlePrAgentSink } from './services/pullPipeline.js';
```

- [ ] **Step 2: 在 routeModules 数组中注册 createPullRoutes**

找到 `const routeModules = [` 数组，在最后一个 `createWebhookRoutes({...})` 调用之前加入：

```js
  createPullRoutes({
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError
  }),
```

- [ ] **Step 3: 在 createWebhookRoutes 调用中补入新参数**

找到：
```js
  createWebhookRoutes({
    createId,
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    verifyGitHubSignature,
    parseGitHubEvent,
    reviewChange,
    generatePlanAdjustment,
    persistPlanAdjustment,
    buildMetrics,
    scanRisks,
    githubWebhookSecret,
    bindActivityToExplicitRefs,
    importDocsForProject
  })
```

改为：
```js
  createWebhookRoutes({
    createId,
    loadStore,
    updateStore,
    readBody,
    sendJson,
    sendError,
    verifyGitHubSignature,
    parseGitHubEvent,
    reviewChange,
    generatePlanAdjustment,
    persistPlanAdjustment,
    buildMetrics,
    scanRisks,
    githubWebhookSecret,
    bindActivityToExplicitRefs,
    importDocsForProject,
    handlePrAgentSink,
    cueApiKey
  })
```

- [ ] **Step 4: 语法检查 + 启动验证**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 5: 提交**

```bash
git add server/index.js
git commit -m "feat: server/index 注册 pullRoutes 并传入 pr-agent sink 依赖"
```

---

## Phase 2 — PR-Agent Actions 激活

### Task 10: 激活 pr-agent.yml + 配置仓库 Secrets

这是配置任务，不涉及代码改动。在目标仓库（`CUEAITECH/Cue.AI`）上操作。

- [ ] **Step 1: 把 pr-agent.yml 推送到目标仓库**

把 `.github/workflows/pr-agent.yml` 复制到目标仓库（`CUEAITECH/Cue.AI`）的同路径下。

- [ ] **Step 2: 在目标仓库 Settings → Secrets and variables 配置以下 Secrets**

```
ANTHROPIC_API_KEY  = <你的 Anthropic key>
CUE_API_KEY        = <hub 配置的同一把 CUE_API_KEY>
```

Variables（非 Secret）：
```
HUB_URL = https://hub.cueai.top
```

- [ ] **Step 3: 把 pr-agent.yml 中的 `if: ${{ false }}` 改为 `if: ${{ true }}`**

```yaml
    if: ${{ true }}
```

提交并推送到目标仓库。

- [ ] **Step 4: 发一个测试 PR 验证端到端**

1. 在 `CUEAITECH/Cue.AI` 开一个 test PR
2. 等 GitHub Actions 跑完（约 2-5 分钟）
3. 检查 Hub 的 pull 列表：`GET https://hub.cueai.top/api/pulls?projectId=cue_ai_classroom`
4. 验证返回的 pulls 数组中有对应的 PR 条目
5. 若 prAgentReview 为 null：说明 PR-Agent 还没留 review（可能需要等几分钟），属正常
6. 若 prAgentReview 有内容：验证 compliance 三桶结构正确

---

## Phase 3 — 晚会/健康度/企微切换

### Task 11: dailyBrief.js — PR 优先对账逻辑

**Files:**
- Modify: `server/services/dailyBrief.js`

- [ ] **Step 1: 在 `applyEveningReportProgress` 中加入 PR 优先逻辑**

找到 `applyEveningReportProgress` 函数中这段代码：
```js
    // 从 review compliance 聚合该任务的最新完成度
    const agg = aggregateTaskCompliance(task.id, reviews);
    if (row.commitCount > 0) {
      if (!agg) {
```

在 `const agg = aggregateTaskCompliance(task.id, reviews);` 这行**之前**加入 PR 优先判断：

```js
    // PR 优先：若任务有关联的 merged PR（含 hubReview.compliance），用 PR 结论
    const pulls = store.pulls || [];
    const linkedPulls = pulls
      .filter((pr) => pr.linkedTaskIds?.includes(task.id) && pr.state === 'merged')
      .sort((a, b) => String(b.mergedAt || b.updatedAt || '').localeCompare(String(a.mergedAt || a.updatedAt || '')));
    const latestPull = linkedPulls[0];
    const prCompliance = latestPull?.hubReview?.compliance || latestPull?.prAgentReview?.compliance;
    if (prCompliance) {
      const done = prCompliance.done || [];
      const notDone = prCompliance.notDone || [];
      const needsHumanCheck = prCompliance.needsHumanCheck || [];
      const total = done.length + notDone.length + needsHumanCheck.length;
      const progress = total > 0 ? Math.round((done.length / total) * 100) : 0;
      const summary = `✅${done.length} ❌${notDone.length} ⚠️${needsHumanCheck.length}`;
      return {
        ...task,
        status: progress >= 100 ? '已完成' : task.status === '待确认' ? '进行中' : task.status,
        progress,
        signal: `晚会对账（PR #${latestPull.number}）：验收对照 ${summary}，进度 ${progress}%`,
        updatedAt: eveningReport.generatedAt
      };
    }
```

- [ ] **Step 2: 在 `buildEveningReport` 的返回对象中加入 pulls 快照**

找到 `buildEveningReport` 函数的 return 语句，在 `report` 字段之后加入：

```js
    pulls: (store.pulls || []).filter((pull) => {
      if (!pull.mergedAt) return false;
      const mergedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(pull.mergedAt));
      return mergedDate === dateText;
    })
```

完整 return 的最后几行应变为：
```js
    nextTargets,
    report,
    pulls: (store.pulls || []).filter((pull) => {
      if (!pull.mergedAt) return false;
      const mergedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(pull.mergedAt));
      return mergedDate === dateText;
    })
  };
```

- [ ] **Step 3: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 4: 提交**

```bash
git add server/services/dailyBrief.js
git commit -m "feat: 晚会对账优先使用 PR 合规结论，eveningReport 加入当日 merged PR 快照"
```

---

### Task 12: riskEngine.js — PR 合规率维度 + 卡 PR 风险

**Files:**
- Modify: `server/services/riskEngine.js`

- [ ] **Step 1: 在 scanRisks 中新增 "PR 卡超 48h 未合并" 风险**

找到 `scanRisks` 函数中 `for (const review of store.reviews || []) {` 这段之后（即 review Block alert 之后），加入：

```js
  // PR 超 48h 未合并告警
  const now48hAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  for (const pull of store.pulls || []) {
    if (pull.state !== 'open') continue;
    if ((pull.createdAt || '') < now48hAgo) {
      alerts.push({
        id: `alert_pr_stuck_${pull.id}`,
        severity: 'P2',
        target: pull.author || '未知',
        title: `PR #${pull.number} 超 48h 未合并`,
        detail: `「${pull.title || ''}」开了超过 48 小时仍未 merge 或关闭。`,
        source: pull.id
      });
    }
  }
```

- [ ] **Step 2: 在 buildMetrics 中改造 reviewScore 维度（改为 PR 合规率）**

找到：
```js
  // DORA 维度三：Change Failure Rate → 近 30 天未处理 Block 占比
  const reviews30d = (store.reviews || []).filter((r) => (r.createdAt || '') >= thirtyDaysAgo);
  const unresolvedBlocks30d = reviews30d.filter((r) => r.level === 'Block' && !r.humanDecision).length;
  const reviewScore = reviews30d.length
    ? Math.round((1 - unresolvedBlocks30d / reviews30d.length) * 100)
    : 100;
```

改为：
```js
  // DORA 维度三：Change Failure Rate → PR 合规率（PR 流）+ commit Block 兜底
  const mergedPulls30d = (store.pulls || []).filter((p) => p.mergedAt && p.mergedAt >= thirtyDaysAgo);
  let reviewScore;
  if (mergedPulls30d.length > 0) {
    // PR 有 hubReview：计算 Block/Escalate 比率
    const blockPulls = mergedPulls30d.filter((p) =>
      p.hubReview?.level === 'Block' || p.hubReview?.level === 'Escalate'
    ).length;
    reviewScore = Math.round((1 - blockPulls / mergedPulls30d.length) * 100);
  } else {
    // 无 PR 数据时回退到 commit review Block 比率
    const reviews30d = (store.reviews || []).filter((r) => (r.createdAt || '') >= thirtyDaysAgo);
    const unresolvedBlocks30d = reviews30d.filter((r) => r.level === 'Block' && !r.humanDecision).length;
    reviewScore = reviews30d.length
      ? Math.round((1 - unresolvedBlocks30d / reviews30d.length) * 100)
      : 100;
  }
```

- [ ] **Step 3: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 4: 提交**

```bash
git add server/services/riskEngine.js
git commit -m "feat: riskEngine 新增 PR 卡 48h 风险，buildMetrics 健康度改用 PR 合规率"
```

---

### Task 13: wecom.js — 企微消息加 PR 汇总行

**Files:**
- Modify: `server/services/wecom.js`

- [ ] **Step 1: 在 buildPreMeetingWeComMsg 中加入 PR 汇总段落**

找到 `buildPreMeetingWeComMsg` 函数，在函数内、return 语句（大 string join）之前，加入 PR 统计：

```js
  // PR 汇总（若有数据）
  const pulls = eveningEntry.pulls || [];
  const openPulls = pulls.filter((p) => p.state === 'open').length;
  const mergedPulls = pulls.filter((p) => p.state === 'merged').length;
  const blockPulls = pulls.filter((p) => p.hubReview?.level === 'Block' || p.hubReview?.level === 'Escalate').length;
  const prSummaryLine = pulls.length > 0
    ? `\n📋 今日 PR 汇总\n  已合并：${mergedPulls} 个  |  待 review：${openPulls} 个  |  Block：${blockPulls} 个`
    : '';
```

然后在 return 的字符串数组中，在 reconLines 段落之前加入 `prSummaryLine`：

找到：
```js
  return [
    `## 🚀 CUE 项目中枢作战包 · ${date}`,
```

在这个数组中，`reconLines` 段落插入之后（或在适当位置）加入：
```js
    ...(prSummaryLine ? [prSummaryLine, ''] : []),
```

具体位置：在第一个 `reconLines` 出现之前插入该行。

- [ ] **Step 2: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 3: 提交**

```bash
git add server/services/wecom.js
git commit -m "feat: 企微作战包加入 PR 汇总行（已合并/待 review/Block 数）"
```

---

## Phase 4 — 前端 PR 页面

### Task 14: index.html — 新增 #viewPulls section + 导航项

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 在导航菜单中加入 PR 列表项**

打开 `index.html`，找到导航菜单的 `<nav>` 或类似导航 ul/li 结构，在 Review 相关导航项附近加入：

```html
<li><a href="#viewPulls" data-view="viewPulls">PR 列表</a></li>
```

具体位置：在 `data-view="viewReviews"` 的 `<a>` 所在的 `<li>` 之后。

- [ ] **Step 2: 在 main 区域加入 #viewPulls section**

在其他 `<section class="view" id="viewXxx">` 之后加入（可以放在 viewReviews 之后）：

```html
<section class="view" id="viewPulls">
  <div class="view-header">
    <h2>PR 列表</h2>
    <div class="filter-bar" id="pullFilterBar">
      <select id="pullProjectFilter">
        <option value="">全部项目</option>
      </select>
      <select id="pullStateFilter">
        <option value="">全部状态</option>
        <option value="open">待合并</option>
        <option value="merged">已合并</option>
        <option value="closed">已关闭</option>
      </select>
      <select id="pullAuthorFilter">
        <option value="">全部成员</option>
      </select>
    </div>
  </div>
  <div id="pullList" class="pull-list">
    <div class="empty-hint">加载中...</div>
  </div>
</section>
```

同时加入 PR 详情侧滑面板（放在 `</main>` 之前）：

```html
<!-- PR 详情侧滑 -->
<div id="pullDrawerBackdrop" class="drawer-backdrop hidden" onclick="closePullDrawer()"></div>
<aside id="pullDrawer" class="drawer hidden">
  <div class="drawer-header">
    <button class="drawer-close" onclick="closePullDrawer()">✕</button>
    <h3 id="pullDrawerTitle">PR 详情</h3>
  </div>
  <div id="pullDrawerBody" class="drawer-body"></div>
</aside>
```

- [ ] **Step 3: 语法检查（html 简单检验）**

```bash
node -e "const fs = require('fs'); const html = fs.readFileSync('index.html', 'utf8'); if (!html.includes('id=\"viewPulls\"')) throw new Error('viewPulls not found'); console.log('ok');"
```

预期：`ok`

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: index.html 新增 #viewPulls section 和 PR 详情侧滑面板"
```

---

### Task 15: src/styles.css — PR 卡片和侧滑样式

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: 在 styles.css 末尾追加 PR 相关样式**

在文件末尾追加以下内容：

```css
/* ── PR 列表页 ───────────────────────────────────────── */
.pull-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}

.pull-card {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  cursor: pointer;
  transition: box-shadow 0.15s;
}

.pull-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.pull-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

.pull-number {
  font-weight: 600;
  color: var(--primary, #2563eb);
  font-size: 0.85rem;
}

.pull-title {
  font-weight: 500;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pull-state-badge {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.pull-state-badge.open   { background: #dcfce7; color: #166534; }
.pull-state-badge.merged { background: #ede9fe; color: #5b21b6; }
.pull-state-badge.closed { background: #f3f4f6; color: #6b7280; }

.pull-card-meta {
  font-size: 0.8rem;
  color: var(--text-secondary, #6b7280);
  display: flex;
  gap: 1rem;
  align-items: center;
}

.pull-compliance-badge {
  font-size: 0.78rem;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  padding: 2px 8px;
}

/* ── PR 详情侧滑（复用 drawer 模式）──────────────────── */
.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  z-index: 200;
}

.drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: min(520px, 95vw);
  height: 100vh;
  background: var(--card-bg, #fff);
  box-shadow: -4px 0 24px rgba(0,0,0,0.12);
  z-index: 201;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: transform 0.2s ease;
}

.drawer.hidden, .drawer-backdrop.hidden {
  display: none;
}

.drawer-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
  flex-shrink: 0;
}

.drawer-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.1rem;
  color: var(--text-secondary, #6b7280);
  padding: 0.25rem;
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
}

.pr-info-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-secondary, #6b7280);
}

.pr-compliance-section {
  margin-top: 1rem;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
}

.pr-compliance-header {
  padding: 0.6rem 1rem;
  background: #f9fafb;
  font-weight: 600;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--border, #e5e7eb);
}

.pr-compliance-bucket {
  padding: 0.6rem 1rem;
}

.pr-compliance-bucket + .pr-compliance-bucket {
  border-top: 1px solid #f3f4f6;
}

.pr-compliance-bucket h4 {
  font-size: 0.78rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}

.bucket-done h4   { color: #166534; }
.bucket-notdone h4 { color: #991b1b; }
.bucket-human h4  { color: #92400e; }

.pr-compliance-bucket ul {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.8rem;
}

.pr-decision-row {
  margin-top: 1rem;
  display: flex;
  gap: 0.5rem;
}

.btn-pass     { background: #16a34a; color: #fff; border: none; padding: 0.4rem 1rem; border-radius: 6px; cursor: pointer; }
.btn-escalate { background: #dc2626; color: #fff; border: none; padding: 0.4rem 1rem; border-radius: 6px; cursor: pointer; }
```

- [ ] **Step 2: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 3: 提交**

```bash
git add src/styles.css
git commit -m "feat: styles.css 新增 PR 卡片、侧滑详情、compliance badge 样式"
```

---

### Task 16: src/app.js — PR 列表渲染与侧滑详情

**Files:**
- Modify: `src/app.js`

- [ ] **Step 1: 在 state 对象中加入 pulls 字段**

找到 `const state = {` 定义，在现有字段之后加入：
```js
  pulls: [],
```

- [ ] **Step 2: 在 loadState 或数据拉取函数中加入 pulls 加载**

找到 `api('/api/state')` 或类似全局 state 加载调用，在数据赋值时加入：
```js
  state.pulls = data.pulls || [];
```

如果 `/api/state` 不包含 pulls，则在 `#viewPulls` 切换时单独拉取（见 Step 3）。

- [ ] **Step 3: 新增 renderPullList 函数**

在 app.js 中找到其他 `function render*` 函数的末尾，加入：

```js
async function fetchAndRenderPulls() {
  const projectId = document.getElementById('pullProjectFilter')?.value || '';
  const state_filter = document.getElementById('pullStateFilter')?.value || '';
  const author = document.getElementById('pullAuthorFilter')?.value || '';
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (state_filter) params.set('state', state_filter);
  if (author) params.set('author', author);
  try {
    const data = await api(`/api/pulls?${params}`);
    state.pulls = data.pulls || [];
    renderPullList();
  } catch (err) {
    console.error('[fetchAndRenderPulls]', err);
  }
}

function renderPullList() {
  const container = document.getElementById('pullList');
  if (!container) return;
  const pulls = state.pulls || [];
  if (!pulls.length) {
    container.innerHTML = '<div class="empty-hint">暂无 PR 数据。请先同步 GitHub 项目。</div>';
    return;
  }
  container.innerHTML = pulls.map((pr) => {
    const stateLabel = { open: '待合并', merged: '已合并', closed: '已关闭' }[pr.state] || pr.state;
    const compliance = pr.hubReview?.compliance || pr.prAgentReview?.compliance;
    const complianceBadge = compliance
      ? `<span class="pull-compliance-badge">✅${(compliance.done||[]).length} ❌${(compliance.notDone||[]).length} ⚠️${(compliance.needsHumanCheck||[]).length}</span>`
      : '';
    const dateStr = pr.mergedAt
      ? `合并于 ${pr.mergedAt.slice(0, 10)}`
      : `更新于 ${(pr.updatedAt || '').slice(0, 10)}`;
    return `
      <div class="pull-card" onclick="openPullDrawer(${JSON.stringify(pr.id)})">
        <div class="pull-card-header">
          <span class="pull-number">#${pr.number}</span>
          <span class="pull-title">${escapeHtml(pr.title)}</span>
          <span class="pull-state-badge ${pr.state}">${stateLabel}</span>
        </div>
        <div class="pull-card-meta">
          <span>${escapeHtml(pr.author || '未知')}</span>
          <span>${dateStr}</span>
          ${complianceBadge}
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openPullDrawer(pullId) {
  const pull = (state.pulls || []).find((p) => p.id === pullId);
  if (!pull) return;
  const drawer = document.getElementById('pullDrawer');
  const backdrop = document.getElementById('pullDrawerBackdrop');
  const title = document.getElementById('pullDrawerTitle');
  const body = document.getElementById('pullDrawerBody');
  if (!drawer || !body) return;

  title.textContent = `PR #${pull.number}`;
  body.innerHTML = buildPullDrawerHtml(pull);
  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

function closePullDrawer() {
  document.getElementById('pullDrawer')?.classList.add('hidden');
  document.getElementById('pullDrawerBackdrop')?.classList.add('hidden');
}

function buildPullDrawerHtml(pull) {
  const stateLabel = { open: '待合并', merged: '已合并', closed: '已关闭' }[pull.state] || pull.state;
  const linkedTasks = (pull.linkedTaskIds || [])
    .map((id) => {
      const task = (state.tasks || []).find((t) => t.id === id);
      return task ? `<a href="#" onclick="openTask('${id}'); return false;">${escapeHtml(task.title)}</a>` : id;
    }).join(', ') || '无';

  const complianceHtml = (sourceLabel, compliance) => {
    if (!compliance) return '';
    const done = compliance.done || [];
    const notDone = compliance.notDone || [];
    const needsHumanCheck = compliance.needsHumanCheck || [];
    if (!done.length && !notDone.length && !needsHumanCheck.length) return '';
    const listItems = (arr) => arr.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    return `
      <div class="pr-compliance-section">
        <div class="pr-compliance-header">${sourceLabel} 验收对照</div>
        ${done.length ? `<div class="pr-compliance-bucket bucket-done"><h4>✅ 已完成（${done.length}）</h4><ul>${listItems(done)}</ul></div>` : ''}
        ${notDone.length ? `<div class="pr-compliance-bucket bucket-notdone"><h4>❌ 未完成（${notDone.length}）</h4><ul>${listItems(notDone)}</ul></div>` : ''}
        ${needsHumanCheck.length ? `<div class="pr-compliance-bucket bucket-human"><h4>⚠️ 需人工确认（${needsHumanCheck.length}）</h4><ul>${listItems(needsHumanCheck)}</ul></div>` : ''}
      </div>
    `;
  };

  return `
    <div class="pr-info-row">
      <span class="pull-state-badge ${pull.state}">${stateLabel}</span>
      <span>${escapeHtml(pull.headBranch)} → ${escapeHtml(pull.baseBranch)}</span>
    </div>
    <div class="pr-info-row"><strong>作者：</strong>${escapeHtml(pull.author || '未知')}</div>
    <div class="pr-info-row"><strong>关联任务：</strong>${linkedTasks}</div>
    ${pull.mergedAt ? `<div class="pr-info-row"><strong>合并时间：</strong>${pull.mergedAt.slice(0, 16).replace('T', ' ')}</div>` : ''}

    ${complianceHtml('Hub Review', pull.hubReview?.compliance)}
    ${complianceHtml('PR-Agent', pull.prAgentReview?.compliance)}

    ${pull.hubReview?.level ? `<div class="pr-info-row" style="margin-top:0.8rem;"><strong>Hub Review 级别：</strong>${pull.hubReview.level}</div>` : ''}

    <div class="pr-decision-row">
      <button class="btn-pass" onclick="submitPullDecision('${pull.id}', 'Pass')">✓ Pass</button>
      <button class="btn-escalate" onclick="submitPullDecision('${pull.id}', 'Escalate')">⚠ Escalate</button>
    </div>
    ${pull.humanDecision ? `<div class="pr-info-row" style="margin-top:0.5rem;color:#6b7280;font-size:0.8rem;">已决策：${pull.humanDecision}（${(pull.humanAt||'').slice(0,10)}）</div>` : ''}
  `;
}

async function submitPullDecision(pullId, decision) {
  try {
    const data = await api(`/api/pulls/${encodeURIComponent(pullId)}/decision`, {
      method: 'PATCH',
      body: JSON.stringify({ humanDecision: decision })
    });
    // 更新本地 state
    const idx = (state.pulls || []).findIndex((p) => p.id === pullId);
    if (idx !== -1) state.pulls[idx] = data.pull;
    renderPullList();
    closePullDrawer();
  } catch (err) {
    alert('决策提交失败：' + err.message);
  }
}
```

- [ ] **Step 2: 在导航切换逻辑中加入 #viewPulls 处理**

找到处理导航切换的地方（通常是 `data-view` 监听或类似逻辑），加入：

```js
if (view === 'viewPulls') {
  fetchAndRenderPulls();
}
```

同时在 filter select 元素上绑定 change 事件：

```js
document.getElementById('pullProjectFilter')?.addEventListener('change', fetchAndRenderPulls);
document.getElementById('pullStateFilter')?.addEventListener('change', fetchAndRenderPulls);
document.getElementById('pullAuthorFilter')?.addEventListener('change', fetchAndRenderPulls);
```

- [ ] **Step 3: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 4: 提交**

```bash
git add src/app.js
git commit -m "feat: 前端新增 PR 列表页 renderPullList / openPullDrawer / buildPullDrawerHtml"
```

---

## Phase 5 — 分支保护 & C+ bypass

### Task 17: main-push-policy.yml + store.bypasses + scheduler 告警

**Files:**
- Create: `.github/workflows/main-push-policy.yml`
- Modify: `server/scheduler.js`

- [ ] **Step 1: 创建 main-push-policy.yml**

```yaml
name: Main Push Policy
# 检测非 merge commit 的直推 main 行为
on:
  push:
    branches: [main]

jobs:
  check_bypass:
    runs-on: ubuntu-latest
    steps:
      - name: Check if direct push (not merge commit)
        id: check
        run: |
          # merge commit 通常有 2 个 parents
          PARENTS="${{ github.event.commits[0].message }}"
          IS_MERGE=$(git log --merges -1 --format="%H" ${{ github.sha }} 2>/dev/null | wc -l | tr -d ' ' || echo "0")
          BRANCH="${GITHUB_REF#refs/heads/}"
          HEAD_COMMIT="${{ github.sha }}"
          AUTHOR="${{ github.event.pusher.name }}"
          echo "branch=$BRANCH" >> $GITHUB_OUTPUT
          echo "sha=$HEAD_COMMIT" >> $GITHUB_OUTPUT
          echo "author=$AUTHOR" >> $GITHUB_OUTPUT

      - name: Notify Hub of bypass (hotfix allowed)
        if: always()
        run: |
          BRANCH="${{ steps.check.outputs.branch }}"
          SHA="${{ steps.check.outputs.sha }}"
          AUTHOR="${{ steps.check.outputs.author }}"
          # 通知 Hub 记录 bypass（Hub 自己判断是否是 hotfix）
          curl -sf -X POST "${{ vars.HUB_URL }}/api/webhooks/bypass" \
            -H "Content-Type: application/json" \
            -H "X-CUE-API-Key: ${{ secrets.CUE_API_KEY }}" \
            -d "{\"sha\":\"${SHA}\",\"branch\":\"${BRANCH}\",\"author\":\"${AUTHOR}\",\"repo\":\"${{ github.repository }}\"}" \
            || echo "Hub bypass notification failed (non-fatal)"
```

- [ ] **Step 2: 在 webhookRoutes.js 中加入 /api/webhooks/bypass 端点**

在 `webhookRoutes.js` 中的 `/api/webhooks/pr-agent` 路由之后，加入：

```js
    // C+ bypass 记录（main-push-policy.yml 推送）
    if (req.method === 'POST' && url.pathname === '/api/webhooks/bypass') {
      const provided = req.headers['x-cue-api-key'];
      if (cueApiKey && provided !== cueApiKey) {
        sendError(res, 401, 'invalid api key');
        return true;
      }
      const { json } = await readBody(req);
      if (!json?.sha || !json?.branch) {
        sendJson(res, 200, { received: true, skipped: true });
        return true;
      }
      // 只有 hotfix/* 分支才记录（其他分支通常是 GitHub 自身的 merge commit）
      const isHotfix = String(json.branch || '').startsWith('hotfix/');
      if (!isHotfix) {
        sendJson(res, 200, { received: true, skipped: 'not-hotfix' });
        return true;
      }
      const deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await updateStore((draft) => {
        if (!Array.isArray(draft.bypasses)) draft.bypasses = [];
        const existing = draft.bypasses.find((b) => b.sha === json.sha);
        if (!existing) {
          draft.bypasses.unshift({
            id: createId('bypass'),
            sha: json.sha,
            branch: json.branch,
            author: json.author || '',
            repo: json.repo || '',
            deadline,
            prLinked: false,
            alertSent: false,
            createdAt: new Date().toISOString()
          });
          draft.bypasses = draft.bypasses.slice(0, 100);
        }
        return draft;
      });
      sendJson(res, 202, { received: true, deadline });
      return true;
    }
```

- [ ] **Step 3: 在 scheduler.js 中加入 bypass 超时检查周期任务**

在 `scheduler.js` 的 `startScheduler` 函数中，在现有 `setInterval` 块之后加入：

```js
  // 每小时检查 C+ bypass 是否超期（24h 内未补 PR）
  async function checkBypassDeadlines() {
    if (!isWeComAvailable()) return;
    try {
      const store = await loadStore();
      const overdueBypass = (store.bypasses || []).filter((bypass) => {
        if (bypass.prLinked || bypass.alertSent) return false;
        return new Date(bypass.deadline).getTime() < Date.now();
      });
      if (!overdueBypass.length) return;
      const lines = [
        `## ⚠️ C+ bypass 超期提醒（${overdueBypass.length} 条）`,
        '',
        ...overdueBypass.slice(0, 5).map((b) => `- **${b.author || '未知'}** hotfix commit \`${b.sha.slice(0, 7)}\`（${b.branch}）超过 24h 未补 PR`),
        '',
        '请尽快在 GitHub 开 PR 并关联该 commit，否则团队 review 流程断档。'
      ].join('\n');
      await sendWeComMarkdown(lines);
      // 标记已推送
      await updateStore((draft) => {
        for (const bypass of overdueBypass) {
          const b = (draft.bypasses || []).find((x) => x.id === bypass.id);
          if (b) b.alertSent = true;
        }
        return draft;
      });
    } catch (err) {
      console.error('[Scheduler/bypass]', err.message);
    }
  }

  // 每小时跑一次
  setInterval(checkBypassDeadlines, 60 * 60 * 1000);
  // 启动时也跑一次（延迟 30s，等 store 加载完）
  setTimeout(checkBypassDeadlines, 30000);
```

- [ ] **Step 4: 语法检查**

```bash
cd /Users/dirtortian/Documents/GitHub/CUE-Project-Hub && npm run check
```

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/main-push-policy.yml server/routes/webhookRoutes.js server/scheduler.js
git commit -m "feat: C+ bypass 机制 — main-push-policy.yml + /api/webhooks/bypass + 24h 超期告警"
```

---

## Phase 6 — 团队文档终稿

### Task 18: docs/PR-WORKFLOW.md + docs/开发进度.md 更新

**Files:**
- Create: `docs/PR-WORKFLOW.md`
- Modify: `docs/开发进度.md`

- [ ] **Step 1: 创建 docs/PR-WORKFLOW.md**

```markdown
# CUE 团队 PR 工作流使用说明

> 版本：2026-05-20 | 适用仓库：CUEAITECH/Cue.AI 及所有接入 Hub 的项目仓库

---

## 1. 核心原则

- **PR 是最小交付单元**：每个功能点或 bugfix 对应一个 PR，不要一个 PR 塞多个无关改动
- **AC checklist 必填**：PR 描述里的"验收清单"是 Hub 自动对账的依据，不填则晚会无法自动评估进度
- **hotfix 例外（C+ bypass）**：紧急修复可直推 main，但必须在 **24h 内** 补开 PR，否则触发企微告警

---

## 2. 标准 PR 流程

```
1. 从 main 切出功能分支
   git checkout -b feat/your-feature-name

2. 开发 + commit（遵循 commit 规范）
   git commit -m "feat: 实现 xxx 功能，解决 yyy 问题"

3. 推送分支
   git push origin feat/your-feature-name

4. 在 GitHub 开 PR，填写模板
   - 关联任务 ID（task_xxx 格式）
   - 验收清单（AC checklist）逐条填写

5. PR-Agent 自动 review（约 2-5 分钟）
   - 会在 PR 页面留 review comment
   - Hub 自动同步结果

6. 团队 review + 讨论

7. merge 到 main
   - 晚会对账自动以本 PR 的 compliance 为依据
```

---

## 3. PR 描述模板说明

```markdown
## 关联任务
任务：task_xxx          ← 填 Hub 里的任务 ID，格式必须是 task_xxx

## 验收清单（AC）
- [ ] 用户可以登录          ← 未完成
- [x] 接口返回 200          ← 已完成
- [~] 边界情况待确认        ← 需人工check
```

符号说明：
- `[x]` = 已完成（计入 done 桶）
- `[ ]` = 未完成（计入 notDone 桶）
- `[~]` = 需人工确认（计入 needsHumanCheck 桶，不计入进度）

---

## 4. 分支命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 功能 | `feat/<描述>` | `feat/pr-flow-migration` |
| 修复 | `fix/<描述>` | `fix/login-error` |
| 文档 | `docs/<描述>` | `docs/update-workflow` |
| 热修复（直推 main） | `hotfix/<描述>` | `hotfix/critical-crash` |

---

## 5. C+ bypass（hotfix 直推 main）

**场景**：线上紧急故障，来不及走完整 PR 流程。

**操作**：
1. 在 `hotfix/xxx` 分支上修复并 push
2. 直接 merge 到 main（hub 会记录 bypass）
3. **24h 内** 在 GitHub 补开一个 PR（可以是小 PR）
4. 超 24h 未补 → 企微告警，@你本人

**注意**：只有 `hotfix/` 开头的分支才算合规 bypass，其他分支直推 main 会触发 CI fail。

---

## 6. 晚会对账机制

每天 18:00 晚会，Hub 自动生成对账报告：

1. 取当日 merged PR
2. 读 PR 的 hubReview.compliance（三桶）
3. 计算任务进度 = done / (done + notDone + needsHumanCheck) × 100%
4. 推送企微作战包

如果 PR 没有关联任务 → 单独列出，标注"待关联任务"。

---

## 7. 常见问题

**Q: PR-Agent review comment 看不懂？**  
A: PR-Agent 用英文输出，Hub 做中文映射。可以在 Hub 的 PR 列表页看中文版合规结论。

**Q: 我的任务没有在晚会对账里出现？**  
A: 检查 PR 描述的"关联任务"字段是否填了 `task_xxx` 格式的 ID。

**Q: compliance 三桶和我实际情况不符？**  
A: 在 Hub PR 详情页点"Pass"（人工覆盖）或找 Hub 管理员修正。

**Q: 可以一个 PR 关联多个任务吗？**  
A: 可以，在"关联任务"字段填多行 `task_xxx`。Hub 会把该 PR 的 compliance 同时关联所有任务。
```

- [ ] **Step 2: 在 docs/开发进度.md 追加第七阶段**

打开 `docs/开发进度.md`，在文件末尾追加：

```markdown
## 第七阶段：PR 流全面切换（2026-05-20）

**目标**：以 Pull Request 为最小交付单元，PR-Agent（GitHub Actions）处理代码 review，Hub 负责中文 AC 合规追踪。

**关键变更**：
- store 新增 `pulls` / `bypasses` 集合
- 新增 `prAgentParser.js` / `pullPipeline.js` / `pullRoutes.js`
- `/api/webhooks/pr-agent` sink 接收 Actions 通知
- 晚会对账优先使用 PR hubReview.compliance
- 健康度 review 维度改用 PR 合规率（DORA 对齐）
- 前端新增 `#viewPulls` PR 列表页 + 侧滑详情
- C+ bypass 机制（hotfix 直推 + 24h 补 PR 追踪）
- `docs/PR-WORKFLOW.md` 团队使用说明

**设计文档**：`docs/superpowers/specs/2026-05-20-pr-workflow-migration-design.md`
```

- [ ] **Step 3: 提交**

```bash
git add docs/PR-WORKFLOW.md docs/开发进度.md
git commit -m "docs: 新增 PR-WORKFLOW.md 团队使用说明，更新开发进度第七阶段"
```

---

## 自查 checklist

在所有 Task 完成后运行：

```bash
# 1. 语法检查所有服务端文件
npm run check

# 2. 启动服务验证
npm run dev
# 预期：终端打印启动 banner，无报错

# 3. 验证新 API 端点
curl -s http://127.0.0.1:4317/api/pulls | python3 -m json.tool | head -5
# 预期：{ "pulls": [...] }

# 4. 验证 store 迁移（db.json 有 pulls 和 bypasses 字段）
node -e "import('./server/store.js').then(m => m.loadStore()).then(s => console.log('pulls:', s.pulls?.length, 'bypasses:', s.bypasses?.length))"
```
