// server/state/reducer.js
// 处理 event → DB mutation
// 规则：reducer 是纯数据库操作，不调 LLM，不发通知

import { on } from '../events/bus.js';
import { dbWrite } from '../db/actor.js';
import { syncToJsonStore } from '../db/doubleWrite.js';
import { getDb } from '../db/index.js';
import logger from '../logger.js';


// ── 任务状态机（显式枚举，见 Part I 决策 6）───────────────
const VALID_TRANSITIONS = {
  pending:     ['claimed', 'cancelled'],
  claimed:     ['in_progress', 'cancelled', 'pending'],
  in_progress: ['in_review', 'claimed', 'cancelled'],
  in_review:   ['in_progress', 'merged', 'cancelled'],
  merged:      ['done'],
  done:        [],
  cancelled:   ['pending'],
};

function canTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

function now() { return new Date().toISOString(); }

// ── Reducer 注册 ──────────────────────────────────────────

/** task.claimed → state: claimed, actor_id 设置 */
on('task.claimed', async ({ tenantId, taskId, actorId }) => {
  const updated = await dbWrite('reducer:task.claimed', (db) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) return null;
    if (!canTransition(task.state, 'claimed')) {
      logger.warn(`[reducer] task.claimed blocked: ${task.state} → claimed`);
      return null;
    }
    const ts = now();
    db.prepare(`
      UPDATE tasks SET actor_id = ?, state = 'claimed', updated_at = ? WHERE id = ? AND tenant_id = ?
    `).run(actorId, ts, taskId, tenantId);
    return { ...task, actor_id: actorId, state: 'claimed', updated_at: ts };
  });
  if (updated) await syncToJsonStore('tasks', taskId, updated);
});

/** task.state.changed → 任意合法状态转移 */
on('task.state.changed', async ({ tenantId, taskId, from, to }) => {
  const updated = await dbWrite('reducer:task.state.changed', (db) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task || task.state !== from) return null;
    if (!canTransition(from, to)) {
      logger.warn(`[reducer] invalid transition ${from} → ${to} for ${taskId}`);
      return null;
    }
    const ts = now();
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(to, ts, taskId, tenantId);
    return { ...task, state: to, updated_at: ts };
  });
  if (updated) await syncToJsonStore('tasks', taskId, updated);
});

/** task.progressed → progress 更新，signal 记录 */
on('task.progressed', async ({ tenantId, taskId, toProgress, signal }) => {
  const updated = await dbWrite('reducer:task.progressed', (db) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) return null;
    const progress = Math.max(0, Math.min(100, toProgress));
    const ts = now();
    db.prepare(`
      UPDATE tasks SET progress = ?, signal = COALESCE(?, signal), updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(progress, signal || null, ts, taskId, tenantId);
    return { ...task, progress, signal: signal || task.signal, updated_at: ts };
  });
  if (updated) await syncToJsonStore('tasks', taskId, updated);
});

/** pr.merged → task state → merged，级联完成 */
on('pr.merged', async ({ tenantId, prId, taskIds, mergedAt }) => {
  if (!taskIds?.length) return;
  await dbWrite('reducer:pr.merged', (db) => {
    const ts = mergedAt || now();
    for (const taskId of taskIds) {
      const task = db.prepare('SELECT state FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
      if (!task) continue;
      // 强制推进到 merged（跳过中间态，PR 合并是权威信号）
      const targetState = canTransition(task.state, 'merged') ? 'merged' :
                          canTransition(task.state, 'in_review') ? 'in_review' : task.state;
      if (targetState !== task.state) {
        db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run(targetState, ts, taskId, tenantId);
      }
      // 再推进到 merged
      if (targetState !== 'merged' && canTransition(targetState, 'merged')) {
        db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run('merged', ts, taskId, tenantId);
      }
    }
  });
});

/** pr.review.posted → upsert reviews 表 */
on('pr.review.posted', async ({ tenantId, prId, source, level, complianceDelta }) => {
  await dbWrite('reducer:pr.review.posted', (db) => {
    const id = `review_${prId}_${source}_${Date.now()}`;
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, pull_id, source, level, compliance_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, prId, source, level, JSON.stringify(complianceDelta || {}), now(), now());
  });
});

// ── Agent 生命周期 Reducers ───────────────────────────────────

/**
 * agent.task.accepted
 * agent 已接受任务 → state: claimed（与人类 task.claimed 等价）
 * actor_id 已由 dispatch 时设置，此处确保 state 推进
 */
on('agent.task.accepted', async ({ tenantId, agentId, taskId }) => {
  await dbWrite('reducer:agent.task.accepted', (db) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) return;
    if (!canTransition(task.state, 'claimed') && task.state !== 'claimed') {
      logger.warn(`[reducer] agent.task.accepted: unexpected state ${task.state} for ${taskId}`);
      return;
    }
    if (task.state === 'claimed') return; // 幂等：已经 claimed 则跳过
    db.prepare('UPDATE tasks SET actor_id = ?, state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(agentId, 'claimed', now(), taskId, tenantId);
    logger.info(`[reducer] agent ${agentId} accepted task ${taskId}`);
  });
});

/**
 * agent.task.completed
 * agent 完成任务 → state: in_review
 * 同时写入 reviews 表记录 agent 自评 AC 状态
 */
on('agent.task.completed', async ({ tenantId, agentId, taskId, artifacts, acStatus }) => {
  await dbWrite('reducer:agent.task.completed', (db) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) return;

    // 推进状态：claimed / in_progress → in_review
    const targetState = 'in_review';
    if (!canTransition(task.state, 'in_progress') && !canTransition(task.state, targetState)) {
      // 如果还在 claimed，先推进到 in_progress
      if (task.state === 'claimed') {
        db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run('in_progress', now(), taskId, tenantId);
      }
    }
    if (canTransition(task.state === 'claimed' ? 'in_progress' : task.state, targetState)) {
      db.prepare('UPDATE tasks SET state = ?, progress = 100, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run(targetState, now(), taskId, tenantId);
    }

    // 写入 agent 自评 review 记录
    const reviewId = `review_agent_${taskId}_${Date.now()}`;
    db.prepare(`
      INSERT INTO reviews
        (id, tenant_id, task_id, source, level, compliance_json, findings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reviewId, tenantId, taskId,
      'agent',      // source = agent 自评
      'Pass',       // agent 认为自己通过（人类 review 会覆盖）
      JSON.stringify(acStatus || {}),
      JSON.stringify(artifacts || []),
      now(), now()
    );

    logger.info(`[reducer] agent ${agentId} completed task ${taskId}, artifacts: ${(artifacts || []).length}`);
  });
});

/**
 * agent.task.blocked
 * agent 遇到阻塞 → task.signal 更新，state 保持 in_progress
 * 通知由 v2/app.js 的 broadcast 负责
 */
on('agent.task.blocked', async ({ tenantId, agentId, taskId, reason }) => {
  await dbWrite('reducer:agent.task.blocked', (db) => {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) return;
    db.prepare('UPDATE tasks SET signal = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(`🚧 [${agentId}] ${reason || '被阻塞'}`, now(), taskId, tenantId);
    logger.warn(`[reducer] agent ${agentId} blocked on task ${taskId}: ${reason}`);
  });
});

/**
 * agent.task.needs-human
 * agent 需要人工介入 → task.signal 更新，不改变 state
 * 通知由 v2/app.js 的 broadcast 负责
 */
on('agent.task.needs-human', async ({ tenantId, agentId, taskId, question }) => {
  await dbWrite('reducer:agent.task.needs-human', (db) => {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) return;
    db.prepare('UPDATE tasks SET signal = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(`❓ [${agentId}] ${question || '需要人工确认'}`, now(), taskId, tenantId);
    logger.info(`[reducer] agent ${agentId} needs human for task ${taskId}`);
  });
});

/**
 * standup.submitted → 写入 standups 表
 * 人类和 AI agent 共用同一个 reducer（actor 抽象的体现）
 */
on('standup.submitted', async ({ tenantId, actorId, date, yesterday, today, blockers }) => {
  await dbWrite('reducer:standup.submitted', (db) => {
    const id = `standup_${actorId}_${date}_${Date.now()}`;
    db.prepare(`
      INSERT OR REPLACE INTO standups
        (id, tenant_id, date, actor_id, yesterday, today, blockers, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, date, actorId, yesterday, today, blockers || null, 'submitted', now());
    logger.info(`[reducer] standup submitted by ${actorId} for ${date}`);
  });
});

logger.info('[reducer] ✅ registered (W4: agent lifecycle + standup)');
