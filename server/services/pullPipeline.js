/**
 * pullPipeline.js
 * PR 入库流水线：fetchPR → resolve tasks → hubReview → persist
 *
 * 调用方：
 *   - githubSync.js（定时同步）
 *   - webhookRoutes.js（GitHub PR webhook / PR-Agent sink）
 */

import { fetchProjectPRs, fetchPRDetail, fetchPRDiff, fetchPRFiles, parseRepo } from './githubApi.js';
import { parsePrAgentReview } from './prAgentParser.js';
import { reviewChange } from './reviewer.js';
import { bindActivityToExplicitRefs } from './bindingEngine.js';
import { createId } from '../store.js';
import { trace } from './syncTrace.js';
import logger from '../logger.js';


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
 *
 * LLM_DRY_RUN=true 时不调真 API，返回 stub 结果（用于排查调用频次问题，不烧钱）
 */
/**
 * 混合审阅模式：
 *   有 PR-Agent 数据 → Hub LLM 只做 AC 对账，代码 issues 用 PR-Agent 的结果
 *   无 PR-Agent 数据 → Hub LLM 全量审阅（当前行为）
 *
 * 好处：避免重复分析代码质量，Hub 专注 Task 合规；PR-Agent 负责代码细节
 */
async function buildHubReview(prDetail, linkedTaskIds, store, owner, repo) {
  if (process.env.LLM_DRY_RUN === 'true') {
    trace('llm-dryrun-stub', { prNumber: prDetail.number });
    return {
      level: 'Pass',
      compliance: null,
      issues: [],
      createdAt: new Date().toISOString(),
      dryRun: true
    };
  }

  const tasks = store.tasks || [];
  const linkedTask = linkedTaskIds.length
    ? tasks.find((t) => t.id === linkedTaskIds[0])
    : null;

  try {
    // 获取真实 PR diff 和文件列表
    let diff = prDetail.body || '';
    let files = [];
    let diffVersion = 'body';

    if (owner && repo && prDetail.number) {
      try {
        [diff, files] = await Promise.all([
          fetchPRDiff(owner, repo, prDetail.number),
          fetchPRFiles(owner, repo, prDetail.number)
        ]);
        diffVersion = 'real';
      } catch (err) {
        logger.warn(`[pullPipeline] 获取 PR diff 失败，降级使用 PR body: ${err.message}`);
      }
    }

    // 解析 PR-Agent 审阅（可能是 null，取决于 PR-Agent 是否已跑完）
    const prAgentData = parsePrAgentReview(prDetail);
    const prAgentIssues = prAgentData?.issues?.length ? prAgentData.issues : null;

    if (prAgentIssues) {
      trace('hybrid-review', {
        prNumber: prDetail.number,
        prAgentIssueCount: prAgentIssues.length,
        botLogin: prAgentData.botLogin
      });
    }

    const result = await reviewChange({
      repo: `${prDetail.number}`,
      title: prDetail.title,
      owner: prDetail.author,
      diff,
      files,
      task: linkedTask || null,
      prAgentIssues        // 传入后 reviewer 自动切换 AC-only 模式
    });

    // 完成度：done / (done + notDone) * 100
    const compliance = result.compliance || null;
    let completionRate = null;
    if (compliance) {
      const done = Array.isArray(compliance.done) ? compliance.done.length : 0;
      const notDone = Array.isArray(compliance.notDone) ? compliance.notDone.length : 0;
      const total = done + notDone;
      completionRate = total > 0 ? Math.round((done / total) * 100) : null;
    }

    // Block 级问题（critical/security → override 流程）
    const blocks = (result.issues || [])
      .filter((i) => i.severity === 'critical' || i.severity === 'security')
      .map((i) => ({ issue: i.header || i.description || '', severity: i.severity, isOverridden: false }));

    return {
      level: result.level || 'Pass',
      compliance: linkedTask && compliance ? { taskId: linkedTask.id, ...compliance } : null,
      issues: result.issues || [],
      suggestion: result.suggestion || '',
      completionRate,
      blocks,
      diffVersion,
      analysisSource: result._source || 'unknown',
      // PR-Agent 元数据（用于前端展示来源和 effort 参考）
      prAgentMeta: prAgentData
        ? { botLogin: prAgentData.botLogin, effort: prAgentData.effort, hasSecurityConcern: prAgentData.hasSecurityConcern, rawUrl: prAgentData.rawUrl }
        : null,
      createdAt: new Date().toISOString()
    };
  } catch (err) {
    logger.error('[pullPipeline] hubReview failed:', err.message);
    return null;
  }
}

/**
 * 同步单个 PR 进 store
 * - 若已存在（按 pull id）则更新；否则新增
 * - 返回 { isNew: boolean, pull: object }
 * @param {object}  prDetail   - PR 详情
 * @param {string}  projectId  - 项目 ID
 * @param {function} updateStore
 * @param {object}  store      - 当前 store 快照
 * @param {string}  owner      - GitHub owner（可选）
 * @param {string}  repo       - GitHub repo（可选）
 * @param {object}  [options]
 * @param {boolean} [options.forceRebuild=false] - 强制重建 hubReview（PR-Agent sink 触发时使用）
 */
export async function upsertPullIntoStore(prDetail, projectId, updateStore, store, owner, repo, options = {}) {
  const { forceRebuild = false } = options;
  const linkedTaskIds = extractLinkedTaskIds(prDetail.title, prDetail.body, store);
  const pullId = `pull_${prDetail.number}_${projectId}`;
  const existing = (store.pulls || []).find((p) => p.id === pullId);

  const dryRun = process.env.LLM_DRY_RUN === 'true';

  // 先解析 PR-Agent 数据（需要在 unchanged 判断之前）
  // 原因：即使 PR 内容没变，PR-Agent 可能刚发完 review，需要触发混合模式重跑
  const prAgentDataEarly = parsePrAgentReview(prDetail);
  const freshIssueCount = prAgentDataEarly?.issues?.length ?? 0;
  const storedIssueCount = existing?.prAgentReview?.issues?.length ?? 0;

  // 情况 1：PR-Agent 数据首次到达（之前没有 llm+pr-agent 来源的审阅）
  const prAgentJustArrived = freshIssueCount > 0 &&
    existing?.hubReview?.analysisSource !== 'llm+pr-agent';

  // 情况 2：解析器逻辑更新导致 issue 数发生变化（例如修复了误分类 bug）
  // 这确保服务器重启后，Parser 修复会自动重跑受影响的 PR
  const prAgentIssuesChanged = freshIssueCount !== storedIssueCount &&
    existing?.hubReview?.analysisSource === 'llm+pr-agent';

  // 跳过条件：已有 review + 真实 diff + PR 未变 + 未被强制重建 + PR-Agent 数据未变
  const unchanged = !forceRebuild && !dryRun && !prAgentJustArrived && !prAgentIssuesChanged &&
    existing?.hubReview &&
    existing.hubReview.diffVersion === 'real' &&
    existing.state === prDetail.state &&
    existing.updatedAt >= (prDetail.updatedAt || '');

  const rebuildReason = dryRun ? 'dry-run'
    : forceRebuild ? 'pr-agent-sink'
    : prAgentJustArrived ? 'pr-agent-data-arrived'
    : prAgentIssuesChanged ? 'pr-agent-issues-changed'
    : existing ? 'pr-changed'
    : 'new-pr';

  if (unchanged) {
    trace('llm-skip', { prNumber: prDetail.number, projectId, reason: 'unchanged' });
  } else {
    trace('llm-call', {
      prNumber: prDetail.number, projectId, reason: rebuildReason,
      existingState: existing?.state, newState: prDetail.state
    });
  }
  const hubReview = unchanged ? existing.hubReview : await buildHubReview(prDetail, linkedTaskIds, store, owner, repo);
  const prAgentReview = prAgentDataEarly; // 已在 unchanged 判断前解析，直接复用

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

    // 镜像 hubReview → store.reviews（供审阅队列 + 人工决策接口使用）
    // 使用稳定 ID rev_pr_<pullId>，让 PATCH /api/reviews/:id 能定位到同一条记录
    if (hubReview) {
      const reviewId = `rev_pr_${pullId}`;
      if (!Array.isArray(draft.reviews)) draft.reviews = [];
      const revIdx = draft.reviews.findIndex((r) => r.id === reviewId);
      const existing = revIdx >= 0 ? draft.reviews[revIdx] : null;
      const reviewEntry = {
        id: reviewId,
        pullId,
        title: prDetail.title || '',
        owner: prDetail.author || '',
        repo: `${owner}/${repo}`,
        prNumber: prDetail.number,
        level: hubReview.level || 'Pass',
        completionRate: hubReview.completionRate !== undefined ? hubReview.completionRate : null,
        blocks: hubReview.blocks || [],
        compliance: hubReview.compliance || null,
        issues: hubReview.issues || [],
        suggestion: hubReview.suggestion || '',
        analysisSource: hubReview.analysisSource || null,
        diffVersion: hubReview.diffVersion || null,
        // 保留已有的人工决策（不被新一轮 AI review 覆盖）
        humanDecision: existing?.humanDecision || null,
        humanNote: existing?.humanNote || '',
        humanAt: existing?.humanAt || null,
        createdAt: existing?.createdAt || hubReview.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (revIdx === -1) {
        draft.reviews.unshift(reviewEntry);
      } else {
        draft.reviews[revIdx] = reviewEntry;
      }
      draft.reviews = draft.reviews.slice(0, 200);
    }

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

  trace('sync-start', { projectId: project.id, owner, repo, options });

  const sinceDays = parseInt((options.since || '14 days ago').replace(/\s*days?\s*ago/i, '')) || 14;
  const sinceDate = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  let prs;
  try {
    prs = await fetchProjectPRs(owner, repo, { state: 'all', since: sinceDate, per_page: 30 });
  } catch (err) {
    logger.error(`[pullPipeline] fetchProjectPRs failed for ${owner}/${repo}:`, err.message);
    return { added: 0, updated: 0, pulls: [] };
  }

  let added = 0;
  let updated = 0;
  const results = [];

  for (const pr of prs) {
    try {
      // 拉取完整详情（含 review comments，用于 prAgentParser）
      const prDetail = await fetchPRDetail(owner, repo, pr.number);
      const { isNew, pull } = await upsertPullIntoStore(prDetail, project.id, updateStore, store, owner, repo);
      if (isNew) added++;
      else updated++;
      results.push(pull);
    } catch (err) {
      logger.error(`[pullPipeline] failed on PR #${pr.number}:`, err.message);
    }
  }

  trace('sync-end', { projectId: project.id, added, updated, total: results.length });
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
/**
 * GitHub webhook 触发的单 PR 实时同步（替代轮询）
 * 调用方：webhookRoutes.js 接收 pull_request 事件后
 */
export async function upsertPullFromWebhook(repoFull, prNumber, action) {
  trace('pr-webhook', { repoFull, prNumber, action });

  const [owner, repoName] = repoFull.split('/');
  if (!owner || !repoName) return null;

  // 动态加载 store helpers 避免循环依赖
  const { loadStore: load, updateStore: update } = await import('../store.js');
  const store = await load();

  const project = (store.projects || []).find((p) => {
    const full = p.githubFullRepo || `${p.githubOwner}/${p.repository}`;
    return full.toLowerCase() === repoFull.toLowerCase();
  });
  if (!project) {
    logger.warn(`[pullPipeline] PR webhook: no project for repo ${repoFull}`);
    return null;
  }

  try {
    const prDetail = await fetchPRDetail(owner, repoName, prNumber);
    const { pull } = await upsertPullIntoStore(prDetail, project.id, update, store, owner, repoName);
    logger.info(`[pullPipeline] PR #${prNumber} (${action}) upserted via webhook`);
    return pull;
  } catch (err) {
    logger.error(`[pullPipeline] upsertPullFromWebhook failed:`, err.message);
    return null;
  }
}

export async function handlePrAgentSink(payload, store, updateStore) {
  const { repo = '', pr_number } = payload;
  trace('pr-agent-sink', { repo, pr_number, payload });
  if (!repo || !pr_number) return null;

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return null;

  // 找对应的 project
  const project = (store.projects || []).find((p) => {
    const full = p.githubFullRepo || `${p.githubOwner}/${p.repository}`;
    return full.toLowerCase() === repo.toLowerCase();
  });

  if (!project) {
    logger.warn(`[pullPipeline] PR-Agent sink: no project found for repo ${repo}`);
    return null;
  }

  try {
    const prDetail = await fetchPRDetail(owner, repoName, pr_number);
    // forceRebuild=true：让 Hub 以混合模式重跑审阅（读取 PR-Agent 评论 → AC-only LLM）
    const { pull } = await upsertPullIntoStore(
      prDetail, project.id, updateStore, store, owner, repoName,
      { forceRebuild: true }
    );
    logger.info(`[pullPipeline] PR #${pr_number} upserted via PR-Agent sink (hybrid mode)`);
    return pull;
  } catch (err) {
    logger.error(`[pullPipeline] handlePrAgentSink failed:`, err.message);
    return null;
  }
}
