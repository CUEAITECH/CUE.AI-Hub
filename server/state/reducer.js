// server/state/reducer.js
// 处理 event → DB mutation
// 规则：reducer 是纯数据库操作，不调 LLM，不发通知

import { on } from '../events/bus.js';
import { dbWrite } from '../db/actor.js';
import { syncToJsonStore } from '../db/doubleWrite.js';
import { getDb } from '../db/index.js';

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
      console.warn(`[reducer] task.claimed blocked: ${task.state} → claimed`);
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
      console.warn(`[reducer] invalid transition ${from} → ${to} for ${taskId}`);
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

console.log('[reducer] ✅ registered');
