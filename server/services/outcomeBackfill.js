// server/services/outcomeBackfill.js
// Part M.1 延迟 Outcome Backfill
// pr.merged 后 7 天，回查是否出现 revert/fix 提交，更新 ai_outcomes.polarity
//
// 触发：node-cron 每日 02:00 跑一次
// 逻辑：
//   1. 取 7-8 天前合并的 PR（7天观察窗口刚到期）
//   2. 检查该 PR 之后是否有包含 "revert"/"fix"/"hotfix" 的 commit（通过 pulls.head_branch 查 GitHub）
//   3. 有 → polarity=-1（合并后需要修复，负向信号）
//   4. 无 → polarity 升为 +1（稳定合并，正向信号）
//   5. 更新 ai_outcomes 表（已有 polarity=0 的记录）

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import logger from '../logger.js';

const REVERT_KEYWORDS = /\b(revert|fix|hotfix|rollback|紧急修复|回滚)\b/i;

/**
 * 检查 PR 合并后是否有修复提交（本地数据库版本）
 * 查询 activities 表（hub 同步的 commit 记录），不调 GitHub API
 */
function checkForFixCommits(db, { projectId, mergedAt, headBranch }) {
  // 查 activities 表中，合并后 7 天内、属于同一项目的 commit，是否含修复关键词
  const sevenDaysAfter = new Date(new Date(mergedAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // 注意：activities 是 v1 store，v2 可能没有。兼容处理
  try {
    const fixCommits = db.prepare(`
      SELECT COUNT(*) as n FROM activities
      WHERE project_id = ?
        AND type = 'commit'
        AND created_at > ?
        AND created_at <= ?
        AND (message LIKE '%revert%' OR message LIKE '%fix%' OR message LIKE '%hotfix%'
             OR message LIKE '%回滚%' OR message LIKE '%紧急%')
    `).get(projectId, mergedAt, sevenDaysAfter);
    return fixCommits.n > 0;
  } catch {
    // activities 表不存在（v2-only 环境）
    return false;
  }
}

/**
 * 对一个 PR 的 outcome 执行 backfill
 * @param {object} db
 * @param {object} pull  - pulls 表记录
 * @param {string} tenantId
 */
async function backfillPrOutcome(db, pull, tenantId) {
  // 找该 PR 关联 task 的 polarity=0 的 outcome 记录
  const outcomes = db.prepare(`
    SELECT o.id, o.action_ref_id
    FROM ai_outcomes o
    JOIN tasks t ON o.action_ref_id = t.id
    JOIN pull_task_links ptl ON ptl.task_id = t.id
    WHERE o.tenant_id = ? AND ptl.pull_id = ? AND o.polarity = 0
      AND o.action_type = 'task.dispatch'
    LIMIT 20
  `).all(tenantId, pull.id);

  if (outcomes.length === 0) return { updated: 0, prId: pull.id };

  const hasFixCommit = checkForFixCommits(db, {
    projectId:  pull.project_id,
    mergedAt:   pull.merged_at,
    headBranch: pull.head_branch,
  });

  const newPolarity = hasFixCommit ? -1 : 1;
  const evidence = hasFixCommit
    ? 'PR 合并后 7 天内发现 fix/revert 提交（自动回填）'
    : 'PR 合并后 7 天内未发现修复提交，合并稳定（自动回填）';

  const now = new Date().toISOString();

  await dbWrite('outcomeBackfill:update', (db) => {
    for (const o of outcomes) {
      db.prepare(`
        UPDATE ai_outcomes
        SET polarity = ?, outcome_signal = ?, observed_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(newPolarity, evidence, now, o.id, tenantId);
    }
  });

  logger.info(`[outcomeBackfill] PR ${pull.id} backfilled → polarity=${newPolarity} (${outcomes.length} outcomes, hasFixCommit=${hasFixCommit})`);
  return { updated: outcomes.length, prId: pull.id, polarity: newPolarity };
}

/**
 * 主入口：对所有"7-8天前合并的PR"执行 backfill
 * @param {object} params
 * @param {string} params.tenantId
 * @param {number} [params.dryRun=false] - 只查询不写入
 * @returns {Promise<object>} backfill 结果汇总
 */
export async function runOutcomeBackfill({ tenantId, dryRun = false }) {
  const db = getDb();

  // 7 天前到 8 天前的时间窗（刚过观察期的 PR）
  const windowEnd   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const windowStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  const prs = db.prepare(`
    SELECT id, project_id, head_branch, merged_at
    FROM pulls
    WHERE tenant_id = ? AND state = 'merged'
      AND merged_at >= ? AND merged_at < ?
    LIMIT 50
  `).all(tenantId, windowStart, windowEnd);

  if (prs.length === 0) {
    logger.info('[outcomeBackfill] no PRs in 7-day observation window, skip');
    return { checked: 0, updated: 0, dryRun };
  }

  logger.info(`[outcomeBackfill] found ${prs.length} PRs in 7-day window (${windowStart.slice(0,10)} ~ ${windowEnd.slice(0,10)})`);

  if (dryRun) {
    return { checked: prs.length, updated: 0, dryRun, prs: prs.map(p => p.id) };
  }

  let totalUpdated = 0;
  const results = [];
  for (const pull of prs) {
    const r = await backfillPrOutcome(db, pull, tenantId);
    totalUpdated += r.updated;
    results.push(r);
  }

  return { checked: prs.length, updated: totalUpdated, dryRun, results };
}
