// server/services/spaceMetrics.js
// W11: SPACE 健康指标引擎
//
// SPACE Framework（DevEx 研究，Forsgren 等 2021）：
//   S — Satisfaction & Well-being：团队满意度（blockers 情感分析）
//   P — Performance：交付质量（review pass 率、done 率）
//   A — Activity：生产活动量（commits、PR、任务完成数）
//   C — Communication & Collaboration：协作效率（PR review 响应时间）
//   E — Efficiency & Flow：流动效率（PR 合并周期、任务 WIP）
//
// 设计原则：
//   - 无 LLM 依赖：纯数据库查询 + 规则情感分析
//   - 多粒度：项目级 / 成员级 / 全租户
//   - 时间窗口：默认 14 天，可自定义

import { getDb } from '../db/index.js';

// ── 情感分析工具（规则词典，Part G Layer 3）───────────────────
// 参考：SentiStrength 负向词表（Thelwall 2010）的核心高频词
// 无需外部 API，本地纯规则，支持中英文混合
const NEGATIVE_PATTERNS = [
  // 阻塞/问题类
  /\b(block(ed|ing)?|stuck|blocked|blocker|阻塞|卡住|卡了|卡死)\b/i,
  /\b(issue|bug|error|crash|fail(ed|ing)?|failure|问题|报错|崩了|挂了)\b/i,
  /\b(依赖|等待|等人|等审批|waiting|depend(ing)?|pending)\b/i,
  // 延迟/压力类
  /\b(delay(ed)?|late|behind|overdue|超期|延期|延误|来不及|赶不上)\b/i,
  /\b(pressure|urgent|紧急|压力|加班|熬夜|deadline)\b/i,
  // 负面情绪类
  /\b(confus(ed|ing)|unclear|不清楚|不确定|不知道|没头绪|懵了)\b/i,
  /\b(frustrat(ed|ing)|stuck|困住|难搞|搞不定|解决不了)\b/i,
];

const NEUTRAL_PATTERNS = [
  // 表示"无阻塞"的中性/正向模式
  /^(无|没有|没|none|n\/a|na|null|-)$/i,
  /^(无阻塞|无问题|没问题|ok|好的|正常|顺利)$/i,
];

const POSITIVE_PATTERNS = [
  /\b(完成|搞定|done|finished|merged|合并|通过|pass(ed)?)\b/i,
  /\b(顺利|进展顺利|no blocker|no issue|all good|👍|✅)\b/i,
];

/**
 * 对 standup blockers 文本做情感分析
 * @param {string} text  - blockers 字段内容
 * @returns {{ polarity: number, score: number }}
 *   polarity: -1（负面）/ 0（中性）/ +1（正面）
 *   score: 情感分 0-100（越高越积极）
 */
function analyzeSentiment(text) {
  if (!text || typeof text !== 'string') return { polarity: 0, score: 50 };
  const t = text.trim();

  // 明确中性/正向表达
  if (NEUTRAL_PATTERNS.some(p => p.test(t))) return { polarity: 0, score: 70 };
  if (POSITIVE_PATTERNS.some(p => p.test(t))) return { polarity: 1, score: 90 };

  // 统计负向词命中次数
  const negHits = NEGATIVE_PATTERNS.filter(p => p.test(t)).length;

  if (negHits === 0) return { polarity: 0, score: 65 };
  if (negHits === 1) return { polarity: -1, score: 35 };
  return { polarity: -1, score: Math.max(5, 30 - (negHits - 1) * 8) };
}

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

  // ── S: Satisfaction（情感分析：blockers 文本极性）─────────
  // 升级自纯"有无 blockers"的二元计数，改为对 blockers 文本做情感打分
  // 方法：规则词典（SentiStrength 核心词表，Thelwall 2010），支持中英文
  const satisfactionMetrics = (() => {
    const standups = db.prepare(`
      SELECT blockers FROM standups
      WHERE tenant_id = ? AND date >= ?
    `).all(tenantId, cutoff.slice(0, 10));

    if (standups.length === 0) {
      return { score: 70, standups: 0, avgSentiment: 0.7,
               negativeCount: 0, neutralCount: 0, positiveCount: 0, method: 'sentiment' };
    }

    // 对每条 standup 做情感分析
    let sumScore = 0;
    let negCount = 0, neuCount = 0, posCount = 0;

    for (const row of standups) {
      const { polarity, score } = analyzeSentiment(row.blockers);
      sumScore += score;
      if (polarity < 0) negCount++;
      else if (polarity > 0) posCount++;
      else neuCount++;
    }

    const avgSentimentScore = Math.round(sumScore / standups.length);

    return {
      score:         avgSentimentScore,
      standups:      standups.length,
      avgSentiment:  parseFloat((avgSentimentScore / 100).toFixed(2)),
      negativeCount: negCount,
      neutralCount:  neuCount,
      positiveCount: posCount,
      method:        'sentiment-analysis',  // 标记分析方法，便于前端展示
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
