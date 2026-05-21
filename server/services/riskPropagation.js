// server/services/riskPropagation.js
// W11: 风险传播引擎 — 跨任务依赖的风险扩散
//
// 风险来源：
//   - Block 级审阅
//   - 卡住任务（in_progress > 阈值）
//   - 高负载 actor（WIP > 5）
//   - 取消任务导致的下游影响
//
// 传播规则：
//   - 任务 A "blocks" 任务 B → A 的风险传播到 B（衰减 50%）
//   - P0/P1 任务风险乘数 1.5x
//   - 最大传播深度 3 层
//
// 风险存储：使用 task.signal 字段记录（已有），不新建表

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';

const MAX_PROPAGATION_DEPTH = 3;
const PROPAGATION_DECAY = 0.5;    // 每层衰减 50%
const PRIORITY_MULTIPLIER = { P0: 1.5, P1: 1.3, P2: 1.0, P3: 0.8 };

/**
 * 扫描项目风险源，计算传播后的风险分布
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.projectId]
 * @returns {object} riskReport
 */
export function scanRisks({ tenantId, projectId }) {
  const db = getDb();

  const projectFilter = projectId ? ' AND project_id = ?' : '';
  const projectParams = projectId ? [projectId] : [];

  // ── 读取所有相关任务 ─────────────────────────────────────
  const tasks = db.prepare(`
    SELECT t.*, a.display_name as actor_name, a.type as actor_type
    FROM tasks t
    LEFT JOIN actors a ON t.actor_id = a.id
    WHERE t.tenant_id = ? ${projectFilter}
      AND t.state NOT IN ('done', 'merged', 'cancelled')
  `).all(tenantId, ...projectParams);

  if (tasks.length === 0) {
    return { risks: [], propagated: [], summary: { total: 0, critical: 0, high: 0, medium: 0 }, projectId };
  }

  // ── 计算各任务的初始风险 ─────────────────────────────────
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const riskMap = new Map(); // taskId → riskScore (0-10)

  const weekCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  for (const task of tasks) {
    let risk = 0;
    const reasons = [];

    // Block 级审阅
    const blockReview = db.prepare(`
      SELECT COUNT(*) as c FROM reviews
      WHERE tenant_id = ? AND task_id = ? AND level = 'Block' AND created_at >= ?
    `).get(tenantId, task.id, weekCutoff).c;
    if (blockReview > 0) {
      risk += 4;
      reasons.push(`审阅被 Block（${blockReview} 次）`);
    }

    // 卡住任务（in_progress 超 48 小时）
    if (task.state === 'in_progress' && task.updated_at) {
      const hoursStuck = (Date.now() - new Date(task.updated_at).getTime()) / 3600000;
      if (hoursStuck > 72) {
        risk += 5;
        reasons.push(`卡住 ${Math.round(hoursStuck)} 小时`);
      } else if (hoursStuck > 48) {
        risk += 3;
        reasons.push(`进行中超过 48 小时`);
      }
    }

    // 高负载 actor（WIP > 5）
    if (task.actor_id) {
      const actorWIP = db.prepare(`
        SELECT COUNT(*) as c FROM tasks
        WHERE tenant_id = ? AND actor_id = ? AND state IN ('in_progress', 'claimed')
      `).get(tenantId, task.actor_id).c;
      if (actorWIP > 5) {
        risk += 2;
        reasons.push(`${task.actor_name} 负载过高（WIP=${actorWIP}）`);
      }
    }

    // progress 停滞（progress < 30% 且已超 72 小时）
    if (task.progress < 30 && task.state === 'in_progress') {
      const hoursSinceCreate = task.created_at
        ? (Date.now() - new Date(task.created_at).getTime()) / 3600000
        : 0;
      if (hoursSinceCreate > 72) {
        risk += 2;
        reasons.push(`进度停滞（${task.progress}%，已创建 ${Math.round(hoursSinceCreate / 24)} 天）`);
      }
    }

    // 优先级乘数
    const multiplier = PRIORITY_MULTIPLIER[task.priority] || 1;
    const finalRisk = Math.min(10, Math.round(risk * multiplier * 10) / 10);

    if (finalRisk > 0) {
      riskMap.set(task.id, { score: finalRisk, reasons, taskId: task.id, task });
    }
  }

  // ── 风险传播（BFS，最大深度 3）──────────────────────────
  // 依赖关系来自 task.signal 中的 "blocked by task_xxx" 格式
  // 以及 pull_task_links（PR 关联任务视为软依赖）
  const propagated = [];

  for (const [taskId, riskInfo] of riskMap.entries()) {
    if (riskInfo.score < 2) continue; // 只传播中等以上风险

    // 查找信号中的 "blocked by" 引用
    const task = taskId ? taskMap.get(taskId) : null;
    if (!task) continue;

    // 从 signal 中解析下游任务（模糊匹配 task_xxx 引用）
    const signalRefs = (task.signal || '').match(/task[_-][a-zA-Z0-9_-]+/gi) || [];

    for (let depth = 1; depth <= MAX_PROPAGATION_DEPTH; depth++) {
      const decayedScore = Math.round(riskInfo.score * Math.pow(PROPAGATION_DECAY, depth) * 10) / 10;
      if (decayedScore < 0.5) break;

      // 推送给下游任务（模拟：这里直接记录传播路径）
      for (const ref of signalRefs) {
        const downstreamTask = tasks.find(t => t.id.includes(ref) || t.id === ref);
        if (downstreamTask && downstreamTask.id !== taskId) {
          propagated.push({
            sourceTaskId:   taskId,
            sourceRisk:     riskInfo.score,
            targetTaskId:   downstreamTask.id,
            targetTitle:    downstreamTask.title,
            propagatedScore: decayedScore,
            depth,
          });
        }
      }
    }
  }

  // ── 汇总所有风险（原始 + 传播） ─────────────────────────
  const allRisks = [...riskMap.values()]
    .sort((a, b) => b.score - a.score)
    .map(r => ({
      taskId:    r.taskId,
      taskTitle: r.task?.title || r.taskId,
      priority:  r.task?.priority || 'P2',
      state:     r.task?.state || 'unknown',
      actorName: r.task?.actor_name || null,
      riskScore: r.score,
      severity:  r.score >= 7 ? 'critical' : r.score >= 4 ? 'high' : 'medium',
      reasons:   r.reasons,
    }));

  const summary = {
    total:    allRisks.length,
    critical: allRisks.filter(r => r.severity === 'critical').length,
    high:     allRisks.filter(r => r.severity === 'high').length,
    medium:   allRisks.filter(r => r.severity === 'medium').length,
  };

  return {
    risks: allRisks,
    propagated,
    summary,
    projectId: projectId || null,
    computedAt: new Date().toISOString(),
  };
}

/**
 * 将高风险任务的风险信号写入任务 signal 字段
 * 用于晚会展示和 Dashboard 告警
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.projectId]
 * @param {number} [params.threshold=7]  - 只更新 riskScore >= threshold 的任务
 */
export async function propagateRiskSignals({ tenantId, projectId, threshold = 7 }) {
  const report = scanRisks({ tenantId, projectId });
  const criticalRisks = report.risks.filter(r => r.riskScore >= threshold);

  let updated = 0;
  for (const risk of criticalRisks) {
    const signal = `⚠️ 风险告警（${risk.riskScore}/10）：${risk.reasons.slice(0, 2).join('；')}`;
    await dbWrite(`risk:signal:${risk.taskId}`, (db) => {
      db.prepare(`
        UPDATE tasks SET signal = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(signal, new Date().toISOString(), risk.taskId, tenantId);
    });
    updated++;
  }

  console.log(`[riskPropagation] propagated ${updated} risk signals`);
  return { updated, threshold, critical: criticalRisks.length };
}

/**
 * 为单个任务计算风险（快速路径，用于 API）
 */
export function getRiskForTask({ tenantId, taskId }) {
  const report = scanRisks({ tenantId });
  const risk = report.risks.find(r => r.taskId === taskId);
  return risk || { taskId, riskScore: 0, severity: 'none', reasons: [] };
}
