// server/services/contextInjector.js
// Agent Context Injection Service
// 愿景核心：agent 接到任务的瞬间，自动获得完整上下文
// 包括：团队约定 / 历史决策 / AC 验收标准 / 踩过的坑
//
// 设计原则：
//   - 上下文跟着任务走，agent 不再从零开始（产品愿景 §2）
//   - 总长度控制在 agent context_window 的 20% 以内（不挤占 agent 工作空间）
//   - 优先级：taboo > gotcha > decision > convention > pattern

import { getDb } from '../db/index.js';

const MAX_MEMORY_CHARS = 8000; // 单次注入的 project_memory 字符上限

/**
 * 为 agent 构建完整的任务 context payload
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.tenantId
 * @param {string} params.agentId
 * @param {object} [params.contextOverride] - 调用方可以覆盖任意字段
 * @returns {Promise<object>} dispatch payload
 */
export async function buildAgentContext({ taskId, tenantId, agentId, contextOverride = {} }) {
  const db = getDb();

  // ── 1. 任务详情 ─────────────────────────────────────────────
  const task = db.prepare(`
    SELECT t.*, a.display_name as actor_name, a.type as actor_type
    FROM tasks t
    LEFT JOIN actors a ON t.actor_id = a.id
    WHERE t.id = ? AND t.tenant_id = ?
  `).get(taskId, tenantId);

  if (!task) throw new Error(`task ${taskId} not found`);

  // ── 2. Agent 信息（context_window 限制） ────────────────────
  const agent = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(agentId, tenantId);
  const contextWindowLimit = agent?.context_window || 200000;
  const memoryCharLimit = Math.min(MAX_MEMORY_CHARS, Math.floor(contextWindowLimit * 0.08));

  // ── 3. Project memory（按优先级排序） ───────────────────────
  // 优先级：taboo(最高) > gotcha > decision > convention > pattern > success/failure
  const PRIORITY = { taboo: 0, gotcha: 1, decision: 2, convention: 3, pattern: 4, 'success-case': 5, 'failure-case': 6 };
  const allMemory = db.prepare(`
    SELECT * FROM project_memory
    WHERE tenant_id = ? AND (project_id = ? OR project_id IS NULL)
      AND superseded_by IS NULL
    ORDER BY confidence DESC
    LIMIT 100
  `).all(tenantId, task.project_id || '');

  // 按优先级排序，截断到字符限制
  const sortedMemory = allMemory.sort((a, b) =>
    (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9)
  );
  let memoryChars = 0;
  const selectedMemory = [];
  for (const m of sortedMemory) {
    const len = m.body.length + 20;
    if (memoryChars + len > memoryCharLimit) break;
    selectedMemory.push(m);
    memoryChars += len;
  }

  // ── 4. 最近的 reviews（相似任务的验收历史） ─────────────────
  const recentReviews = db.prepare(`
    SELECT r.level, r.compliance_json, r.suggestion, r.created_at
    FROM reviews r
    JOIN tasks t ON r.task_id = t.id
    WHERE r.tenant_id = ? AND t.project_id = ?
      AND r.level IN ('Block', 'Warning')
    ORDER BY r.created_at DESC LIMIT 5
  `).all(tenantId, task.project_id || '');

  // ── 5. 相关 PR（同项目最近已合并） ──────────────────────────
  const recentPRs = db.prepare(`
    SELECT number, title, head_branch, merged_at
    FROM pulls
    WHERE tenant_id = ? AND project_id = ? AND state = 'merged'
    ORDER BY merged_at DESC LIMIT 3
  `).all(tenantId, task.project_id || '');

  // ── 6. Hub callback URL ──────────────────────────────────────
  const hubUrl = process.env.HUB_URL || 'https://hub.cueai.top';

  // ── 构造最终 payload ─────────────────────────────────────────
  const payload = {
    // 任务标识
    taskId: task.id,
    title: task.title,
    priority: task.priority,
    due: task.due,

    // 验收标准（AC list）
    acceptance: task.acceptance,

    // 当前状态 / 信号
    state: task.state,
    progress: task.progress,
    signal: task.signal,

    // Hub 回调（agent 完成/阻塞/需人工时调用）
    hubCallbackUrl: `${hubUrl}/v2/agents/callback`,
    agentId,

    // ── Context injection 核心 ───────────────────────────────
    context: {
      // 团队记忆（约定/决策/坑/禁忌）
      memory: selectedMemory.map(m => ({
        kind: m.kind,
        body: m.body,
        confidence: m.confidence,
        source: m.source,
      })),

      // 最近阻塞的 review（帮助 agent 规避同类问题）
      recentBlocks: recentReviews.map(r => ({
        level: r.level,
        suggestion: r.suggestion,
        compliance: tryParseJson(r.compliance_json, {}),
        date: r.created_at?.slice(0, 10),
      })),

      // 最近合并的 PR（给 agent 参考代码风格 / 分支命名）
      recentMergedPRs: recentPRs.map(pr => ({
        number: pr.number,
        title: pr.title,
        branch: pr.head_branch,
        mergedAt: pr.merged_at,
      })),

      // 统计：memory 注入量
      memoryStats: {
        total: allMemory.length,
        injected: selectedMemory.length,
        chars: memoryChars,
        limit: memoryCharLimit,
      },

      // 允许调用方覆盖任意字段
      ...contextOverride,
    },
  };

  return payload;
}

/**
 * 把成功的 agent 任务经验写入 project_memory
 * 在 agent.task.completed 后由 notifier 调用（W9 完善）
 */
export async function recordAgentOutcome({ tenantId, taskId, agentId, outcome, evidence }) {
  const db = getDb();
  const task = db.prepare('SELECT project_id, title FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
  if (!task) return;

  // 仅在有明确信号时写入 memory（避免噪音）
  if (!outcome || !evidence) return;

  const kind = outcome === 'success' ? 'success-case' : 'failure-case';
  const body = `[${agentId}] ${outcome === 'success' ? '成功' : '失败'}：${task.title}\n证据：${evidence}`;

  db.prepare(`
    INSERT INTO project_memory
      (tenant_id, project_id, kind, body, confidence, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, task.project_id, kind, body, outcome === 'success' ? 0.6 : 0.8,
    'auto-extracted', new Date().toISOString());

  console.log(`[contextInjector] recorded ${kind} for task ${taskId}`);
}

function tryParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}
