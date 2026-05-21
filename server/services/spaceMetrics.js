// server/services/spaceMetrics.js
// W11: SPACE 健康指标引擎
//
// SPACE Framework（DevEx 研究，Forsgren 等 2021）：
//   S — Satisfaction & Well-being：团队满意度（standup blockers 代理）
//   P — Performance：交付质量（review pass 率、done 率）
//   A — Activity：生产活动量（commits、PR、任务完成数）
//   C — Communication & Collaboration：协作效率（PR review 响应时间）
//   E — Efficiency & Flow：流动效率（PR 合并周期、任务 WIP）
//
// 设计原则：
//   - 无 LLM 依赖：纯数据库查询
//   - 多粒度：项目级 / 成员级 / 全租户
//   - 时间窗口：默认 14 天，可自定义

import { getDb } from '../db/index.js';

const DEFAULT_WINDOW_DAYS = 14;

/**
 * 计算 SPACE 指标
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.projectId]    - 限定项目（null = 全租户）
 * @param {number} [params.windowDays]   - 时间窗口（天）
 * @returns {object} spaceReport
 */
export function computeSpaceMetrics({ tenantId, projectId, windowDays = DEFAULT_WINDOW_DAYS }) {
  const db = getDb();
  const cutoff = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const projectFilter = projectId ? ' AND project_id = ?' : '';
  const projectParams = projectId ? [projectId] : [];

  // ── S: Satisfaction（代理：standup 有无 blockers + blockers 比例）
  const satisfactionMetrics = (() => {
    // 期间内 standup 总数 vs 有 blockers 的
    const standupStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN blockers IS NOT NULL AND blockers != '' AND blockers != '无' THEN 1 ELSE 0 END) as withBlockers
      FROM standups
      WHERE tenant_id = ? AND date >= ?
    `).get(tenantId, cutoff.slice(0, 10));

    const blockerRate = standupStats.total > 0
      ? Math.round(standupStats.withBlockers / standupStats.total * 100)
      : 0;

    // 满意度分：blockerRate 越低越好
    const score = Math.max(0, 100 - blockerRate * 1.5);

    return {
      score: Math.round(Math.min(100, score)),
      standups: standupStats.total,
      standupWithBlockers: standupStats.withBlockers,
      blockerRate,
    };
  })();

  // ── P: Performance（审阅通过率 + 任务完成率）
  const performanceMetrics = (() => {
    const reviews = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN level = 'Pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN level = 'Block' THEN 1 ELSE 0 END) as blocked
      FROM reviews
      WHERE tenant_id = ?  AND created_at >= ?
    `).get(tenantId, cutoff);

    const reviewPassRate = reviews.total > 0
      ? Math.round(reviews.passed / reviews.total * 100)
      : 100;

    const tasks = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state IN ('done', 'merged') THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM tasks
      WHERE tenant_id = ? ${projectFilter} AND updated_at >= ?
    `).get(tenantId, ...projectParams, cutoff);

    const taskDoneRate = tasks.total > 0
      ? Math.round(tasks.done / tasks.total * 100)
      : 100;

    const score = Math.round(reviewPassRate * 0.5 + taskDoneRate * 0.5);

    return {
      score,
      reviewPassRate,
      taskDoneRate,
      totalReviews: reviews.total,
      blockedReviews: reviews.blocked,
      totalTasks: tasks.total,
      doneTasks: tasks.done,
    };
  })();

  // ── A: Activity（生产活动量）
  const activityMetrics = (() => {
    // 完成任务数
    const doneTasks = db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE tenant_id = ? ${projectFilter} AND state IN ('done','merged') AND updated_at >= ?
    `).get(tenantId, ...projectParams, cutoff).c;

    // PR 数（合并 + open）
    const prs = db.prepare(`
      SELECT COUNT(*) as c FROM pulls
      WHERE tenant_id = ? ${projectFilter} AND created_at >= ?
    `).get(tenantId, ...projectParams, cutoff).c;

    // standup 总数（活跃度代理）
    const standups = db.prepare(`
      SELECT COUNT(*) as c FROM standups
      WHERE tenant_id = ? AND date >= ?
    `).get(tenantId, cutoff.slice(0, 10)).c;

    // 活跃 actor 数（过去窗口期内有任务产出的）
    const activeActors = db.prepare(`
      SELECT COUNT(DISTINCT actor_id) as c FROM tasks
      WHERE tenant_id = ? ${projectFilter} AND actor_id IS NOT NULL AND updated_at >= ?
    `).get(tenantId, ...projectParams, cutoff).c;

    // 活动分（相对分，有数据就高分）
    const rawScore = Math.min(100,
      (doneTasks > 0 ? 30 : 0) +
      (prs > 0 ? 20 : 0) +
      (standups > 0 ? 20 : 0) +
      (activeActors > 0 ? 30 : 0)
    );

    return {
      score: rawScore,
      doneTasks,
      pullRequests: prs,
      standups,
      activeActors,
    };
  })();

  // ── C: Communication（协作效率代理：review 覆盖率 + standup 参与率）
  const communicationMetrics = (() => {
    // 有 review 的 PR 比例
    const totalPRs = db.prepare(`
      SELECT COUNT(*) as c FROM pulls
      WHERE tenant_id = ? ${projectFilter} AND created_at >= ?
    `).get(tenantId, ...projectParams, cutoff).c;

    const reviewedPRs = db.prepare(`
      SELECT COUNT(DISTINCT pull_id) as c FROM reviews
      WHERE tenant_id = ? AND pull_id IS NOT NULL AND created_at >= ?
    `).get(tenantId, cutoff).c;

    const reviewCoverage = totalPRs > 0
      ? Math.round(Math.min(reviewedPRs, totalPRs) / totalPRs * 100)
      : 100;

    // 有 blockers 被解决的比例（代理 communication 质量）
    // 近似：standup 提到 blockers → 如果后续任务仍推进，认为 blocker 被解决
    const score = Math.round(reviewCoverage * 0.8 + 20); // 基础分 20

    return {
      score: Math.min(100, score),
      reviewCoverage,
      totalPRs,
      reviewedPRs,
    };
  })();

  // ── E: Efficiency（流动效率：WIP 数 + 任务平均 in_progress 时长）
  const efficiencyMetrics = (() => {
    // WIP（in_progress + claimed 任务数）
    const wip = db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE tenant_id = ? ${projectFilter} AND state IN ('in_progress', 'claimed')
    `).get(tenantId, ...projectParams).c;

    // 长期 in_progress 任务（超过 7 天未更新）
    const longRunning = db.prepare(`
      SELECT COUNT(*) as c FROM tasks
      WHERE tenant_id = ? ${projectFilter}
        AND state = 'in_progress'
        AND updated_at <= datetime('now', '-7 days')
    `).get(tenantId, ...projectParams).c;

    // WIP 限制：<=5 满分，每多 1 扣 5 分
    const wipScore = Math.max(0, 100 - Math.max(0, wip - 5) * 5);
    // 长期卡住惩罚
    const penalty = longRunning * 15;

    return {
      score: Math.max(0, Math.round(wipScore - penalty)),
      wip,
      longRunning,
    };
  })();

  // ── 综合 SPACE 分（等权重）
  const overallScore = Math.round(
    (satisfactionMetrics.score + performanceMetrics.score + activityMetrics.score +
     communicationMetrics.score + efficiencyMetrics.score) / 5
  );

  return {
    score: overallScore,
    grade: overallScore >= 75 ? '🟢 健康' : overallScore >= 50 ? '🟡 关注' : '🔴 告警',
    windowDays,
    since: cutoff,
    projectId: projectId || null,
    dimensions: {
      satisfaction:    satisfactionMetrics,
      performance:     performanceMetrics,
      activity:        activityMetrics,
      communication:   communicationMetrics,
      efficiency:      efficiencyMetrics,
    },
    computedAt: new Date().toISOString(),
  };
}

/**
 * 按成员维度计算贡献（用于个人 SPACE 报告）
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.projectId]
 * @param {number} [params.windowDays]
 * @returns {object[]} perActorStats
 */
export function computePerActorStats({ tenantId, projectId, windowDays = DEFAULT_WINDOW_DAYS }) {
  const db = getDb();
  const cutoff = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const projectFilter = projectId ? ' AND t.project_id = ?' : '';
  const projectParams = projectId ? [projectId] : [];

  const actors = db.prepare(`
    SELECT a.id, a.display_name, a.type,
      COUNT(t.id) as total_tasks,
      SUM(CASE WHEN t.state IN ('done','merged') THEN 1 ELSE 0 END) as done_tasks,
      SUM(CASE WHEN t.state IN ('in_progress','claimed') THEN 1 ELSE 0 END) as active_tasks,
      SUM(CASE WHEN t.state = 'cancelled' THEN 1 ELSE 0 END) as cancelled_tasks
    FROM actors a
    LEFT JOIN tasks t ON a.id = t.actor_id AND t.tenant_id = ? ${projectFilter} AND t.updated_at >= ?
    WHERE a.tenant_id = ? AND a.active = 1
    GROUP BY a.id
    ORDER BY done_tasks DESC
  `).all(tenantId, ...projectParams, cutoff, tenantId);

  return actors.map(a => ({
    actorId:      a.id,
    displayName:  a.display_name,
    type:         a.type,
    totalTasks:   a.total_tasks,
    doneTasks:    a.done_tasks,
    activeTasks:  a.active_tasks,
    cancelledTasks: a.cancelled_tasks,
    completionRate: a.total_tasks > 0
      ? Math.round(a.done_tasks / a.total_tasks * 100)
      : 0,
  }));
}
