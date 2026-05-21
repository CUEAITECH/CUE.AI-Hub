// server/services/observability.js
// W10: 可观测性面板 — 系统健康度聚合
//
// 提供统一的健康度视图，供 Dashboard 和运维告警使用
// 不依赖 LLM，纯规则计算（快速、可靠）
//
// 健康度维度：
//   - agent:    agent 成功率、负载、卡住任务数
//   - pipeline: PR 到合并延迟、review pass 率
//   - learning: outcome 打标率、queue 积压
//   - sync:     doc 写回成功率、PR-task 链接覆盖率

import { getDb } from '../db/index.js';

/**
 * 计算系统整体健康度（0-100）
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.since]  - ISO datetime，默认最近 24 小时
 * @returns {object} healthReport
 */
export function computeHealth({ tenantId, since }) {
  const db = getDb();
  const cutoff = since || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // ── Agent 健康度 ─────────────────────────────────────────
  const agentMetrics = (() => {
    // 活跃 agent 数
    const activeAgents = db.prepare(`
      SELECT COUNT(*) as c FROM actors
      WHERE tenant_id = ? AND type = 'ai-agent' AND active = 1
    `).get(tenantId).c;

    // 卡住任务（in_progress 超过 48 小时）
    const stuckTasks = db.prepare(`
      SELECT COUNT(*) as c FROM tasks t
      JOIN actors a ON t.actor_id = a.id
      WHERE t.tenant_id = ? AND a.type = 'ai-agent'
        AND t.state = 'in_progress'
        AND t.updated_at <= datetime('now', '-48 hours')
    `).get(tenantId).c;

    // agent 任务成功率（过去 7 天 done/total）
    const agentTasks = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state IN ('done', 'merged') THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM tasks t
      JOIN actors a ON t.actor_id = a.id
      WHERE t.tenant_id = ? AND a.type = 'ai-agent'
        AND t.updated_at >= ?
    `).get(tenantId, weekCutoff);

    const successRate = agentTasks.total > 0
      ? Math.round(agentTasks.done / agentTasks.total * 100)
      : 100; // 无数据时默认满分

    // 健康分：基础 40 + 成功率 40 - stuck 惩罚 - 无 agent 惩罚
    const score = Math.max(0, Math.min(100,
      (activeAgents > 0 ? 40 : 0) +
      successRate * 0.4 -
      stuckTasks * 10
    ));

    return {
      score: Math.round(score),
      activeAgents,
      stuckTasks,
      successRate,
      totalTasks: agentTasks.total,
      doneTasks: agentTasks.done,
    };
  })();

  // ── Pipeline 健康度 ──────────────────────────────────────
  const pipelineMetrics = (() => {
    // 审阅通过率（最近 7 天）
    const reviews = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN level = 'Pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN level = 'Block' THEN 1 ELSE 0 END) as blocked
      FROM reviews
      WHERE tenant_id = ? AND created_at >= ?
    `).get(tenantId, weekCutoff);

    const reviewPassRate = reviews.total > 0
      ? Math.round(reviews.passed / reviews.total * 100)
      : 100;

    // 未合并的 open PR 数
    const openPRs = db.prepare(`
      SELECT COUNT(*) as c FROM pulls
      WHERE tenant_id = ? AND state = 'open'
    `).get(tenantId).c;

    const score = Math.max(0, Math.min(100,
      reviewPassRate * 0.7 +
      (openPRs <= 5 ? 30 : Math.max(0, 30 - (openPRs - 5) * 3))
    ));

    return {
      score: Math.round(score),
      reviewPassRate,
      totalReviews: reviews.total,
      blockedReviews: reviews.blocked,
      openPRs,
    };
  })();

  // ── Learning 健康度 ──────────────────────────────────────
  const learningMetrics = (() => {
    // outcome 总数（过去 7 天）
    const outcomes = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN polarity = 1  THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN polarity = -1 THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN polarity = 0  THEN 1 ELSE 0 END) as neutral
      FROM ai_outcomes
      WHERE tenant_id = ? AND observed_at >= ?
    `).get(tenantId, weekCutoff);

    // 检查 learning_queue 表是否存在
    const queueTableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='learning_queue'
    `).get();

    let pendingQueue = 0;
    if (queueTableExists) {
      pendingQueue = db.prepare(`
        SELECT COUNT(*) as c FROM learning_queue
        WHERE tenant_id = ? AND status = 'pending'
      `).get(tenantId).c;
    }

    const successRate = outcomes.total > 0
      ? Math.round(outcomes.positive / outcomes.total * 100)
      : 100; // 无历史数据 → 新系统默认健康（不触发 critical 告警）

    const score = Math.max(0, Math.min(100,
      successRate * 0.6 +
      (outcomes.total > 0 ? 25 : 10) -  // 有数据加分
      Math.min(15, pendingQueue * 2)      // queue 积压惩罚
    ));

    return {
      score: Math.round(score),
      successRate,
      totalOutcomes: outcomes.total,
      positiveOutcomes: outcomes.positive,
      negativeOutcomes: outcomes.negative,
      pendingQueue,
    };
  })();

  // ── Sync 健康度 ──────────────────────────────────────────
  const syncMetrics = (() => {
    // PR-Task 链接覆盖率
    const totalPRs = db.prepare(`
      SELECT COUNT(*) as c FROM pulls WHERE tenant_id = ?
    `).get(tenantId).c;

    const linkedPRs = db.prepare(`
      SELECT COUNT(DISTINCT ptl.pull_id) as c
      FROM pull_task_links ptl
      JOIN pulls p ON ptl.pull_id = p.id AND p.tenant_id = ?
    `).get(tenantId).c;

    const linkCoverage = totalPRs > 0
      ? Math.round(linkedPRs / totalPRs * 100)
      : 100; // 无 PR 时满分

    const score = Math.round(linkCoverage * 0.8 + 20); // 基础 20 + 覆盖率

    return {
      score: Math.min(100, score),
      linkCoverage,
      totalPRs,
      linkedPRs,
    };
  })();

  // ── 综合评分 ────────────────────────────────────────────
  // 权重：agent 40%、pipeline 30%、learning 20%、sync 10%
  const overallScore = Math.round(
    agentMetrics.score * 0.40 +
    pipelineMetrics.score * 0.30 +
    learningMetrics.score * 0.20 +
    syncMetrics.score * 0.10
  );

  // 风险告警
  const alerts = [];
  if (agentMetrics.stuckTasks > 0) {
    alerts.push({ severity: 'warning', component: 'agent', message: `${agentMetrics.stuckTasks} 个任务卡住超过 48 小时` });
  }
  if (agentMetrics.activeAgents === 0) {
    alerts.push({ severity: 'info', component: 'agent', message: '当前无活跃 AI Agent' });
  }
  if (pipelineMetrics.blockedReviews > 3) {
    alerts.push({ severity: 'warning', component: 'pipeline', message: `${pipelineMetrics.blockedReviews} 个审阅被 Block` });
  }
  if (learningMetrics.successRate < 60 && learningMetrics.totalOutcomes > 5) {
    alerts.push({ severity: 'critical', component: 'learning', message: `AI 成功率仅 ${learningMetrics.successRate}%，低于警戒线` });
  }
  if (syncMetrics.linkCoverage < 50 && syncMetrics.totalPRs > 3) {
    alerts.push({ severity: 'warning', component: 'sync', message: `PR-Task 链接覆盖率仅 ${syncMetrics.linkCoverage}%` });
  }

  return {
    score: overallScore,
    grade: overallScore >= 80 ? '🟢 健康' : overallScore >= 60 ? '🟡 关注' : '🔴 告警',
    since: cutoff,
    components: {
      agent:    agentMetrics,
      pipeline: pipelineMetrics,
      learning: learningMetrics,
      sync:     syncMetrics,
    },
    alerts,
    computedAt: new Date().toISOString(),
  };
}
