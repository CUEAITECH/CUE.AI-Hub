// server/services/runbook.js
// W12: Runbook 系统 — 预定义响应手册 + 自动化告警分发
//
// 设计：
//   - Runbook = 针对特定告警类型的标准操作程序（SOP）
//   - trigger = 监控条件（规则评估，无 LLM）
//   - actions = 建议操作步骤列表
//   - escalation = 告警升级目标（微信/邮件/standup）
//
// 两层功能：
//   A. Runbook 库（静态定义 + 动态注册）
//   B. 告警评估器（扫描系统状态，匹配 runbook，生成告警）

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import { computeHealth } from './observability.js';
import { scanRisks } from './riskPropagation.js';
import logger from '../logger.js';


// ══════════════════════════════════════════════════════════════
// A. Runbook 库
// ══════════════════════════════════════════════════════════════

/**
 * 内置 Runbook 定义
 * 每条 runbook 包含：
 *   - id: 唯一标识
 *   - name: 人类可读名称
 *   - trigger: { metric, operator, threshold }
 *   - severity: 'critical' | 'warning' | 'info'
 *   - actions: 操作步骤数组
 *   - escalation: 告警渠道
 */
export const BUILTIN_RUNBOOKS = [
  {
    id: 'rb_stuck_tasks',
    name: '任务长期卡住',
    trigger: { metric: 'agent.stuckTasks', operator: '>', threshold: 0 },
    severity: 'warning',
    actions: [
      '1. 检查卡住任务的 signal 字段，确认具体阻塞原因',
      '2. 联系任务负责人，询问是否需要支援',
      '3. 如果 agent 卡住，检查 LLM API 可用性',
      '4. 考虑将任务重新分配给其他 actor',
      '5. 如超过 7 天，建议取消并重新规划',
    ],
    escalation: ['wecom', 'standup'],
    runbookUrl: 'https://hub.cueai.top/runbooks/stuck-tasks',
  },
  {
    id: 'rb_low_success_rate',
    name: 'AI 成功率告警',
    trigger: { metric: 'learning.successRate', operator: '<', threshold: 60 },
    severity: 'critical',
    actions: [
      '1. 查看近期失败任务列表（GET /v2/outcomes?polarity=-1）',
      '2. 检查 active learning 队列积压情况',
      '3. 回顾任务描述质量：是否验收标准不清晰',
      '4. 考虑降低 agent autonomy_level，增加人工校验',
      '5. 触发 batchAutoLabel 收集更多训练样本',
    ],
    escalation: ['wecom'],
    runbookUrl: 'https://hub.cueai.top/runbooks/low-success-rate',
  },
  {
    id: 'rb_blocked_reviews',
    name: '代码审阅 Block 积压',
    trigger: { metric: 'pipeline.blockedReviews', operator: '>', threshold: 3 },
    severity: 'warning',
    actions: [
      '1. 查看被 Block 的审阅列表（GET /v2/reviews?level=Block）',
      '2. 对每个 Block 评估是否需要立即修复还是可以暂缓',
      '3. 通知相关 PR 作者修复问题',
      '4. 高优先级（P0/P1）PR 的 Block 需立即处理',
      '5. 考虑运行 auto-enqueue 将 Block 推入 active learning',
    ],
    escalation: ['standup'],
    runbookUrl: 'https://hub.cueai.top/runbooks/blocked-reviews',
  },
  {
    id: 'rb_no_agents',
    name: '无活跃 AI Agent',
    trigger: { metric: 'agent.activeAgents', operator: '===', threshold: 0 },
    severity: 'info',
    actions: [
      '1. 检查是否有 agent 注册（GET /v2/actors?type=ai-agent）',
      '2. 确认 OPENAI_API_KEY 是否配置',
      '3. 确认 agent 的 active 字段是否为 true',
      '4. 如需自动化，注册至少一个 agent',
    ],
    escalation: [],
    runbookUrl: 'https://hub.cueai.top/runbooks/no-agents',
  },
  {
    id: 'rb_low_pr_link_coverage',
    name: 'PR-Task 链接覆盖率低',
    trigger: { metric: 'sync.linkCoverage', operator: '<', threshold: 50 },
    severity: 'warning',
    actions: [
      '1. 运行全量重同步（POST /v2/sync/resync）',
      '2. 检查 PR branch 命名是否包含 task_xxx 格式',
      '3. 指导团队在 PR body 中添加"关联任务：task_xxx"',
      '4. 如果历史 PR 较多，考虑手动批量关联',
    ],
    escalation: [],
    runbookUrl: 'https://hub.cueai.top/runbooks/pr-link-coverage',
  },
];

// ══════════════════════════════════════════════════════════════
// B. 告警评估器
// ══════════════════════════════════════════════════════════════

/**
 * 评估运算符
 */
function evalTrigger(value, operator, threshold) {
  switch (operator) {
    case '>':   return value > threshold;
    case '<':   return value < threshold;
    case '>=':  return value >= threshold;
    case '<=':  return value <= threshold;
    case '===': return value === threshold;
    case '!==': return value !== threshold;
    default:    return false;
  }
}

/**
 * 从健康度报告中提取 metric 值
 */
function extractMetric(health, metricPath) {
  const parts = metricPath.split('.');
  let current = health;
  for (const part of parts) {
    if (current === undefined || current === null) return null;
    // 顶层 components
    if (current.components?.[part] !== undefined) {
      current = current.components[part];
    } else {
      current = current[part];
    }
  }
  return current ?? null;
}

/**
 * 扫描系统状态，生成告警列表
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.projectId]
 * @param {object[]} [params.customRunbooks]  - 额外自定义 runbook
 * @returns {object} alertReport
 */
export function evaluateAlerts({ tenantId, projectId, customRunbooks = [] }) {
  const health = computeHealth({ tenantId });
  const allRunbooks = [...BUILTIN_RUNBOOKS, ...customRunbooks];

  const alerts = [];
  for (const rb of allRunbooks) {
    const value = extractMetric(health, rb.trigger.metric);
    if (value === null) continue;

    if (evalTrigger(value, rb.trigger.operator, rb.trigger.threshold)) {
      alerts.push({
        runbookId:   rb.id,
        runbookName: rb.name,
        severity:    rb.severity,
        metric:      rb.trigger.metric,
        value,
        threshold:   rb.trigger.threshold,
        actions:     rb.actions,
        escalation:  rb.escalation,
        runbookUrl:  rb.runbookUrl,
        triggeredAt: new Date().toISOString(),
      });
    }
  }

  // 按 severity 排序：critical > warning > info
  const order = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  return {
    alerts,
    health: {
      score: health.score,
      grade: health.grade,
    },
    summary: {
      total:    alerts.length,
      critical: alerts.filter(a => a.severity === 'critical').length,
      warning:  alerts.filter(a => a.severity === 'warning').length,
      info:     alerts.filter(a => a.severity === 'info').length,
    },
    tenantId,
    evaluatedAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// C. 告警持久化
// ══════════════════════════════════════════════════════════════

export function ensureAlertsTable() {
  const db = getDb();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS alert_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     TEXT NOT NULL DEFAULT 'default',
      runbook_id    TEXT NOT NULL,
      runbook_name  TEXT NOT NULL,
      severity      TEXT NOT NULL,
      metric        TEXT,
      value         REAL,
      threshold     REAL,
      dispatched_to TEXT,           -- JSON 数组：通知渠道
      acknowledged  INTEGER DEFAULT 0,
      acknowledged_by TEXT,
      acknowledged_at DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

/**
 * 持久化告警（防抖：同一 runbook 在 cooldown 内不重复写入）
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {object} params.alert       - 告警对象
 * @param {number} [params.cooldownHours=4] - 冷却时间（小时）
 * @returns {Promise<number|null>}  新记录 id，或 null（冷却中）
 */
export async function persistAlert({ tenantId, alert, cooldownHours = 4 }) {
  ensureAlertsTable();
  const db = getDb();

  // 检查冷却期
  const cooldownCutoff = new Date(Date.now() - cooldownHours * 3600 * 1000).toISOString();
  const recent = db.prepare(`
    SELECT id FROM alert_history
    WHERE tenant_id = ? AND runbook_id = ? AND created_at >= ?
    LIMIT 1
  `).get(tenantId, alert.runbookId, cooldownCutoff);

  if (recent) return null; // 冷却期内，不重复写

  return dbWrite('alert:persist', (db) => {
    const result = db.prepare(`
      INSERT INTO alert_history
        (tenant_id, runbook_id, runbook_name, severity, metric, value, threshold, dispatched_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId, alert.runbookId, alert.runbookName, alert.severity,
      alert.metric, alert.value, alert.threshold,
      JSON.stringify(alert.escalation || []),
      new Date().toISOString()  // 显式 ISO 格式（避免 CURRENT_TIMESTAMP 与 JS Date 格式不一致）
    );
    return result.lastInsertRowid;
  });
}

/**
 * 确认告警（acknowledge）
 */
export async function acknowledgeAlert({ tenantId, alertId, acknowledgedBy }) {
  ensureAlertsTable();

  return dbWrite('alert:ack', (db) => {
    const result = db.prepare(`
      UPDATE alert_history
      SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = ?
      WHERE id = ? AND tenant_id = ? AND acknowledged = 0
    `).run(acknowledgedBy || 'system', new Date().toISOString(), alertId, tenantId);
    return result.changes > 0;
  });
}

/**
 * 查询告警历史
 */
export function queryAlertHistory({ tenantId, severity, acknowledged, limit = 50, offset = 0 }) {
  ensureAlertsTable();
  const db = getDb();

  let q = 'SELECT * FROM alert_history WHERE tenant_id = ?';
  const params = [tenantId];
  if (severity) { q += ' AND severity = ?'; params.push(severity); }
  if (acknowledged !== undefined) { q += ' AND acknowledged = ?'; params.push(acknowledged ? 1 : 0); }

  const countQ = q.replace('SELECT *', 'SELECT COUNT(*) as c');
  const total = db.prepare(countQ).get(...params).c;

  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return {
    alerts: db.prepare(q).all(...params).map(r => ({
      ...r,
      dispatchedTo: JSON.parse(r.dispatched_to || '[]'),
    })),
    total,
  };
}

/**
 * 完整的告警扫描 + 持久化 pipeline
 * 适合定时调用（每小时）
 */
export async function runAlertCycle({ tenantId, cooldownHours = 4 }) {
  const report = evaluateAlerts({ tenantId });

  let persisted = 0;
  let suppressed = 0;

  for (const alert of report.alerts) {
    const id = await persistAlert({ tenantId, alert, cooldownHours });
    if (id !== null) {
      persisted++;
      logger.info(`[runbook] 📢 ${alert.severity.toUpperCase()}: ${alert.runbookName} (metric=${alert.metric}, value=${alert.value})`);
    } else {
      suppressed++;
    }
  }

  return {
    ...report,
    persisted,
    suppressed,
  };
}
