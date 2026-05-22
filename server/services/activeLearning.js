// server/services/activeLearning.js
// W10: Active Learning Queue — 不确定案例收集 + 人工标注闭环
//
// 职责：
//   1. enqueue      — 将低置信度/有争议的 AI 行为推入待标注队列
//   2. dequeue      — 取出待标注条目（分页）
//   3. label        — 人工打标（写回 ai_outcomes + 更新 queue 条目状态）
//   4. dismiss      — 忽略（无需标注）
//   5. stats        — 队列状态统计
//   6. autoEnqueue  — 规则驱动：扫描低置信度 outcome 自动入队
//
// 队列存储在 learning_queue 表（schema.sql W10 新增）
// 设计约定：
//   - priority: 0-10，越高越紧迫（P0/P1 任务 Block 审阅 = 10）
//   - status: 'pending' | 'labeled' | 'dismissed'
//   - 每条 outcome 在队列中最多出现一次（UNIQUE on outcome_ref）

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import { recordOutcome } from './outcomeLedger.js';

// ══════════════════════════════════════════════════════════════
// 表初始化（启动时检查，不依赖 schema.sql 的手动维护）
// ══════════════════════════════════════════════════════════════

export function ensureLearningQueueTable() {
  const db = getDb();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS learning_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     TEXT NOT NULL DEFAULT 'default',
      outcome_ref   TEXT,           -- ai_outcomes.action_ref_id（或 null）
      action_type   TEXT NOT NULL,
      action_ref_id TEXT NOT NULL,
      reason        TEXT NOT NULL,  -- 为什么需要人工标注
      priority      INTEGER DEFAULT 5,   -- 0-10，越高越紧迫（业务优先级）
      ai_confidence REAL DEFAULT 0.5,    -- AI 置信度 0-1（越低越需要人工标注）
      status        TEXT DEFAULT 'pending',  -- pending | labeled | dismissed
      metadata_json TEXT,
      labeled_polarity INTEGER,    -- 人工标注结果 +1/-1/0
      labeled_signal   TEXT,
      labeled_by       TEXT,
      labeled_at       DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, action_type, action_ref_id)
    )
  `).run();

  // Schema migration：为已存在的旧表添加 ai_confidence 列（幂等）
  try {
    db.prepare('ALTER TABLE learning_queue ADD COLUMN ai_confidence REAL DEFAULT 0.5').run();
    console.log('[activeLearning] migrated: learning_queue.ai_confidence added');
  } catch { /* 列已存在，跳过 */ }
}

// ══════════════════════════════════════════════════════════════
// 1. 入队
// ══════════════════════════════════════════════════════════════

/**
 * 将一个案例推入 Active Learning 队列
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.actionType
 * @param {string} params.actionRefId
 * @param {string} params.reason        - 为什么需要人工标注
 * @param {number} [params.priority=5]  - 0-10（业务优先级，越高越紧迫）
 * @param {number} [params.aiConfidence=0.5] - AI 置信度 0-1（越低越应优先标注）
 * @param {object} [params.metadata]    - 附加上下文
 * @returns {Promise<number|null>}  新 id，或 null（已存在）
 */
export async function enqueue({ tenantId, actionType, actionRefId, reason, priority = 5, aiConfidence = 0.5, metadata = null }) {
  ensureLearningQueueTable();

  return dbWrite('learning_queue:enqueue', (db) => {
    // INSERT OR IGNORE（幂等：同一 action_ref_id 不重复入队）
    const result = db.prepare(`
      INSERT OR IGNORE INTO learning_queue
        (tenant_id, action_type, action_ref_id, reason, priority, ai_confidence, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId, actionType, actionRefId, reason,
      Math.min(10, Math.max(0, priority)),
      Math.max(0, Math.min(1, aiConfidence)),
      metadata ? JSON.stringify(metadata) : null
    );
    return result.changes > 0 ? result.lastInsertRowid : null;
  });
}

// ══════════════════════════════════════════════════════════════
// 2. 出队（分页）
// ══════════════════════════════════════════════════════════════

/**
 * 查询待标注队列
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {'pending'|'labeled'|'dismissed'|'all'} [params.status='pending']
 * @param {string} [params.actionType]
 * @param {number} [params.limit=20]
 * @param {number} [params.offset=0]
 * @returns {{ items: object[], total: number }}
 */
export function dequeue({ tenantId, status = 'pending', actionType, limit = 20, offset = 0 }) {
  ensureLearningQueueTable();
  const db = getDb();

  let q = 'SELECT * FROM learning_queue WHERE tenant_id = ?';
  const params = [tenantId];
  if (status !== 'all') { q += ' AND status = ?'; params.push(status); }
  if (actionType) { q += ' AND action_type = ?'; params.push(actionType); }

  const countQ = q.replace('SELECT *', 'SELECT COUNT(*) as c');
  const total = db.prepare(countQ).get(...params).c;

  // Uncertainty sampling：ai_confidence 越低（越不确定）越优先标注
  // 同等置信度下，业务优先级高的先处理
  q += ' ORDER BY ai_confidence ASC, priority DESC, created_at ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const items = db.prepare(q).all(...params).map(row => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  }));

  return { items, total };
}

// ══════════════════════════════════════════════════════════════
// 3. 人工打标
// ══════════════════════════════════════════════════════════════

/**
 * 对队列条目进行人工打标，同时写入 ai_outcomes
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {number} params.queueId      - learning_queue.id
 * @param {number} params.polarity     - +1/-1/0
 * @param {string} params.signal       - 人工标注描述
 * @param {string} [params.labeledBy]  - 标注者（用户名/角色）
 * @returns {Promise<{ outcomeId: number }>}
 */
export async function label({ tenantId, queueId, polarity, signal, labeledBy = 'human' }) {
  ensureLearningQueueTable();
  const db = getDb();

  const item = db.prepare('SELECT * FROM learning_queue WHERE id = ? AND tenant_id = ?')
    .get(queueId, tenantId);
  if (!item) throw new Error(`queue item ${queueId} not found`);
  if (item.status === 'labeled') throw new Error(`queue item ${queueId} already labeled`);

  // 写 ai_outcomes
  const outcomeId = await recordOutcome({
    tenantId,
    actionType: item.action_type,
    actionRefId: item.action_ref_id,
    outcomeSignal: signal,
    polarity,
    evidence: item.metadata_json ? JSON.parse(item.metadata_json) : null,
    observer: 'human-label',
  });

  // 更新队列状态
  await dbWrite('learning_queue:label', (db) => {
    db.prepare(`
      UPDATE learning_queue
      SET status = 'labeled', labeled_polarity = ?, labeled_signal = ?,
          labeled_by = ?, labeled_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(polarity, signal, labeledBy, new Date().toISOString(), queueId, tenantId);
  });

  return { outcomeId };
}

// ══════════════════════════════════════════════════════════════
// 4. 忽略
// ══════════════════════════════════════════════════════════════

/**
 * 忽略一个队列条目（不需要标注）
 */
export async function dismiss({ tenantId, queueId }) {
  ensureLearningQueueTable();

  return dbWrite('learning_queue:dismiss', (db) => {
    const result = db.prepare(`
      UPDATE learning_queue SET status = 'dismissed'
      WHERE id = ? AND tenant_id = ? AND status = 'pending'
    `).run(queueId, tenantId);
    return result.changes > 0;
  });
}

// ══════════════════════════════════════════════════════════════
// 5. 队列统计
// ══════════════════════════════════════════════════════════════

/**
 * 队列状态统计
 */
export function queueStats({ tenantId }) {
  ensureLearningQueueTable();
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      status,
      COUNT(*) as count,
      AVG(priority) as avg_priority
    FROM learning_queue
    WHERE tenant_id = ?
    GROUP BY status
  `).all(tenantId);

  const byStatus = { pending: 0, labeled: 0, dismissed: 0 };
  for (const r of rows) {
    if (byStatus[r.status] !== undefined) byStatus[r.status] = r.count;
  }

  // 高优先级未处理数
  const urgent = db.prepare(`
    SELECT COUNT(*) as c FROM learning_queue
    WHERE tenant_id = ? AND status = 'pending' AND priority >= 8
  `).get(tenantId).c;

  const total = byStatus.pending + byStatus.labeled + byStatus.dismissed;
  const labelRate = total > 0
    ? Math.round((byStatus.labeled / total) * 100)
    : 0;

  return { byStatus, urgent, total, labelRate };
}

// ══════════════════════════════════════════════════════════════
// 6. 自动入队（扫描低置信度案例）
// ══════════════════════════════════════════════════════════════

/**
 * 扫描规则，自动将需要人工确认的案例推入队列：
 *   - ai_outcomes.polarity = 0（不确定）
 *   - 高优先级任务的 Block review（需要人工决定是否解除拦截）
 *   - 高负载 agent 完成的任务（潜在质量风险）
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.since]   - ISO datetime，默认最近 7 天
 * @returns {Promise<{ enqueued: number }>}
 */
export async function autoEnqueue({ tenantId, since }) {
  ensureLearningQueueTable();
  const db = getDb();
  const cutoff = since || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  let enqueued = 0;

  // 规则 1: polarity=0 的 outcome（不确定，需要人工判断）
  const neutralOutcomes = db.prepare(`
    SELECT * FROM ai_outcomes
    WHERE tenant_id = ? AND polarity = 0 AND observed_at >= ?
    LIMIT 50
  `).all(tenantId, cutoff);

  for (const o of neutralOutcomes) {
    // 中性 outcome = 置信度最低（0.5），是 uncertainty sampling 的核心目标
    const id = await enqueue({
      tenantId,
      actionType:   o.action_type,
      actionRefId:  o.action_ref_id,
      reason:       `outcome 极性为中性（${o.outcome_signal}），需要人工确认`,
      priority:     5,
      aiConfidence: 0.5,  // 中性 = 不确定，置信度 0.5
      metadata: { outcomeId: o.id, outcomeSignal: o.outcome_signal },
    });
    if (id !== null) enqueued++;
  }

  // 规则 2: P0/P1 任务的 Block 级审阅（高影响，需人工干预决定）
  const blockReviews = db.prepare(`
    SELECT r.*, t.priority as task_priority, t.title as task_title
    FROM reviews r
    JOIN tasks t ON r.task_id = t.id
    WHERE r.tenant_id = ? AND r.level = 'Block'
      AND t.priority IN ('P0', 'P1')
      AND r.created_at >= ?
    LIMIT 20
  `).all(tenantId, cutoff);

  for (const r of blockReviews) {
    const id = await enqueue({
      tenantId,
      actionType:   'code.review',
      actionRefId:  r.id,
      reason:       `${r.task_priority} 任务"${r.task_title}"审阅被 Block，需要人工决定是否解除拦截`,
      priority:     9,    // 高业务优先级
      aiConfidence: 0.2,  // Block 审阅 = AI 高置信但人类应该复核 → 低置信度入队最前
      metadata: { reviewId: r.id, taskId: r.task_id, level: r.level },
    });
    if (id !== null) enqueued++;
  }

  console.log(`[activeLearning] autoEnqueue: ${enqueued} items added to queue`);
  return { enqueued };
}
