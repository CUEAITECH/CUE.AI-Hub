// server/services/syncBroker.js
// W8: 三端同步 Broker — doc ↔ PR ↔ task
//
// 三条同步链：
//   A. PR → task：解析 PR branch/body 中的 task_xxx 引用，写 pull_task_links
//   B. PR merged → task 推进：pr.merged 事件 → task state → merged
//   C. task 完成 → doc 写回：task done → 更新 docs/阶段进度追踪.md
//
// 设计原则：
//   - 幂等：所有操作可重复执行不产生副作用
//   - 降级：GitHub 写回失败不阻断状态机
//   - 可观测：每次同步写 events 表 + console.log

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import { emit } from '../events/bus.js';
import { getOctokit } from './githubClient.js';
import logger from '../logger.js';


// ══════════════════════════════════════════════════════════════
// A. PR → task 链接解析
// ══════════════════════════════════════════════════════════════

/**
 * 从 PR 的 branch name 和 body 中提取关联 task ID
 *
 * 支持格式：
 *   - branch: feat/task_xxx_something  或  fix/task_xxx
 *   - body:   "关联任务：task_xxx"  或  "Closes task_xxx"  或  "#task_xxx"
 *   - body:   任务标题的模糊匹配（兜底）
 */
export function extractTaskRefs(prBranch = '', prBody = '') {
  const refs = new Set();

  // branch name 中的 task_xxx
  const branchMatch = prBranch.match(/task[_-][a-z0-9_-]+/gi) || [];
  branchMatch.forEach(m => refs.add(m.replace('-', '_').toLowerCase()));

  // body 中的显式引用
  const bodyPatterns = [
    /task[_-][a-z0-9_-]+/gi,          // task_xxx 格式
    /(?:closes?|fixes?|关联任务[：:])\s*(task[_-][a-z0-9_-]+)/gi,
    /#(task[_-][a-z0-9_-]+)/gi,
  ];
  for (const pattern of bodyPatterns) {
    const matches = [...(prBody.matchAll(pattern))];
    for (const m of matches) {
      const taskRef = (m[1] || m[0]).replace('-', '_').toLowerCase();
      refs.add(taskRef);
    }
  }

  return [...refs];
}

/**
 * 为 PR 建立与任务的关联（写 pull_task_links）
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.pullId        - pulls 表主键
 * @param {string} params.prBranch
 * @param {string} params.prBody
 * @param {string} [params.projectId]   - 限定在哪个项目内搜索任务
 * @returns {Promise<{ linked: string[]; skipped: string[] }>}
 */
export async function linkPRToTasks({ tenantId, pullId, prBranch, prBody, projectId }) {
  const db = getDb();
  const taskRefs = extractTaskRefs(prBranch, prBody);

  if (taskRefs.length === 0) return { linked: [], skipped: [] };

  const linked = [];
  const skipped = [];

  for (const ref of taskRefs) {
    // 在 tasks 表中查找（ID 精确匹配或 title 模糊）
    let task = db.prepare(`
      SELECT id FROM tasks
      WHERE tenant_id = ? AND (id = ? OR id LIKE ?)
        AND (? IS NULL OR project_id = ?)
    `).get(tenantId, ref, `%${ref}%`, projectId || null, projectId || null);

    if (!task) {
      skipped.push(ref);
      continue;
    }

    // INSERT OR IGNORE（幂等）
    await dbWrite(`syncBroker:link:${pullId}:${task.id}`, (db) => {
      db.prepare(`
        INSERT OR IGNORE INTO pull_task_links (pull_id, task_id)
        VALUES (?, ?)
      `).run(pullId, task.id);
    });

    linked.push(task.id);
  }

  if (linked.length > 0) {
    logger.info(`[syncBroker] PR ${pullId} → tasks: ${linked.join(', ')}`);
  }

  return { linked, skipped };
}

// ══════════════════════════════════════════════════════════════
// B. PR merged → task 推进
// ══════════════════════════════════════════════════════════════

/**
 * PR 合并后推进关联任务状态（emit pr.merged 事件）
 * reducer.js 中的 pr.merged handler 会处理实际状态转移
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.pullId
 * @param {string} [params.mergedAt]
 */
export async function onPRMerged({ tenantId, pullId, mergedAt }) {
  const db = getDb();

  // 更新 pulls 表状态
  await dbWrite('syncBroker:pr.merged.update', (db) => {
    db.prepare(`
      UPDATE pulls SET state = 'merged', merged_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(mergedAt || new Date().toISOString(), new Date().toISOString(), pullId, tenantId);
  });

  // 读取关联任务列表
  const links = db.prepare(`
    SELECT task_id FROM pull_task_links WHERE pull_id = ?
  `).all(pullId);

  const taskIds = links.map(l => l.task_id);

  if (taskIds.length > 0) {
    // emit pr.merged 事件（reducer 负责状态转移）
    // pr.merged schema: { tenantId, prNumber, repoFull, mergedAt, prId?, taskIds? }
    const pull = db.prepare('SELECT number, project_id FROM pulls WHERE id = ? AND tenant_id = ?').get(pullId, tenantId);
    await emit('pr.merged', {
      tenantId,
      prNumber: pull?.number || 0,
      repoFull: pullId,  // 用 pullId 作为 repoFull 标识（无 GitHub 上下文时）
      prId: pullId,
      taskIds,
      mergedAt: mergedAt || new Date().toISOString(),
    }, { source: 'sync-broker' });
  }

  // 任务推进到 merged 后，触发 doc 写回
  for (const taskId of taskIds) {
    await scheduleDocWriteback({ tenantId, taskId, trigger: 'pr.merged' });
  }

  logger.info(`[syncBroker] PR ${pullId} merged → ${taskIds.length} tasks advanced`);
  return { pullId, taskIds };
}

// ══════════════════════════════════════════════════════════════
// C. task → doc 写回
// ══════════════════════════════════════════════════════════════

const PROGRESS_DOC_PATH = 'docs/阶段进度追踪.md';

/**
 * 将任务状态变化写回 GitHub docs（防抖：30s 内多次触发只写一次）
 * 实际写回由 writeProgressDoc 执行
 */
const _writebackDebounce = new Map(); // projectId → timer

export async function scheduleDocWriteback({ tenantId, taskId, trigger }) {
  const db = getDb();
  const task = db.prepare('SELECT project_id FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
  if (!task?.project_id) return;

  const key = `${tenantId}:${task.project_id}`;

  // 防抖：已有定时器则重置
  if (_writebackDebounce.has(key)) {
    clearTimeout(_writebackDebounce.get(key));
  }

  const timer = setTimeout(async () => {
    _writebackDebounce.delete(key);
    try {
      await writeProgressDoc({ tenantId, projectId: task.project_id });
    } catch (err) {
      logger.warn(`[syncBroker] doc writeback failed for ${task.project_id}: ${err.message}`);
    }
  }, 30_000); // 30s 防抖

  _writebackDebounce.set(key, timer);
  logger.info(`[syncBroker] doc writeback scheduled for project ${task.project_id} (trigger: ${trigger})`);
}

/**
 * 立即写回 docs/阶段进度追踪.md 到 GitHub
 * 基于当前 tasks 表状态生成 Markdown
 */
export async function writeProgressDoc({ tenantId, projectId }) {
  const db = getDb();

  // 读取项目信息
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, tenantId);
  if (!project) throw new Error(`project ${projectId} not found`);

  // 需要 GitHub 配置（优先读列，再读 data_json 兜底）
  const dataJson = JSON.parse(project.data_json || '{}');
  const owner = project.github_owner || dataJson.githubOwner;
  const repo  = project.github_repo  || dataJson.githubRepo;

  if (!owner || !repo) {
    logger.info(`[syncBroker] project ${projectId} has no GitHub config, skipping doc writeback`);
    return { skipped: true, reason: 'no-github-config' };
  }

  // 生成进度文档内容
  const markdown = await buildProgressMarkdown({ tenantId, projectId, project });

  // 写回 GitHub
  await githubWriteFile({ owner, repo, path: PROGRESS_DOC_PATH, content: markdown, message: `docs: Hub 自动同步进度 — ${new Date().toISOString().slice(0, 10)}` });

  logger.info(`[syncBroker] wrote progress doc to ${owner}/${repo}`);
  return { ok: true, owner, repo, path: PROGRESS_DOC_PATH };
}

/**
 * 构建进度追踪 Markdown
 */
async function buildProgressMarkdown({ tenantId, projectId, project }) {
  const db = getDb();

  const tasks = db.prepare(`
    SELECT t.*, a.display_name as actor_name
    FROM tasks t
    LEFT JOIN actors a ON t.actor_id = a.id
    WHERE t.tenant_id = ? AND t.project_id = ?
    ORDER BY t.priority ASC, t.created_at ASC
  `).all(tenantId, projectId);

  const byState = {
    done:        tasks.filter(t => t.state === 'done' || t.state === 'merged'),
    in_progress: tasks.filter(t => ['in_progress', 'in_review', 'claimed'].includes(t.state)),
    pending:     tasks.filter(t => t.state === 'pending'),
    cancelled:   tasks.filter(t => t.state === 'cancelled'),
  };

  const total   = tasks.length;
  const doneCount  = byState.done.length;
  const progress   = total > 0 ? Math.round(doneCount / total * 100) : 0;

  const stateEmoji = { done: '✅', merged: '✅', in_progress: '🔄', in_review: '👀', claimed: '🎯', pending: '⬜', cancelled: '❌' };

  const taskRows = tasks.map(t => {
    const emoji = stateEmoji[t.state] || '⬜';
    const actor = t.actor_name ? ` @${t.actor_name}` : '';
    const progress = t.progress > 0 ? ` (${t.progress}%)` : '';
    return `| ${emoji} | ${t.priority || '-'} | ${t.title}${progress} | ${t.state}${actor} |`;
  }).join('\n');

  return `# ${project.name || projectId} — 进度追踪

> 自动生成 by CUE Hub · 最后更新：${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC

## 总览

- 总任务：**${total}** 个
- 已完成：**${doneCount}** 个（${progress}%）
- 进行中：**${byState.in_progress.length}** 个
- 待领取：**${byState.pending.length}** 个

## 任务明细

| 状态 | 优先级 | 任务 | 详情 |
|------|--------|------|------|
${taskRows || '| — | — | 暂无任务 | — |'}

---
*本文档由 CUE Hub 自动同步，手动修改会在下次同步时被覆盖。*
*如需修改任务状态，请在 [CUE Hub](${process.env.HUB_URL || 'https://hub.cueai.top'}) 操作。*
`;
}

/**
 * 通过 GitHub API 写入文件（PUT，幂等）
 */
async function githubWriteFile({ owner, repo, path, content, message }) {
  const octokit = getOctokit();

  // 读取现有文件 SHA（更新需要提供 SHA）
  let sha;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    sha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
    // 文件不存在，初次创建
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner, repo, path,
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

// ══════════════════════════════════════════════════════════════
// Webhook 路由：接收 GitHub PR webhook，触发同步链
// ══════════════════════════════════════════════════════════════

/**
 * 处理来自 GitHub 的 pull_request webhook 事件
 * 由 v2/app.js 的 POST /v2/sync/webhook 调用
 */
export async function handlePRWebhook({ tenantId, event, payload }) {
  const action = payload.action;
  const pr     = payload.pull_request;

  if (!pr) return { ignored: true, reason: 'no pull_request in payload' };

  const db = getDb();

  // 查找或创建 pull 记录
  const projectId = await resolveProjectFromRepo(tenantId, payload.repository);
  if (!projectId) return { ignored: true, reason: 'repo not linked to any project' };

  const pullId = `pull_${tenantId}_${payload.repository.name}_${pr.number}`;

  await dbWrite('syncBroker:webhook.upsert', (db) => {
    db.prepare(`
      INSERT INTO pulls (id, tenant_id, project_id, number, title, body, state, author, head_branch, base_branch, raw_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, body = excluded.body,
        state = excluded.state, updated_at = excluded.updated_at
    `).run(
      pullId, tenantId, projectId,
      pr.number, pr.title || '', pr.body || '',
      pr.merged_at ? 'merged' : pr.state,
      pr.user?.login || '',
      pr.head?.ref || '', pr.base?.ref || '',
      JSON.stringify(payload),
      pr.created_at || new Date().toISOString(),
      new Date().toISOString()
    );
  });

  // 链路 A：解析 PR → tasks 关联
  const linkResult = await linkPRToTasks({
    tenantId,
    pullId,
    prBranch: pr.head?.ref || '',
    prBody:   pr.body || '',
    projectId,
  });

  let mergeResult = null;

  // 链路 B：PR 合并 → 推进任务
  if (action === 'closed' && pr.merged_at) {
    mergeResult = await onPRMerged({
      tenantId,
      pullId,
      mergedAt: pr.merged_at,
    });
  }

  return {
    ok: true,
    pullId,
    action,
    linked:   linkResult.linked,
    skipped:  linkResult.skipped,
    advanced: mergeResult?.taskIds || [],
  };
}

/**
 * 从 webhook repository 对象解析出 projectId
 */
async function resolveProjectFromRepo(tenantId, repository) {
  if (!repository) return null;
  const db = getDb();

  const repoName  = repository.name || '';
  const repoOwner = repository.owner?.login || '';

  // 查找 projects 表中 raw_json 包含该 repo 信息的项目
  const projects = db.prepare(`
    SELECT id, name, github_owner, github_repo FROM projects WHERE tenant_id = ?
  `).all(tenantId);

  for (const p of projects) {
    if (
      (p.github_repo === repoName || p.name === repoName) &&
      (!repoOwner || p.github_owner === repoOwner)
    ) {
      return p.id;
    }
  }

  // 兜底：返回第一个项目（单项目场景）
  const first = db.prepare('SELECT id FROM projects WHERE tenant_id = ? LIMIT 1').get(tenantId);
  return first?.id || null;
}

// ══════════════════════════════════════════════════════════════
// 手动触发：全量重同步（幂等，安全重跑）
// ══════════════════════════════════════════════════════════════

/**
 * 重新解析所有 PR 与任务的关联关系
 * 适合初次接入或数据修复场景
 */
export async function resyncAllPRLinks({ tenantId, projectId }) {
  const db = getDb();

  let q = 'SELECT * FROM pulls WHERE tenant_id = ?';
  const params = [tenantId];
  if (projectId) { q += ' AND project_id = ?'; params.push(projectId); }

  const pulls = db.prepare(q).all(...params);
  let totalLinked = 0;

  for (const pull of pulls) {
    const { linked } = await linkPRToTasks({
      tenantId,
      pullId:    pull.id,
      prBranch:  pull.head_branch || '',
      prBody:    pull.body || '',
      projectId: pull.project_id,
    });
    totalLinked += linked.length;
  }

  logger.info(`[syncBroker] resync complete: ${pulls.length} PRs, ${totalLinked} links created`);
  return { pulls: pulls.length, linksCreated: totalLinked };
}
