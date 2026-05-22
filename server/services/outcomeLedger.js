// server/services/outcomeLedger.js
// W9: Outcome Ledger — AI 行为结果记录与分析
//
// 职责：
//   1. recordOutcome        — 记录单条 AI 行为结果（幂等）
//   2. autoLabel            — 规则引擎自动打标（基于 reviews/tasks 状态）
//   3. queryOutcomes        — 带过滤/分页查询
//   4. computeStats         — 聚合统计（按 action_type / actor / 时间窗口）
//   5. batchAutoLabel       — 批量扫描新完成的 agent action，自动打标
//
// 设计约定：
//   - polarity: +1 = 成功/正向, -1 = 失败/负向, 0 = 中性/需人工
//   - observer: 'auto-rule' | 'human-label' | 'agent-self'
//   - action_ref_id: 关联的 taskId / reviewId / pullId 等

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import logger from '../logger.js';


// ══════════════════════════════════════════════════════════════
// 1. 记录单条 Outcome
// ══════════════════════════════════════════════════════════════

/**
 * 记录一条 AI 行为结果
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.actionType   - 'task.dispatch' | 'code.review' | 'pr.description' | 'standup' | 'recommend' | 'rag.ingest'
 * @param {string} params.actionRefId  - 关联的实体 ID（taskId / reviewId / pullId）
 * @param {string} params.outcomeSignal - 人类可读的结果描述
 * @param {number} params.polarity      - +1 / -1 / 0
 * @param {object} [params.evidence]   - 结构化证据（自由格式）
 * @param {string} [params.observer]   - 打标来源 'auto-rule' | 'human-label' | 'agent-self'
 * @param {number} [params.lagHours]   - 从行为到观测结果的时间差（小时）
 * @returns {Promise<number>} 新记录的 id
 */
export async function recordOutcome({
  tenantId,
  actionType,
  actionRefId,
  outcomeSignal,
  polarity,
  evidence = null,
  observer = 'auto-rule',
  lagHours = null,
}) {
  if (!['+1', '-1', '0', 1, -1, 0].includes(polarity)) {
    throw new Error(`invalid polarity: ${polarity} (must be +1/-1/0)`);
  }
  const polarityInt = Number(polarity);

  return dbWrite('outcome:record', (db) => {
    const result = db.prepare(`
      INSERT INTO ai_outcomes
        (tenant_id, action_type, action_ref_id, outcome_signal, polarity, evidence_json, observer, observation_lag_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId, actionType, actionRefId, outcomeSignal,
      polarityInt,
      evidence ? JSON.stringify(evidence) : null,
      observer, lagHours
    );
    return result.lastInsertRowid;
  });
}

// ══════════════════════════════════════════════════════════════
// 2. 规则自动打标
// ══════════════════════════════════════════════════════════════

/**
 * 为已完成的 agent task 自动打标
 * 规则：
 *   - task.state = 'done'  → polarity = +1
 *   - task.state = 'cancelled' → polarity = -1
 *   - review.level = 'Pass' → polarity = +1
 *   - review.level = 'Block' → polarity = -1
 *   - review.level = 'Warning' → polarity = 0
 */
export async function autoLabelTaskOutcome({ tenantId, taskId }) {
  const db = getDb();

  const task = db.prepare(`
    SELECT t.*, a.type as actor_type, a.display_name as actor_name
    FROM tasks t
    LEFT JOIN actors a ON t.actor_id = a.id
    WHERE t.id = ? AND t.tenant_id = ?
  `).get(taskId, tenantId);

  if (!task) throw new Error(`task ${taskId} not found`);
  if (!task.actor_id) return null; // 未分配，跳过

  // 最新 agent review
  const latestReview = db.prepare(`
    SELECT * FROM reviews
    WHERE tenant_id = ? AND task_id = ? AND source IN ('agent', 'map-reduce')
    ORDER BY created_at DESC LIMIT 1
  `).get(tenantId, taskId);

  let polarity = 0;
  let signal = '';
  const evidence = {
    taskState: task.state,
    actorType: task.actor_type,
    reviewLevel: latestReview?.level || null,
    progress: task.progress,
  };

  if (task.state === 'done' || task.state === 'merged') {
    polarity = 1;
    signal = latestReview?.level === 'Pass'
      ? `任务完成，审阅通过 (${latestReview.level})`
      : '任务已完成';
  } else if (task.state === 'cancelled') {
    polarity = -1;
    signal = '任务被取消';
  } else if (task.state === 'in_review' && latestReview) {
    if (latestReview.level === 'Block') {
      polarity = -1;
      signal = `审阅拦截 (${latestReview.level})`;
    } else if (latestReview.level === 'Warning') {
      polarity = 0;
      signal = `审阅警告，需关注 (${latestReview.level})`;
    } else if (latestReview.level === 'Pass') {
      polarity = 1;
      signal = `审阅通过 (${latestReview.level})`;
    }
  } else {
    return null; // 状态未终结，暂不打标
  }

  // 计算 lag（从任务创建到现在）
  const lagHours = task.created_at
    ? Math.round((Date.now() - new Date(task.created_at).getTime()) / 3600000)
    : null;

  return recordOutcome({
    tenantId,
    actionType: 'task.dispatch',
    actionRefId: taskId,
    outcomeSignal: signal,
    polarity,
    evidence,
    observer: 'auto-rule',
    lagHours,
  });
}

/**
 * 为代码审阅自动打标
 */
export async function autoLabelReviewOutcome({ tenantId, reviewId }) {
  const db = getDb();

  const review = db.prepare(`
    SELECT * FROM reviews WHERE id = ? AND tenant_id = ?
  `).get(reviewId, tenantId);

  if (!review) throw new Error(`review ${reviewId} not found`);

  const levelMap = { Pass: 1, Warning: 0, Block: -1, Escalate: 0 };
  const polarity = levelMap[review.level] ?? 0;
  const signal = `代码审阅 ${review.level}（${review.source}）`;

  const lagHours = review.created_at
    ? Math.round((Date.now() - new Date(review.created_at).getTime()) / 3600000)
    : null;

  return recordOutcome({
    tenantId,
    actionType: 'code.review',
    actionRefId: reviewId,
    outcomeSignal: signal,
    polarity,
    evidence: {
      level: review.level,
      source: review.source,
      taskId: review.task_id,
      pullId: review.pull_id,
    },
    observer: 'auto-rule',
    lagHours,
  });
}

// ══════════════════════════════════════════════════════════════
// 3. 查询 Outcomes
// ══════════════════════════════════════════════════════════════

/**
 * 带过滤/分页的 outcome 查询
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.actionType]  - 过滤 action_type
 * @param {number} [params.polarity]    - +1/-1/0 过滤
 * @param {string} [params.observer]    - 过滤 observer
 * @param {string} [params.since]       - ISO datetime，仅返回此后记录
 * @param {number} [params.limit=50]
 * @param {number} [params.offset=0]
 * @returns {{ outcomes: object[], total: number }}
 */
export function queryOutcomes({
  tenantId,
  actionType,
  polarity,
  observer,
  since,
  limit = 50,
  offset = 0,
}) {
  const db = getDb();

  let q = 'SELECT * FROM ai_outcomes WHERE tenant_id = ?';
  const params = [tenantId];

  if (actionType) { q += ' AND action_type = ?'; params.push(actionType); }
  if (polarity !== undefined && polarity !== null) { q += ' AND polarity = ?'; params.push(Number(polarity)); }
  if (observer) { q += ' AND observer = ?'; params.push(observer); }
  if (since) { q += ' AND observed_at >= ?'; params.push(since); }

  const countQ = q.replace('SELECT *', 'SELECT COUNT(*) as c');
  const total = db.prepare(countQ).get(...params).c;

  q += ' ORDER BY observed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const outcomes = db.prepare(q).all(...params).map(row => ({
    ...row,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
  }));

  return { outcomes, total };
}

// ══════════════════════════════════════════════════════════════
// 4. 聚合统计
// ══════════════════════════════════════════════════════════════

/**
 * 按 action_type 统计各极性分布
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.since]   - ISO datetime，仅统计此后
 * @param {string} [params.actionType]
 * @returns {object} stats
 */
export function computeStats({ tenantId, since, actionType }) {
  const db = getDb();

  let q = `
    SELECT
      action_type,
      COUNT(*) as total,
      SUM(CASE WHEN polarity = 1  THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN polarity = -1 THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN polarity = 0  THEN 1 ELSE 0 END) as neutral,
      AVG(observation_lag_hours) as avg_lag_hours
    FROM ai_outcomes
    WHERE tenant_id = ?
  `;
  const params = [tenantId];

  if (since)      { q += ' AND observed_at >= ?';  params.push(since); }
  if (actionType) { q += ' AND action_type = ?';   params.push(actionType); }

  q += ' GROUP BY action_type ORDER BY total DESC';

  const byType = db.prepare(q).all(...params).map(row => ({
    actionType: row.action_type,
    total: row.total,
    positive: row.positive,
    negative: row.negative,
    neutral: row.neutral,
    successRate: row.total > 0 ? Math.round((row.positive / row.total) * 100) : 0,
    avgLagHours: row.avg_lag_hours ? Math.round(row.avg_lag_hours) : null,
  }));

  const grand = byType.reduce(
    (acc, r) => ({
      total: acc.total + r.total,
      positive: acc.positive + r.positive,
      negative: acc.negative + r.negative,
      neutral: acc.neutral + r.neutral,
    }),
    { total: 0, positive: 0, negative: 0, neutral: 0 }
  );

  return {
    byType,
    grand: {
      ...grand,
      successRate: grand.total > 0 ? Math.round((grand.positive / grand.total) * 100) : 0,
    },
    since: since || null,
  };
}

// ══════════════════════════════════════════════════════════════
// 5. 批量自动打标（扫描器）
// ══════════════════════════════════════════════════════════════

/**
 * 扫描近期已完成/失败的任务和审阅，自动打标未标记的条目
 * 用于定时任务或手动触发
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.since]      - ISO datetime，默认最近 7 天
 * @returns {{ tasksLabeled: number, reviewsLabeled: number }}
 */
export async function batchAutoLabel({ tenantId, since }) {
  const db = getDb();
  const cutoff = since || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // 已完结但未打标的 agent tasks
  const labeledTaskIds = new Set(
    db.prepare(`
      SELECT action_ref_id FROM ai_outcomes
      WHERE tenant_id = ? AND action_type = 'task.dispatch'
    `).all(tenantId).map(r => r.action_ref_id)
  );

  const candidateTasks = db.prepare(`
    SELECT t.id FROM tasks t
    JOIN actors a ON t.actor_id = a.id AND a.type = 'ai-agent'
    WHERE t.tenant_id = ?
      AND t.state IN ('done', 'merged', 'cancelled', 'in_review')
      AND t.updated_at >= ?
  `).all(tenantId, cutoff);

  let tasksLabeled = 0;
  for (const { id } of candidateTasks) {
    if (labeledTaskIds.has(id)) continue;
    try {
      const result = await autoLabelTaskOutcome({ tenantId, taskId: id });
      if (result !== null) tasksLabeled++;
    } catch (err) {
      logger.warn(`[outcomeLedger] autoLabel task ${id}: ${err.message}`);
    }
  }

  // 未打标的审阅
  const labeledReviewIds = new Set(
    db.prepare(`
      SELECT action_ref_id FROM ai_outcomes
      WHERE tenant_id = ? AND action_type = 'code.review'
    `).all(tenantId).map(r => r.action_ref_id)
  );

  const candidateReviews = db.prepare(`
    SELECT id FROM reviews
    WHERE tenant_id = ? AND source IN ('agent', 'map-reduce')
      AND created_at >= ?
  `).all(tenantId, cutoff);

  let reviewsLabeled = 0;
  for (const { id } of candidateReviews) {
    if (labeledReviewIds.has(id)) continue;
    try {
      await autoLabelReviewOutcome({ tenantId, reviewId: id });
      reviewsLabeled++;
    } catch (err) {
      logger.warn(`[outcomeLedger] autoLabel review ${id}: ${err.message}`);
    }
  }

  logger.info(`[outcomeLedger] batchAutoLabel: ${tasksLabeled} tasks + ${reviewsLabeled} reviews labeled`);
  return { tasksLabeled, reviewsLabeled };
}
