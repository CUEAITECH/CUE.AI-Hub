// server/services/riskPropagation.js
// W11: 风险传播引擎 — 跨任务依赖的风险扩散
//
// 风险来源：
//   - Block 级审阅
//   - 卡住任务（in_progress > 阈值）
//   - 高负载 actor（WIP > 5）
//   - 取消任务导致的下游影响
//
// 传播算法：Personalized PageRank（graphology + graphology-pagerank）
//   - 依赖图构建：pull_task_links（同 PR 任务视为同层依赖）+ signal 引用（task_xxx）
//   - 个性化种子：初始风险分作为 Personalized PageRank 的 nstart 权重
//   - α=0.85（标准 damping factor，Haveliwala 2002）
//
// 风险存储：使用 task.signal 字段记录（已有），不新建表

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import Graph from 'graphology';
import pagerank from 'graphology-pagerank';

const PRIORITY_MULTIPLIER = { P0: 1.5, P1: 1.3, P2: 1.0, P3: 0.8 };
const PAGERANK_ALPHA = 0.85;  // damping factor（Haveliwala 2002）

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

  // ── 依赖图构建（graphology）────────────────────────────────
  // 节点 = 每个活跃任务；边 = 依赖关系（有向）
  // 边来源 1：pull_task_links（同 PR 的任务视为同层软依赖）
  // 边来源 2：task.signal 中的 task_xxx 引用（格式: "blocked by task_abc"）
  const graph = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });

  // 添加节点
  for (const task of tasks) {
    graph.addNode(task.id, { title: task.title, priority: task.priority });
  }

  // 边来源 1：pull_task_links（同 PR 共享任务 → 相互依赖）
  try {
    const pullLinks = db.prepare(`
      SELECT pull_id, task_id FROM pull_task_links
      WHERE tenant_id = ?
    `).all(tenantId);

    // 按 pull_id 分组，同 PR 内的任务两两相连（无向软依赖）
    const prToTasks = new Map();
    for (const { pull_id, task_id } of pullLinks) {
      if (!graph.hasNode(task_id)) continue; // 只处理活跃任务
      if (!prToTasks.has(pull_id)) prToTasks.set(pull_id, []);
      prToTasks.get(pull_id).push(task_id);
    }
    for (const [, taskIds] of prToTasks) {
      for (let i = 0; i < taskIds.length; i++) {
        for (let j = i + 1; j < taskIds.length; j++) {
          if (!graph.hasEdge(taskIds[i], taskIds[j])) {
            graph.addEdge(taskIds[i], taskIds[j]);
          }
          if (!graph.hasEdge(taskIds[j], taskIds[i])) {
            graph.addEdge(taskIds[j], taskIds[i]);
          }
        }
      }
    }
  } catch { /* pull_task_links 表不存在时忽略 */ }

  // 边来源 2：task.signal 中的 task_xxx 引用
  for (const task of tasks) {
    const signalRefs = (task.signal || '').match(/task[_-][a-zA-Z0-9_-]+/gi) || [];
    for (const ref of signalRefs) {
      const downstream = tasks.find(t => t.id === ref || t.id.endsWith(ref));
      if (downstream && downstream.id !== task.id) {
        try { graph.addEdge(task.id, downstream.id); } catch { /* 边已存在 */ }
      }
    }
  }

  // ── Personalized PageRank（Haveliwala 2002）────────────────
  // nstart = 初始风险分作为个性化权重（归一化到 0-1）
  const propagated = [];

  if (graph.order > 1) {
    try {
      // 构建 nstart（个性化种子权重）
      const maxScore = Math.max(1, ...riskMap.values().map(r => r.score));
      const nstart = {};
      for (const task of tasks) {
        const risk = riskMap.get(task.id);
        nstart[task.id] = risk ? risk.score / maxScore : 0.01; // 无风险节点设最小值
      }

      // 运行 PageRank
      const pr = pagerank(graph, {
        alpha: PAGERANK_ALPHA,
        nstart,         // 个性化起始权重
        maxIterations: 100,
        tolerance: 1e-6,
      });

      // 将 PageRank 分数转换为传播风险（0-10 scale）
      const prValues = Object.values(pr);
      const maxPr = Math.max(...prValues, 0.001);

      for (const [taskId, prScore] of Object.entries(pr)) {
        const originalRisk = riskMap.get(taskId)?.score || 0;
        const propagatedScore = Math.round((prScore / maxPr) * 10 * 10) / 10;

        // 只记录 PageRank 高于原始风险的传播效果（真正被传播影响到的）
        if (propagatedScore > originalRisk && !riskMap.has(taskId)) {
          const task = taskMap.get(taskId);
          if (task) {
            propagated.push({
              sourceTaskId:    'pagerank-propagation',
              sourceRisk:      Math.round(maxScore),
              targetTaskId:    taskId,
              targetTitle:     task.title,
              propagatedScore,
              prScore:         Math.round(prScore * 10000) / 10000,
            });
          }
        }
      }

      // 更新 riskMap 中已有风险节点的传播得分（PageRank 加权）
      for (const [taskId, riskInfo] of riskMap.entries()) {
        const prScore = pr[taskId] || 0;
        const amplified = Math.min(10, riskInfo.score * (1 + prScore / maxPr));
        riskMap.set(taskId, { ...riskInfo, score: Math.round(amplified * 10) / 10 });
      }
    } catch (prErr) {
      console.warn('[riskPropagation] pagerank failed, skipping propagation:', prErr.message);
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
