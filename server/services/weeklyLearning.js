// server/services/weeklyLearning.js
// W13: 周度学习批处理 — AI 行为数据聚合 + 改进建议生成
//
// 职责：
//   1. aggregateWeeklyOutcomes — 聚合本周 AI 行为数据
//   2. generateInsights        — 基于聚合数据生成改进建议（LLM 优先，规则降级）
//   3. persistWeeklyReport     — 持久化周报（learning_reports 表）
//   4. runWeeklyBatch          — 完整批处理 pipeline
//   5. queryReports            — 查询历史周报
//
// 设计约定：
//   - 固定时间窗口：ISO 周（周一~周日）
//   - LLM 生成 insights 时使用 LLM_DRY_RUN 友好的降级路径
//   - 幂等：同一周的报告可以重新生成（覆盖更新）

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import { callClaude } from './claude.js';
import { computeSpaceMetrics } from './spaceMetrics.js';

// ══════════════════════════════════════════════════════════════
// 表初始化
// ══════════════════════════════════════════════════════════════

export function ensureLearningReportsTable() {
  const db = getDb();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS learning_reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      week_start   TEXT NOT NULL,   -- ISO date (YYYY-MM-DD, Monday)
      week_end     TEXT NOT NULL,   -- ISO date (Sunday)
      metrics_json TEXT NOT NULL,   -- 聚合指标快照
      insights_json TEXT NOT NULL,  -- 生成的改进建议
      space_json   TEXT,            -- SPACE 指标快照
      generated_by TEXT DEFAULT 'auto',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, week_start)
    )
  `).run();
}

// ══════════════════════════════════════════════════════════════
// 周边界工具
// ══════════════════════════════════════════════════════════════

/** 使用本地时区格式化日期（避免 toISOString 的 UTC 偏移导致跨日） */
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 计算 ISO 周的起止日期（周一~周日）
 * @param {Date|string} [refDate] - 参考日期（默认上周）
 * @returns {{ weekStart: string, weekEnd: string }}
 */
export function getISOWeekBounds(refDate) {
  const d = refDate ? new Date(refDate) : new Date();
  // 上周（默认）
  d.setDate(d.getDate() - 7);

  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return {
    weekStart: localDateStr(monday),
    weekEnd:   localDateStr(sunday),
  };
}

/**
 * 计算任意日期所在 ISO 周的起止（不默认上周）
 */
export function getWeekBoundsForDate(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    weekStart: localDateStr(monday),
    weekEnd:   localDateStr(sunday),
  };
}

// ══════════════════════════════════════════════════════════════
// 1. 聚合周度 Outcome 数据
// ══════════════════════════════════════════════════════════════

/**
 * 聚合指定周内的 AI 行为结果数据
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.weekStart  - YYYY-MM-DD（周一）
 * @param {string} params.weekEnd    - YYYY-MM-DD（周日）
 * @returns {object} weeklyMetrics
 */
export function aggregateWeeklyOutcomes({ tenantId, weekStart, weekEnd }) {
  const db = getDb();
  const since = `${weekStart}T00:00:00.000Z`;
  const until = `${weekEnd}T23:59:59.999Z`;

  // ── Outcome 分布 ─────────────────────────────────────────
  const outcomeStats = db.prepare(`
    SELECT
      action_type,
      COUNT(*) as total,
      SUM(CASE WHEN polarity = 1  THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN polarity = -1 THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN polarity = 0  THEN 1 ELSE 0 END) as neutral,
      AVG(observation_lag_hours) as avg_lag_hours
    FROM ai_outcomes
    WHERE tenant_id = ? AND observed_at >= ? AND observed_at <= ?
    GROUP BY action_type
    ORDER BY total DESC
  `).all(tenantId, since, until);

  const outcomeGrand = outcomeStats.reduce(
    (acc, r) => ({
      total:    acc.total + r.total,
      positive: acc.positive + r.positive,
      negative: acc.negative + r.negative,
      neutral:  acc.neutral + r.neutral,
    }),
    { total: 0, positive: 0, negative: 0, neutral: 0 }
  );

  // ── 任务完成情况 ──────────────────────────────────────────
  const taskStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN state IN ('done','merged') THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN state = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN state = 'in_progress' THEN 1 ELSE 0 END) as in_progress
    FROM tasks
    WHERE tenant_id = ? AND updated_at >= ? AND updated_at <= ?
  `).get(tenantId, since, until);

  // ── 审阅质量 ─────────────────────────────────────────────
  const reviewStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN level = 'Pass' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN level = 'Block' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN level = 'Warning' THEN 1 ELSE 0 END) as warned
    FROM reviews
    WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
  `).get(tenantId, since, until);

  // ── Learning Queue ────────────────────────────────────────
  const queueTableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='learning_queue'
  `).get();

  let queueStats = { labeled: 0, dismissed: 0, pending: 0 };
  if (queueTableExists) {
    const rows = db.prepare(`
      SELECT status, COUNT(*) as c FROM learning_queue
      WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?
      GROUP BY status
    `).all(tenantId, since, until);
    for (const r of rows) {
      queueStats[r.status] = r.c;
    }
  }

  // ── 最活跃/成功率最高的 actor ─────────────────────────────
  const topActors = db.prepare(`
    SELECT
      t.actor_id,
      a.display_name,
      a.type,
      COUNT(*) as tasks,
      SUM(CASE WHEN t.state IN ('done','merged') THEN 1 ELSE 0 END) as done
    FROM tasks t
    JOIN actors a ON t.actor_id = a.id
    WHERE t.tenant_id = ? AND t.updated_at >= ? AND t.updated_at <= ?
      AND t.actor_id IS NOT NULL
    GROUP BY t.actor_id
    ORDER BY done DESC, tasks DESC
    LIMIT 5
  `).all(tenantId, since, until);

  return {
    weekStart,
    weekEnd,
    outcomes: {
      byType: outcomeStats.map(r => ({
        actionType:   r.action_type,
        total:        r.total,
        positive:     r.positive,
        negative:     r.negative,
        neutral:      r.neutral,
        successRate:  r.total > 0 ? Math.round(r.positive / r.total * 100) : 0,
        avgLagHours:  r.avg_lag_hours ? Math.round(r.avg_lag_hours) : null,
      })),
      grand: {
        ...outcomeGrand,
        successRate: outcomeGrand.total > 0
          ? Math.round(outcomeGrand.positive / outcomeGrand.total * 100)
          : null,
      },
    },
    tasks: {
      total:      taskStats.total,
      done:       taskStats.done,
      cancelled:  taskStats.cancelled,
      inProgress: taskStats.in_progress,
      completionRate: taskStats.total > 0
        ? Math.round(taskStats.done / taskStats.total * 100)
        : null,
    },
    reviews: {
      total:    reviewStats.total,
      passed:   reviewStats.passed,
      blocked:  reviewStats.blocked,
      warned:   reviewStats.warned,
      passRate: reviewStats.total > 0
        ? Math.round(reviewStats.passed / reviewStats.total * 100)
        : null,
    },
    learningQueue: queueStats,
    topActors: topActors.map(a => ({
      actorId:     a.actor_id,
      displayName: a.display_name,
      type:        a.type,
      tasks:       a.tasks,
      done:        a.done,
      successRate: a.tasks > 0 ? Math.round(a.done / a.tasks * 100) : 0,
    })),
  };
}

// ══════════════════════════════════════════════════════════════
// 2. 生成改进建议
// ══════════════════════════════════════════════════════════════

const INSIGHTS_SYSTEM_PROMPT = `你是 AI 团队效能分析师。基于本周 AI 行为数据，生成 3-5 条可操作的改进建议。

输出 JSON 数组：
[
  {
    "category": "quality|velocity|collaboration|learning|tooling",
    "priority": "high|medium|low",
    "insight": "问题描述（25-50 字）",
    "action": "建议行动（30-60 字，具体可执行）",
    "metric": "跟踪指标"
  }
]

要求：
- 基于数据，不要空泛建议
- 优先关注成功率低、负极性多的 action_type
- 关注 Block 审阅和卡住任务
- 如果数据量少（< 5 条 outcome），说明"数据不足以得出可靠结论"并给出数据收集建议`;

/**
 * 生成改进 insights（LLM 优先，规则降级）
 */
async function generateInsights(metrics) {
  const { outcomes, tasks, reviews } = metrics;

  const userPrompt = `本周数据摘要：
- Outcome 总数：${outcomes.grand.total}，成功率：${outcomes.grand.successRate ?? '暂无数据'}%
- 任务完成：${tasks.done}/${tasks.total}（完成率 ${tasks.completionRate ?? '暂无'}%），取消：${tasks.cancelled}
- 代码审阅：${reviews.total} 次，通过 ${reviews.passed}，Block ${reviews.blocked}，Warning ${reviews.warned}
- 各 action_type 分布：
${outcomes.byType.map(r => `  ${r.actionType}: 成功率 ${r.successRate}%（${r.positive}正/${r.negative}负/${r.neutral}中，共${r.total}）`).join('\n') || '  （本周无 outcome 数据）'}

请生成 3-5 条改进建议。`;

  try {
    const result = await callClaude(INSIGHTS_SYSTEM_PROMPT, userPrompt);
    if (!result) return ruleInsights(metrics);

    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return ruleInsights(metrics);

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) return ruleInsights(metrics);

    return { insights: parsed, source: 'llm' };
  } catch {
    return ruleInsights(metrics);
  }
}

/**
 * 规则降级 insights
 */
function ruleInsights(metrics) {
  const { outcomes, tasks, reviews } = metrics;
  const insights = [];

  // 数据不足
  if (outcomes.grand.total < 5) {
    insights.push({
      category: 'learning',
      priority: 'high',
      insight:  '本周 AI outcome 数据量不足（< 5 条），无法得出可靠改进方向',
      action:   '运行 POST /v2/outcomes/auto-label 收集更多自动打标数据；确保 agent 任务完成后触发打标',
      metric:   'ai_outcomes.total >= 5',
    });
    return { insights, source: 'rule' };
  }

  // 低成功率
  const successRate = outcomes.grand.successRate ?? 100;
  if (successRate < 70) {
    insights.push({
      category: 'quality',
      priority: 'high',
      insight:  `本周 AI 行为成功率仅 ${successRate}%，低于健康线（70%）`,
      action:   '检查失败 outcome 的 action_type；优先修复成功率最低的任务类型的 prompt 或验收标准',
      metric:   'ai_outcomes.successRate >= 70',
    });
  }

  // Block 审阅
  if (reviews.blocked > 2) {
    insights.push({
      category: 'quality',
      priority: reviews.blocked > 5 ? 'high' : 'medium',
      insight:  `本周有 ${reviews.blocked} 个 PR 被 Block 级审阅拦截`,
      action:   '分析 Block 审阅的共性问题；考虑在任务 acceptance 中增加对应检查项，减少 Block 比例',
      metric:   `reviews.blocked <= 2`,
    });
  }

  // 高取消率
  if (tasks.total > 0 && tasks.cancelled / tasks.total > 0.2) {
    insights.push({
      category: 'velocity',
      priority: 'medium',
      insight:  `本周任务取消率 ${Math.round(tasks.cancelled / tasks.total * 100)}%，高于正常水平（< 20%）`,
      action:   '排查被取消任务的共性原因；是否需求变更频繁，或 agent 能力不匹配，建议改进任务分配流程',
      metric:   'tasks.cancelRate < 20%',
    });
  }

  // 低 outcome 打标率
  if (outcomes.grand.neutral > outcomes.grand.positive && outcomes.grand.total > 0) {
    insights.push({
      category: 'learning',
      priority: 'medium',
      insight:  `中性（不确定）outcome 比例偏高（${outcomes.grand.neutral}/${outcomes.grand.total}）`,
      action:   '处理 active learning 队列中待人工标注的条目；更多的已标注数据有助于改进自动打标精度',
      metric:   'neutral outcomes < total * 0.3',
    });
  }

  // 良好：如果全都不错
  if (insights.length === 0) {
    insights.push({
      category: 'velocity',
      priority: 'low',
      insight:  `本周 AI 团队表现良好：成功率 ${successRate}%，完成 ${tasks.done} 个任务`,
      action:   '继续保持；考虑逐步提高 agent autonomy_level，减少人工介入频率',
      metric:   'maintain successRate >= 70%',
    });
  }

  return { insights, source: 'rule' };
}

// ══════════════════════════════════════════════════════════════
// 3. 持久化周报
// ══════════════════════════════════════════════════════════════

/**
 * 写入或覆盖周报记录（幂等）
 */
export async function persistWeeklyReport({ tenantId, weekStart, weekEnd, metrics, insights, space }) {
  ensureLearningReportsTable();

  return dbWrite('learning_report:persist', (db) => {
    const result = db.prepare(`
      INSERT INTO learning_reports
        (tenant_id, week_start, week_end, metrics_json, insights_json, space_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, week_start) DO UPDATE SET
        metrics_json  = excluded.metrics_json,
        insights_json = excluded.insights_json,
        space_json    = excluded.space_json,
        created_at    = excluded.created_at
    `).run(
      tenantId, weekStart, weekEnd,
      JSON.stringify(metrics),
      JSON.stringify(insights),
      space ? JSON.stringify(space) : null,
      new Date().toISOString()
    );
    return result.lastInsertRowid;
  });
}

// ══════════════════════════════════════════════════════════════
// 4. 完整批处理 pipeline
// ══════════════════════════════════════════════════════════════

/**
 * 运行周度学习批处理
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.weekStart]   - YYYY-MM-DD，默认上周周一
 * @param {string} [params.weekEnd]     - YYYY-MM-DD，默认上周周日
 * @returns {Promise<object>} report
 */
export async function runWeeklyBatch({ tenantId, weekStart, weekEnd }) {
  ensureLearningReportsTable();

  // 1. 确定周边界
  const bounds = weekStart ? { weekStart, weekEnd } : getISOWeekBounds();
  const { weekStart: ws, weekEnd: we } = bounds;

  console.log(`[weeklyLearning] running batch for ${ws} ~ ${we}`);

  // 2. 聚合数据
  const metrics = aggregateWeeklyOutcomes({ tenantId, weekStart: ws, weekEnd: we });

  // 3. 生成 insights
  const { insights, source } = await generateInsights(metrics);

  // 4. SPACE 指标快照（7 天窗口）
  const space = computeSpaceMetrics({ tenantId, windowDays: 7 });

  // 5. 持久化
  const reportId = await persistWeeklyReport({
    tenantId, weekStart: ws, weekEnd: we, metrics, insights, space,
  });

  console.log(`[weeklyLearning] report ${reportId} saved (insights source: ${source})`);

  return {
    reportId,
    weekStart: ws,
    weekEnd:   we,
    metrics,
    insights,
    insightSource: source,
    space: { score: space.score, grade: space.grade },
  };
}

// ══════════════════════════════════════════════════════════════
// 5. 查询历史周报
// ══════════════════════════════════════════════════════════════

/**
 * 查询历史周报列表
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {number} [params.limit=10]
 * @param {number} [params.offset=0]
 * @returns {{ reports: object[], total: number }}
 */
export function queryReports({ tenantId, limit = 10, offset = 0 }) {
  ensureLearningReportsTable();
  const db = getDb();

  const total = db.prepare('SELECT COUNT(*) as c FROM learning_reports WHERE tenant_id = ?').get(tenantId).c;

  const rows = db.prepare(`
    SELECT id, tenant_id, week_start, week_end, generated_by, created_at,
           metrics_json, insights_json
    FROM learning_reports
    WHERE tenant_id = ?
    ORDER BY week_start DESC
    LIMIT ? OFFSET ?
  `).all(tenantId, limit, offset);

  const reports = rows.map(r => ({
    id:          r.id,
    weekStart:   r.week_start,
    weekEnd:     r.week_end,
    generatedBy: r.generated_by,
    createdAt:   r.created_at,
    metrics:     JSON.parse(r.metrics_json),
    insights:    JSON.parse(r.insights_json),
  }));

  return { reports, total };
}

/**
 * 获取单条周报（含 SPACE 快照）
 */
export function getReport({ tenantId, reportId }) {
  ensureLearningReportsTable();
  const db = getDb();

  const row = db.prepare(`
    SELECT * FROM learning_reports WHERE id = ? AND tenant_id = ?
  `).get(reportId, tenantId);

  if (!row) return null;

  return {
    id:          row.id,
    weekStart:   row.week_start,
    weekEnd:     row.week_end,
    generatedBy: row.generated_by,
    createdAt:   row.created_at,
    metrics:     JSON.parse(row.metrics_json),
    insights:    JSON.parse(row.insights_json),
    space:       row.space_json ? JSON.parse(row.space_json) : null,
  };
}
