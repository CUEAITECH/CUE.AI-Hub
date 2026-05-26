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
    files: prData.files || [],
    additions: prData.additions || 0,
    deletions: prData.deletions || 0,
    changedFiles: prData.changedFiles || 0,
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
    // 获取真实 PR diff 和文件列表（若有 GitHub 配置）
    let diff = prDetail.body || '';
    let files = [];
    let diffVersion = 'body'; // 标记 diff 来源，用于判断是否需要重新分析

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

    const result = await reviewChange({
      repo: `${prDetail.number}`,
      title: prDetail.title,
      owner: prDetail.author,
      diff,
      files,
      task: linkedTask || null
    });

    // 计算完成度：done / (done + notDone) * 100
    const compliance = result.compliance || null;
    let completionRate = null;
    if (compliance) {
      const done = Array.isArray(compliance.done) ? compliance.done.length : 0;
      const notDone = Array.isArray(compliance.notDone) ? compliance.notDone.length : 0;
      const total = done + notDone;
      completionRate = total > 0 ? Math.round((done / total) * 100) : null;
    }

    // 提取 Block 级问题（用于 override 流程）
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
 * @param {object} prDetail - PR 详情
 * @param {string} projectId - 项目 ID
 * @param {function} updateStore - 更新 store 的回调
 * @param {object} store - 当前 store 快照
 * @param {string} owner - GitHub owner（可选，用于获取真实 diff）
 * @param {string} repo - GitHub repo（可选，用于获取真实 diff）
 */
export async function upsertPullIntoStore(prDetail, projectId, updateStore, store, owner, repo) {
  const linkedTaskIds = extractLinkedTaskIds(prDetail.title, prDetail.body, store);
  const pullId = `pull_${prDetail.number}_${projectId}`;
  const existing = (store.pulls || []).find((p) => p.id === pullId);

  // LLM_DRY_RUN=true：绕过缓存，强制让每个 PR 进 buildHubReview 路径
  // 这样能完整复现"原始触发次数"（buildHubReview 内部会走 stub 不烧钱）
  const dryRun = process.env.LLM_DRY_RUN === 'true';

  // 跳过 LLM：已有 review 且 PR 状态/更新时间未变，且已经用真实 diff 分析过
  // diffVersion !== 'real' 的旧缓存（用 PR body 或伪字符串分析）会被强制重建
  const unchanged = !dryRun && existing?.hubReview &&
    existing.hubReview.diffVersion === 'real' &&
    existing.state === prDetail.state &&
    existing.updatedAt >= (prDetail.updatedAt || '');
  if (unchanged) {
    trace('llm-skip', { prNumber: prDetail.number, projectId, reason: 'unchanged' });
  } else {
    trace('llm-call', {
      prNumber: prDetail.number,
      projectId,
      reason: dryRun ? 'dry-run' : (existing ? 'pr-changed' : 'new-pr'),
      existingState: existing?.state,
      newState: prDetail.state
    });
  }
  const hubReview = unchanged ? existing.hubReview : await buildHubReview(prDetail, linkedTaskIds, store, owner, repo);
  const prAgentReview = parsePrAgentReview(prDetail);

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
    commits: prDetail.commits || existing?.commits || [],
    files: prDetail.files || existing?.files || [],
    additions: prDetail.additions ?? existing?.additions ?? 0,
    deletions: prDetail.deletions ?? existing?.deletions ?? 0,
    changedFiles: prDetail.changedFiles ?? existing?.changedFiles ?? 0,
    mergedAt: prDetail.mergedAt || existing?.mergedAt || null,
    createdAt: prDetail.createdAt || existing?.createdAt || new Date().toISOString(),
    updatedAt: prDetail.updatedAt || existing?.updatedAt || new Date().toISOString(),
    syncedAt: new Date().toISOString()
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
    const { pull } = await upsertPullIntoStore(prDetail, project.id, updateStore, store, owner, repoName);
    logger.info(`[pullPipeline] PR #${pr_number} upserted (project: ${project.id})`);
    return pull;
  } catch (err) {
    logger.error(`[pullPipeline] handlePrAgentSink failed:`, err.message);
    return null;
  }
}
