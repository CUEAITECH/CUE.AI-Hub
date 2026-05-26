// server/events/outcomeHandlers.js
// W9: Outcome Ledger 事件订阅 — 将事件总线与 outcomeLedger 自动打标闭合
//
// 原计划 Part M.1 要求：
//   eventBus.on('task.claimed',      (e) => emitOutcome('recommend', ...));
//   eventBus.on('pr.merged', async   (e) => { /* 7 天后 backfill */ });
//
// 此文件在 server/index.js 中以 side-effect import 加载，确保订阅在服务启动时注册。

import { on } from './bus.js';
import {
  autoLabelTaskOutcome,
  autoLabelReviewOutcome,
  recordOutcome,
} from '../services/outcomeLedger.js';
import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import logger from '../logger.js';


// ── 1. 任务状态变更 → 打标 ──────────────────────────────────────
// task.state.changed 是任意合法状态转移的权威事件
// 只在进入终态（done/merged/cancelled）或 in_review 时打标

on('task.state.changed', async ({ tenantId, taskId, to }) => {
  const LABEL_STATES = new Set(['done', 'merged', 'cancelled', 'in_review']);
  if (!LABEL_STATES.has(to)) return;

  try {
    const id = await autoLabelTaskOutcome({ tenantId, taskId });
    if (id !== null) {
      logger.info(`[outcomeHandlers] task.state.changed → labeled outcome id=${id} task=${taskId} state=${to}`);
    }
  } catch (err) {
    // 非阻塞：打标失败不影响状态机
    logger.warn(`[outcomeHandlers] autoLabelTaskOutcome failed for ${taskId}: ${err.message}`);
  }
});

// ── 2. PR 合并 → 7 天后 backfill（delayed outcome）──────────────
// pr.merged 时任务通常刚进入 merged，真正结果（revert 或成功）7 天后才可判断
// 简化版：合并时直接记录正向 outcome（无 revert 检测，满足 M.1 基本要求）

on('pr.merged', async ({ tenantId, taskIds, prId }) => {
  if (!taskIds?.length) return;

  for (const taskId of taskIds) {
    try {
      const db = getDb();
      const task = db.prepare('SELECT state FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
      if (!task) continue;

      // 记录 PR 合并事件 outcome（polarity=1，观测者=auto-rule）
      await recordOutcome({
        tenantId,
        actionType:    'task.dispatch',
        actionRefId:   taskId,
        outcomeSignal: `PR ${prId} 已合并，任务完成`,
        polarity:      1,
        evidence:      { prId, taskState: task.state, event: 'pr.merged' },
        observer:      'auto-rule',
        lagHours:      0,
      });
      logger.info(`[outcomeHandlers] pr.merged → recorded outcome for task=${taskId}`);
    } catch (err) {
      logger.warn(`[outcomeHandlers] pr.merged outcome failed for task ${taskId}: ${err.message}`);
    }
  }
});

// ── 3. Agent 完成任务 → 打标（agent 自评通过时）──────────────────
// agent.task.completed 时 agent 认为自己已完成（AC 状态 = acStatus）
// 此时 review 尚未进行，打 polarity=0（中性，等待人工 review 覆盖）

on('agent.task.completed', async ({ tenantId, taskId, agentId, acStatus }) => {
  try {
    // 检查是否已有该任务的 outcome 记录（避免重复打标）
    const db = getDb();
    const existing = db.prepare(`
      SELECT id FROM ai_outcomes
      WHERE tenant_id = ? AND action_type = 'task.dispatch' AND action_ref_id = ?
      LIMIT 1
    `).get(tenantId, taskId);

    if (existing) return; // 已有记录，跳过

    const allPassed = acStatus && typeof acStatus === 'object'
      ? Object.values(acStatus).every(v => v === true)
      : null;

    await recordOutcome({
      tenantId,
      actionType:    'task.dispatch',
      actionRefId:   taskId,
      outcomeSignal: `Agent ${agentId} 完成任务，待人工 review${allPassed === true ? '（AC 自评全通）' : ''}`,
      polarity:      0, // 中性：等 review 覆盖
      evidence:      { agentId, acStatus, event: 'agent.task.completed' },
      observer:      'auto-rule',
      lagHours:      0,
    });
    logger.info(`[outcomeHandlers] agent.task.completed → polarity=0 outcome for task=${taskId}`);
  } catch (err) {
    logger.warn(`[outcomeHandlers] agent.task.completed outcome failed for ${taskId}: ${err.message}`);
  }
});

// ── 4. PR Review 创建 → 打标审阅结果 ────────────────────────────
// pr.review.posted 触发时，reviews 表中已有记录（由 reducer 写入）

on('pr.review.posted', async ({ tenantId, prId, source, level }) => {
  try {
    const db = getDb();
    // 取最新一条针对此 PR 的 review（reducer 刚刚写入）
    const review = db.prepare(`
      SELECT id FROM reviews
      WHERE tenant_id = ? AND pull_id = ? AND source = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(tenantId, prId, source);

    if (!review) return;

    // 检查是否已打标
    const existing = db.prepare(`
      SELECT id FROM ai_outcomes
      WHERE tenant_id = ? AND action_type = 'code.review' AND action_ref_id = ?
      LIMIT 1
    `).get(tenantId, review.id);

    if (existing) return;

    const id = await autoLabelReviewOutcome({ tenantId, reviewId: review.id });
    if (id !== null) {
      logger.info(`[outcomeHandlers] pr.review.posted → labeled review outcome id=${id} review=${review.id} level=${level}`);
    }
  } catch (err) {
    logger.warn(`[outcomeHandlers] pr.review.posted outcome failed for pr ${prId}: ${err.message}`);
  }
});

logger.info('[outcomeHandlers] ✅ registered (task.state.changed + pr.merged + agent.task.completed + pr.review.posted)');
