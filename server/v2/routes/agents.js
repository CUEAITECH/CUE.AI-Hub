// server/v2/routes/agents.js — /v2/agents/*

import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { dbWrite } from '../../db/actor.js';
import { emit } from '../../events/bus.js';
import { broadcast } from '../../adapters/index.js';
import { buildAgentContext } from '../../services/contextInjector.js';
import logger from '../../logger.js';

const AgentCallbackSchema = z.object({
  agentId: z.string(),
  taskId: z.string(),
  action: z.enum(['accepted', 'completed', 'blocked', 'needs-human']),
  artifacts: z.array(z.string()).optional(),
  acStatus: z.any().optional(),
  reason: z.string().optional(),
  question: z.string().optional(),
});

const TaskDispatchSchema = z.object({
  taskId: z.string(),
  agentId: z.string(),
  contextOverride: z.record(z.any()).optional(),
});

const AutoDispatchSchema = z.object({
  taskId: z.string(),
  contextOverride: z.record(z.any()).optional(),
  dryRun: z.boolean().optional().default(false),
});

const StandupSchema = z.object({
  agentId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  yesterday: z.string().min(1),
  today: z.string().min(1),
  blockers: z.string().optional(),
});

export async function handle(ctx) {
  const { method, path, tenantId, readBody, sendV2Json, sendV2Error } = ctx;

  // POST /v2/agents/callback
  if (method === 'POST' && path === '/v2/agents/callback') {
    const body = AgentCallbackSchema.parse(await readBody());

    const eventMap = {
      'accepted':    'agent.task.accepted',
      'completed':   'agent.task.completed',
      'blocked':     'agent.task.blocked',
      'needs-human': 'agent.task.needs-human',
    };
    const eventType = eventMap[body.action];

    await emit(eventType, {
      tenantId, agentId: body.agentId, taskId: body.taskId,
      artifacts: body.artifacts || [], acStatus: body.acStatus,
      reason: body.reason, question: body.question,
    }, { source: 'agent' });

    if (body.action === 'needs-human') {
      await broadcast(
        `🤖 **${body.agentId}** 需要人工介入\n\n任务 \`${body.taskId}\`：${body.question || '(未说明原因)'}`,
        { urgency: 'high' }
      );
    }
    if (body.action === 'blocked') {
      await broadcast(
        `⚠️ **${body.agentId}** 被阻塞\n\n任务 \`${body.taskId}\`：${body.reason || '(未说明原因)'}`,
        { urgency: 'high' }
      );
    }

    sendV2Json(200, { ok: true, eventType });
    return true;
  }

  // POST /v2/agents/dispatch
  if (method === 'POST' && path === '/v2/agents/dispatch') {
    const body = TaskDispatchSchema.parse(await readBody());
    const db = getDb();

    const agent = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ? AND type = ?')
      .get(body.agentId, tenantId, 'ai-agent');
    if (!agent) { sendV2Error(404, 'agent not found'); return true; }
    if (!agent.agent_endpoint) { sendV2Error(422, 'agent has no endpoint configured'); return true; }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(body.taskId, tenantId);
    if (!task) { sendV2Error(404, 'task not found'); return true; }

    const dispatchPayload = await buildAgentContext({
      taskId: body.taskId, tenantId, agentId: body.agentId,
      contextOverride: body.contextOverride || {},
    });

    try {
      const resp = await fetch(agent.agent_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-cue-hub-dispatch': '1',
          ...(agent.agent_api_key_ref ? { 'x-agent-api-key': agent.agent_api_key_ref } : {}),
        },
        body: JSON.stringify(dispatchPayload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) { sendV2Error(502, `agent returned ${resp.status}`); return true; }
    } catch (err) {
      sendV2Error(502, `agent unreachable: ${err.message}`);
      return true;
    }

    await emit('task.claimed', {
      tenantId, taskId: body.taskId, actorId: body.agentId, source: 'scheduler',
    }, { source: 'ui' });

    sendV2Json(200, {
      ok: true, agentId: body.agentId, taskId: body.taskId,
      memoryStats: dispatchPayload.context?.memoryStats,
    });
    return true;
  }

  // POST /v2/agents/auto-dispatch
  if (method === 'POST' && path === '/v2/agents/auto-dispatch') {
    const body = AutoDispatchSchema.parse(await readBody());
    const db = getDb();

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(body.taskId, tenantId);
    if (!task) { sendV2Error(404, 'task not found'); return true; }
    if (task.state !== 'pending') {
      sendV2Error(409, `task state is '${task.state}', only pending tasks can be auto-dispatched`);
      return true;
    }

    const { recommendForTask } = await import('../../services/recommender.js');
    const result = await recommendForTask({
      taskId: body.taskId, tenantId,
      options: { explain: false, limit: 1 },
    });

    if (!result.recommendations || result.recommendations.length === 0) {
      sendV2Error(422, 'recommender returned no candidates');
      return true;
    }

    const top = result.recommendations[0];
    const actorId = top.actorId;
    const actorType = top.type;
    const score = top.score;

    if (body.dryRun) {
      sendV2Json(200, {
        ok: true, dryRun: true,
        recommendation: { actorId, actorType, score, breakdown: top.scoreBreakdown },
      });
      return true;
    }

    if (actorType === 'human') {
      await dbWrite(db, () => {
        db.prepare(
          `UPDATE tasks SET actor_id = ?, state = 'claimed', updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`
        ).run(actorId, body.taskId, tenantId);
      });
      await emit('task.claimed', { tenantId, taskId: body.taskId, actorId, source: 'auto-dispatch' }, { source: 'v2' });
      sendV2Json(200, { ok: true, actorType: 'human', actorId, score, taskId: body.taskId });
      return true;
    }

    // AI Agent path
    const agent = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(actorId, tenantId);
    if (!agent?.agent_endpoint) {
      sendV2Error(422, `top agent '${actorId}' has no endpoint; cannot auto-dispatch`);
      return true;
    }

    const dispatchPayload = await buildAgentContext({
      taskId: body.taskId, tenantId, agentId: actorId,
      contextOverride: body.contextOverride || {},
    });

    try {
      const resp = await fetch(agent.agent_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-cue-hub-dispatch': '1',
          ...(agent.agent_api_key_ref ? { 'x-agent-api-key': agent.agent_api_key_ref } : {}),
        },
        body: JSON.stringify(dispatchPayload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) { sendV2Error(502, `agent returned ${resp.status}`); return true; }
    } catch (err) {
      sendV2Error(502, `agent unreachable: ${err.message}`);
      return true;
    }

    await emit('task.claimed', { tenantId, taskId: body.taskId, actorId, source: 'auto-dispatch' }, { source: 'v2' });
    sendV2Json(200, {
      ok: true, actorType: 'ai-agent', actorId, score, taskId: body.taskId,
      memoryStats: dispatchPayload.context?.memoryStats,
    });
    return true;
  }

  // POST /v2/agents/standup
  if (method === 'POST' && path === '/v2/agents/standup') {
    const body = StandupSchema.parse(await readBody());

    await emit('standup.submitted', {
      tenantId, actorId: body.agentId, date: body.date,
      yesterday: body.yesterday, today: body.today, blockers: body.blockers || null,
    }, { source: 'agent' });

    logger.info(`[v2] standup submitted by agent ${body.agentId} for ${body.date}`);
    sendV2Json(200, { ok: true, agentId: body.agentId, date: body.date });
    return true;
  }

  return false;
}
