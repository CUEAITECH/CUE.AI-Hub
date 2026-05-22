// server/services/autonomy.js
// W14: 渐进式自主权系统 — Agent 自主等级评估与自动升降级
//
// 自主等级定义（1-5）：
//   1. Supervised    — 每次操作需要人工审批
//   2. Assisted      — 常规任务自动执行，复杂任务需审批
//   3. Autonomous    — 自动执行大多数任务，高风险任务需确认
//   4. Trusted       — 自动执行全部任务，仅记录日志
//   5. Fully Auto    — 完全自主，包括 escalation 决策
//
// 升级条件（连续窗口内）：
//   1→2: 最近 10 个任务 successRate ≥ 80%
//   2→3: 最近 20 个任务 successRate ≥ 85%，且无 Block review
//   3→4: 最近 30 个任务 successRate ≥ 90%，且无卡住任务
//   4→5: 最近 50 个任务 successRate ≥ 95%
//
// 降级条件（任意级别立即触发）：
//   - 最近 10 个任务 successRate < 60%        → 降至 1 级
//   - 连续 2 次 Block review                  → 降 1 级
//   - 存在卡住超过 72 小时的任务               → 降 1 级
//
// Circuit Breaker（新增）：
//   - 最近 10 个任务负向率 > 20%               → 立即挂起（降至 1 级）+ 企微告警
//   - 挂起后需人工 POST /v2/autonomy/:id/adjust 才能恢复
//   - 负向率 = polarity=-1 条目 / 总条目

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';

// ══════════════════════════════════════════════════════════════
// 表初始化
// ══════════════════════════════════════════════════════════════

export function ensureAutonomyTables() {
  const db = getDb();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS actor_autonomy (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      actor_id    TEXT NOT NULL,
      level       INTEGER NOT NULL DEFAULT 1,
      reason      TEXT,
      changed_by  TEXT NOT NULL DEFAULT 'system',
      created_at  DATETIME NOT NULL,
      UNIQUE(tenant_id, actor_id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS autonomy_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      actor_id    TEXT NOT NULL,
      old_level   INTEGER,
      new_level   INTEGER NOT NULL,
      direction   TEXT,           -- 'promoted' | 'demoted' | 'initialized' | 'manual'
      reason      TEXT,
      changed_by  TEXT NOT NULL DEFAULT 'system',
      created_at  DATETIME NOT NULL
    )
  `).run();
}

// ══════════════════════════════════════════════════════════════
// 自主级别定义
// ══════════════════════════════════════════════════════════════

export const AUTONOMY_LEVELS = {
  1: { name: 'Supervised',  description: '每次操作需要人工审批', color: 'red' },
  2: { name: 'Assisted',    description: '常规任务自动执行，复杂任务需审批', color: 'orange' },
  3: { name: 'Autonomous',  description: '自动执行大多数任务，高风险任务需确认', color: 'yellow' },
  4: { name: 'Trusted',     description: '自动执行全部任务，仅记录日志', color: 'green' },
  5: { name: 'Fully Auto',  description: '完全自主，包括 escalation 决策', color: 'blue' },
};

// ══════════════════════════════════════════════════════════════
// 读取当前级别
// ══════════════════════════════════════════════════════════════

/**
 * 获取 actor 当前自主级别
 * @returns {object} { level, levelName, description, reason, changedAt }
 */
export function getAutonomyLevel({ tenantId, actorId }) {
  ensureAutonomyTables();
  const db = getDb();

  const row = db.prepare(`
    SELECT * FROM actor_autonomy
    WHERE tenant_id = ? AND actor_id = ?
  `).get(tenantId, actorId);

  if (!row) {
    return {
      level: 1,
      levelName: AUTONOMY_LEVELS[1].name,
      description: AUTONOMY_LEVELS[1].description,
      reason: '默认初始级别',
      changedAt: null,
    };
  }

  return {
    level: row.level,
    levelName: AUTONOMY_LEVELS[row.level]?.name ?? 'Unknown',
    description: AUTONOMY_LEVELS[row.level]?.description ?? '',
    reason: row.reason,
    changedAt: row.created_at,
  };
}

/**
 * 获取 actor 自主级别变更历史
 */
export function getAutonomyHistory({ tenantId, actorId, limit = 20 }) {
  ensureAutonomyTables();
  const db = getDb();

  return db.prepare(`
    SELECT * FROM autonomy_history
    WHERE tenant_id = ? AND actor_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(tenantId, actorId, limit);
}

/**
 * 列出所有 AI agent 的自主级别
 */
export function listAutonomyLevels({ tenantId }) {
  ensureAutonomyTables();
  const db = getDb();

  // 获取所有 ai-agent actors
  const agents = db.prepare(`
    SELECT id, display_name, active FROM actors
    WHERE tenant_id = ? AND type = 'ai-agent'
    ORDER BY display_name
  `).all(tenantId);

  return agents.map(agent => {
    const row = db.prepare(`
      SELECT * FROM actor_autonomy WHERE tenant_id = ? AND actor_id = ?
    `).get(tenantId, agent.id);

    const level = row?.level ?? 1;
    return {
      actorId: agent.id,
      actorName: agent.display_name,
      active: !!agent.active,
      level,
      levelName: AUTONOMY_LEVELS[level]?.name ?? 'Unknown',
      description: AUTONOMY_LEVELS[level]?.description ?? '',
      reason: row?.reason ?? '默认初始级别',
      changedAt: row?.created_at ?? null,
    };
  });
}

// ══════════════════════════════════════════════════════════════
// 评估（不写入）
// ══════════════════════════════════════════════════════════════

/**
 * 评估 actor 的升降级建议（纯计算，不写入）
 *
 * @returns {object} {
 *   currentLevel, recommendation, newLevel, direction, reason,
 *   metrics: { recentOutcomes, successRate, blockReviews, stuckTasks }
 * }
 */
export function evaluateAutonomy({ tenantId, actorId }) {
  ensureAutonomyTables();
  const db = getDb();

  const current = getAutonomyLevel({ tenantId, actorId });
  const currentLevel = current.level;

  // ── 收集近期指标 ─────────────────────────────────────────

  // 最近 50 个 outcomes（agent 任务）
  const outcomes50 = db.prepare(`
    SELECT polarity FROM ai_outcomes
    WHERE tenant_id = ? AND action_type = 'task' AND observer = ?
    ORDER BY observed_at DESC
    LIMIT 50
  `).all(tenantId, actorId);

  const outcomes30 = outcomes50.slice(0, 30);
  const outcomes20 = outcomes50.slice(0, 20);
  const outcomes10 = outcomes50.slice(0, 10);

  const successRate = (arr) => {
    if (arr.length === 0) return null;
    const pos = arr.filter(r => r.polarity === 1).length;
    return Math.round(pos / arr.length * 100);
  };

  // 卡住任务（超过 72 小时）— unixepoch 兼容 ISO 和 SQLite 两种格式
  const stuckTasks = db.prepare(`
    SELECT COUNT(*) as c FROM tasks t
    WHERE t.tenant_id = ? AND t.actor_id = ?
      AND t.state = 'in_progress'
      AND unixepoch(t.updated_at) <= unixepoch('now', '-72 hours')
  `).get(tenantId, actorId).c;

  // 最近 10 次 review 中连续 Block 次数（通过 task_id 关联到 actor）
  const recentReviews = db.prepare(`
    SELECT r.level FROM reviews r
    JOIN tasks t ON r.task_id = t.id
    WHERE r.tenant_id = ? AND t.actor_id = ?
    ORDER BY r.created_at DESC
    LIMIT 10
  `).all(tenantId, actorId);

  // 计算连续 Block 次数（从最新往前数）
  let consecutiveBlocks = 0;
  for (const r of recentReviews) {
    if (r.level === 'Block') consecutiveBlocks++;
    else break;
  }

  const metrics = {
    outcomes50: outcomes50.length,
    outcomes10: outcomes10.length,
    successRate10: successRate(outcomes10),
    successRate20: successRate(outcomes20),
    successRate30: successRate(outcomes30),
    successRate50: successRate(outcomes50),
    stuckTasks,
    consecutiveBlocks,
  };

  // ── 降级优先检查 ─────────────────────────────────────────

  // 降级条件 1：最近 10 个任务 successRate < 60%
  if (outcomes10.length >= 5 && metrics.successRate10 < 60) {
    return {
      currentLevel,
      recommendation: 'demote',
      newLevel: 1,
      direction: 'demoted',
      reason: `最近 ${outcomes10.length} 个任务成功率仅 ${metrics.successRate10}%，低于 60% 警戒线，降至监督级`,
      metrics,
    };
  }

  // 降级条件 2：连续 2 次 Block review
  if (consecutiveBlocks >= 2 && currentLevel > 1) {
    const newLevel = Math.max(1, currentLevel - 1);
    return {
      currentLevel,
      recommendation: 'demote',
      newLevel,
      direction: 'demoted',
      reason: `连续 ${consecutiveBlocks} 次 Block review，降 1 级`,
      metrics,
    };
  }

  // 降级条件 3：存在卡住超过 72 小时的任务
  if (stuckTasks > 0 && currentLevel > 1) {
    const newLevel = Math.max(1, currentLevel - 1);
    return {
      currentLevel,
      recommendation: 'demote',
      newLevel,
      direction: 'demoted',
      reason: `存在 ${stuckTasks} 个卡住超过 72 小时的任务，降 1 级`,
      metrics,
    };
  }

  // ── 升级检查 ─────────────────────────────────────────────

  if (currentLevel < 5) {
    const promotionChecks = [
      // 1→2
      {
        from: 1, to: 2,
        check: () => outcomes10.length >= 10 && metrics.successRate10 >= 80,
        reason: () => `最近 10 个任务成功率 ${metrics.successRate10}%（≥80%），升至协助级`,
      },
      // 2→3
      {
        from: 2, to: 3,
        check: () => outcomes20.length >= 20 && metrics.successRate20 >= 85 && consecutiveBlocks === 0,
        reason: () => `最近 20 个任务成功率 ${metrics.successRate20}%（≥85%），且无 Block，升至自主级`,
      },
      // 3→4
      {
        from: 3, to: 4,
        check: () => outcomes30.length >= 30 && metrics.successRate30 >= 90 && stuckTasks === 0,
        reason: () => `最近 30 个任务成功率 ${metrics.successRate30}%（≥90%），且无卡住，升至信任级`,
      },
      // 4→5
      {
        from: 4, to: 5,
        check: () => outcomes50.length >= 50 && metrics.successRate50 >= 95,
        reason: () => `最近 50 个任务成功率 ${metrics.successRate50}%（≥95%），升至完全自主级`,
      },
    ];

    for (const pc of promotionChecks) {
      if (currentLevel === pc.from && pc.check()) {
        return {
          currentLevel,
          recommendation: 'promote',
          newLevel: pc.to,
          direction: 'promoted',
          reason: pc.reason(),
          metrics,
        };
      }
    }
  }

  // 无变化
  return {
    currentLevel,
    recommendation: 'maintain',
    newLevel: currentLevel,
    direction: null,
    reason: '当前表现符合级别要求，维持不变',
    metrics,
  };
}

// ══════════════════════════════════════════════════════════════
// 写入级别调整
// ══════════════════════════════════════════════════════════════

/**
 * 调整 actor 自主级别
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.actorId
 * @param {number} params.newLevel    1-5
 * @param {string} [params.reason]
 * @param {string} [params.changedBy] 'system' | 'auto' | 用户名
 * @param {string} [params.direction] 'promoted' | 'demoted' | 'initialized' | 'manual'
 * @returns {Promise<object>} { actorId, oldLevel, newLevel, direction, changedAt }
 */
export async function adjustAutonomy({ tenantId, actorId, newLevel, reason, changedBy = 'system', direction }) {
  if (newLevel < 1 || newLevel > 5) {
    throw new Error(`自主级别必须在 1-5 之间，收到 ${newLevel}`);
  }

  ensureAutonomyTables();

  return dbWrite('autonomy:adjust', (db) => {
    const now = new Date().toISOString();

    // 获取当前级别
    const current = db.prepare(`
      SELECT level FROM actor_autonomy WHERE tenant_id = ? AND actor_id = ?
    `).get(tenantId, actorId);

    const oldLevel = current?.level ?? null;

    // 确定方向
    let dir = direction;
    if (!dir) {
      if (oldLevel === null) dir = 'initialized';
      else if (newLevel > oldLevel) dir = 'promoted';
      else if (newLevel < oldLevel) dir = 'demoted';
      else dir = 'manual';
    }

    // UPSERT 当前级别
    db.prepare(`
      INSERT INTO actor_autonomy (tenant_id, actor_id, level, reason, changed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, actor_id)
      DO UPDATE SET level = excluded.level, reason = excluded.reason,
                    changed_by = excluded.changed_by, created_at = excluded.created_at
    `).run(tenantId, actorId, newLevel, reason || null, changedBy, now);

    // 写历史记录
    db.prepare(`
      INSERT INTO autonomy_history
        (tenant_id, actor_id, old_level, new_level, direction, reason, changed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantId, actorId, oldLevel, newLevel, dir, reason || null, changedBy, now);

    return { actorId, oldLevel, newLevel, direction: dir, changedAt: now };
  });
}

// ══════════════════════════════════════════════════════════════
// 自动调整所有 Agent
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// Circuit Breaker
// ══════════════════════════════════════════════════════════════

/**
 * 检查 Circuit Breaker：最近 10 个负向率 > 20% → 挂起
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.actorId
 * @returns {{ tripped: boolean, negativeRate: number, sampleSize: number }}
 */
export function checkCircuitBreaker({ tenantId, actorId }) {
  const db = getDb();

  const recent = db.prepare(`
    SELECT polarity FROM ai_outcomes
    WHERE tenant_id = ? AND observer != 'human-label'
    ORDER BY observed_at DESC
    LIMIT 10
  `).all(tenantId);

  // 过滤出属于该 actor 的 outcomes（通过 action_ref_id 关联 tasks.actor_id）
  const actorOutcomes = db.prepare(`
    SELECT o.polarity
    FROM ai_outcomes o
    JOIN tasks t ON o.action_ref_id = t.id
    WHERE o.tenant_id = ? AND t.actor_id = ?
    ORDER BY o.observed_at DESC
    LIMIT 10
  `).all(tenantId, actorId);

  if (actorOutcomes.length < 3) {
    return { tripped: false, negativeRate: 0, sampleSize: actorOutcomes.length };
  }

  const negCount  = actorOutcomes.filter(r => r.polarity === -1).length;
  const negativeRate = negCount / actorOutcomes.length;

  return {
    tripped: negativeRate > 0.2,
    negativeRate: Math.round(negativeRate * 100),
    sampleSize: actorOutcomes.length,
  };
}

/**
 * 扫描所有 AI Agent，自动升降级（含 Circuit Breaker）
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {boolean} [params.dryRun=false]  - 仅评估，不写入
 * @returns {Promise<object>} { evaluated, promoted, demoted, maintained, circuitTripped, results[] }
 */
export async function autoAdjustAll({ tenantId, dryRun = false }) {
  ensureAutonomyTables();
  const db = getDb();

  const agents = db.prepare(`
    SELECT id, display_name FROM actors
    WHERE tenant_id = ? AND type = 'ai-agent' AND active = 1
  `).all(tenantId);

  const results = [];
  let promoted = 0;
  let demoted = 0;
  let maintained = 0;
  let circuitTripped = 0;

  for (const agent of agents) {
    // ── Circuit Breaker 优先检查（高于普通 demote 逻辑）────────
    const cb = checkCircuitBreaker({ tenantId, actorId: agent.id });
    const currentInfo = getAutonomyLevel({ tenantId, actorId: agent.id });

    if (cb.tripped && currentInfo.level > 1) {
      const reason = `Circuit Breaker 触发：最近 ${cb.sampleSize} 个行为负向率 ${cb.negativeRate}%（阈值 20%），立即降至监督级`;

      const result = {
        actorId:            agent.id,
        actorName:          agent.display_name,
        currentLevel:       currentInfo.level,
        recommendation:     'circuit-break',
        newLevel:           1,
        reason,
        metrics:            { circuitBreaker: cb },
        applied:            false,
        circuitBreakerFired: true,
      };

      if (!dryRun) {
        await adjustAutonomy({
          tenantId,
          actorId:   agent.id,
          newLevel:  1,
          reason,
          changedBy: 'circuit-breaker',
          direction: 'demoted',
        });
        result.applied = true;

        // 企微告警（fire and forget）
        try {
          const { broadcast } = await import('../adapters/index.js');
          await broadcast(
            `🚨 **Circuit Breaker 触发**\n\n` +
            `Agent \`${agent.display_name}\` 已从 **${currentInfo.levelName}** 降至 **Supervised**\n` +
            `原因：${reason}\n\n` +
            `需要人工通过 \`POST /v2/autonomy/${agent.id}/adjust\` 恢复。`,
            { urgency: 'high' }
          );
        } catch {}
      }

      circuitTripped++;
      demoted++;
      results.push(result);
      continue; // 跳过普通 evaluate，circuit break 优先
    }

    // ── 普通升降级评估 ──────────────────────────────────────────
    const evaluation = evaluateAutonomy({ tenantId, actorId: agent.id });

    const result = {
      actorId:     agent.id,
      actorName:   agent.display_name,
      currentLevel: evaluation.currentLevel,
      recommendation: evaluation.recommendation,
      newLevel:    evaluation.newLevel,
      reason:      evaluation.reason,
      metrics:     evaluation.metrics,
      applied:     false,
      circuitBreakerFired: false,
    };

    if (evaluation.recommendation !== 'maintain' && !dryRun) {
      await adjustAutonomy({
        tenantId,
        actorId:   agent.id,
        newLevel:  evaluation.newLevel,
        reason:    evaluation.reason,
        changedBy: 'auto',
        direction: evaluation.direction,
      });
      result.applied = true;

      // 降级时企微告警
      if (evaluation.recommendation === 'demote') {
        try {
          const { broadcast } = await import('../adapters/index.js');
          await broadcast(
            `⚠️ **Agent 自主等级自动降级**\n\n` +
            `Agent \`${agent.display_name}\`：` +
            `**${AUTONOMY_LEVELS[evaluation.currentLevel]?.name}** → **${AUTONOMY_LEVELS[evaluation.newLevel]?.name}**\n` +
            `原因：${evaluation.reason}`,
            { urgency: 'medium' }
          );
        } catch {}
      }
    }

    if (evaluation.recommendation === 'promote') promoted++;
    else if (evaluation.recommendation === 'demote') demoted++;
    else maintained++;

    results.push(result);
  }

  return {
    evaluated: agents.length,
    promoted,
    demoted,
    maintained,
    circuitTripped,
    dryRun,
    results,
    runAt: new Date().toISOString(),
  };
}

/**
 * 检查 actor 是否有权限执行某操作（基于自主级别）
 *
 * 权限矩阵：
 *   level 1: 仅 read
 *   level 2: read + execute_routine（非高风险任务）
 *   level 3: read + execute_routine + execute_complex
 *   level 4: read + execute_routine + execute_complex + escalate
 *   level 5: 全部权限
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.actorId
 * @param {string} params.action  - 'read' | 'execute_routine' | 'execute_complex' | 'escalate' | 'admin'
 * @returns {boolean}
 */
export function canPerform({ tenantId, actorId, action }) {
  const { level } = getAutonomyLevel({ tenantId, actorId });

  const permissions = {
    1: ['read'],
    2: ['read', 'execute_routine'],
    3: ['read', 'execute_routine', 'execute_complex'],
    4: ['read', 'execute_routine', 'execute_complex', 'escalate'],
    5: ['read', 'execute_routine', 'execute_complex', 'escalate', 'admin'],
  };

  return (permissions[level] ?? permissions[1]).includes(action);
}
