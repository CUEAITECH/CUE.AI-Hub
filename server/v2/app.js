// server/v2/app.js
// V2 路由层 — 不使用 Fastify（Node.js v24 ESM 兼容性问题，见工程宪章 N.1）
// 使用与现有 handleApi 相同的模式：纯 Node.js http 模块
// Fastify 集成在 Fastify 修复 ESM 支持后再引入（W5+）

import { z } from 'zod';
import { getDb } from '../db/index.js';
import { withTenant } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import { emit } from '../events/bus.js';
import { broadcast } from '../adapters/index.js';
import { buildAgentContext } from '../services/contextInjector.js';

// ── zod schemas ───────────────────────────────────────────────
const ActorCreateSchema = z.object({
  type: z.enum(['human', 'ai-agent']),
  displayName: z.string().min(1),
  email: z.string().email().optional(),
  commHandle: z.string().optional(),
  agentModel: z.string().optional(),
  agentEndpoint: z.string().url().optional(),
  capabilities: z.array(z.string()).default([]),
  contextWindow: z.number().int().positive().optional(),
});

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

const StandupSchema = z.object({
  agentId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  yesterday: z.string().min(1),
  today: z.string().min(1),
  blockers: z.string().optional(),
});

// ── 辅助函数 ─────────────────────────────────────────────────
function sendV2Json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function sendV2Error(res, statusCode, message, details) {
  sendV2Json(res, statusCode, { error: message, ...(details ? { details } : {}) });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * V2 路由主处理函数
 * 由 server/index.js 主 handler 在 pathname.startsWith('/v2/') 时调用
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handleV2(req, res, url) {
  const method = req.method;
  const path = url.pathname;
  const tenantId = req.headers['x-tenant-id'] || 'default';

  // ── CORS preflight ───────────────────────────────────────────
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-cue-api-key, x-tenant-id',
    });
    res.end();
    return true;
  }

  try {
    // ════════════════════════════════════════════════════════════
    // GET /v2/health
    // ════════════════════════════════════════════════════════════
    if (method === 'GET' && path === '/v2/health') {
      const db = getDb();
      const { count } = db.prepare('SELECT COUNT(*) as count FROM actors').get();
      sendV2Json(res, 200, {
        status: 'ok',
        version: 'v2',
        actors: count,
        ts: new Date().toISOString(),
      });
      return true;
    }

    // GET /v2/info
    if (method === 'GET' && path === '/v2/info') {
      const { getAllAdapters } = await import('../adapters/index.js');
      sendV2Json(res, 200, {
        version: 'v2',
        vision: 'Operating system for hybrid human+AI teams',
        adapters: getAllAdapters().map(a => a.name),
        features: ['actor-abstraction', 'event-bus', 'state-machine', 'notification-adapter', 'agent-protocol'],
      });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // Actor 端点
    // ════════════════════════════════════════════════════════════

    // GET /v2/actors
    if (method === 'GET' && path === '/v2/actors') {
      const actors = await withTenant(tenantId).actors().selectAll().execute();
      sendV2Json(res, 200, actors.map(a => ({
        id: a.id,
        type: a.type,
        displayName: a.display_name,
        email: a.email,
        commHandle: a.comm_handle,
        agentModel: a.agent_model,
        agentEndpoint: a.agent_endpoint,
        capabilities: JSON.parse(a.capabilities_json || '[]'),
        autonomyLevel: a.autonomy_level,
        active: Boolean(a.active),
        createdAt: a.created_at,
      })));
      return true;
    }

    // POST /v2/actors
    if (method === 'POST' && path === '/v2/actors') {
      const rawBody = await readBody(req);
      const body = ActorCreateSchema.parse(rawBody);
      const id = `actor_${body.type === 'human' ? 'human' : 'agent'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();

      await dbWrite('v2:actor.create', (db) => {
        db.prepare(`
          INSERT INTO actors
            (id, tenant_id, type, display_name, email, comm_handle,
             agent_model, agent_endpoint, capabilities_json,
             autonomy_level, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
        `).run(id, tenantId, body.type, body.displayName,
          body.email || null, body.commHandle || null,
          body.agentModel || null, body.agentEndpoint || null,
          JSON.stringify(body.capabilities), now, now);
      });

      if (body.type === 'ai-agent') {
        console.log(`[v2] AI agent registered: ${id} (${body.displayName})`);
      }
      sendV2Json(res, 201, { id, type: body.type, displayName: body.displayName });
      return true;
    }

    // GET /v2/actors/:id
    const actorMatch = path.match(/^\/v2\/actors\/([^/]+)$/);
    if (method === 'GET' && actorMatch) {
      const id = actorMatch[1];
      const db = getDb();
      const actor = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(id, tenantId);
      if (!actor) { sendV2Error(res, 404, 'actor not found'); return true; }
      sendV2Json(res, 200, {
        id: actor.id, type: actor.type, displayName: actor.display_name,
        email: actor.email, commHandle: actor.comm_handle,
        agentModel: actor.agent_model, agentEndpoint: actor.agent_endpoint,
        capabilities: JSON.parse(actor.capabilities_json || '[]'),
        contextWindow: actor.context_window, autonomyLevel: actor.autonomy_level,
        active: Boolean(actor.active), createdAt: actor.created_at, updatedAt: actor.updated_at,
      });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // Agent Integration Protocol
    // ════════════════════════════════════════════════════════════

    // POST /v2/agents/callback
    if (method === 'POST' && path === '/v2/agents/callback') {
      const rawBody = await readBody(req);
      const body = AgentCallbackSchema.parse(rawBody);

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

      sendV2Json(res, 200, { ok: true, eventType });
      return true;
    }

    // POST /v2/agents/dispatch
    if (method === 'POST' && path === '/v2/agents/dispatch') {
      const rawBody = await readBody(req);
      const body = TaskDispatchSchema.parse(rawBody);
      const db = getDb();

      const agent = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ? AND type = ?')
        .get(body.agentId, tenantId, 'ai-agent');
      if (!agent) { sendV2Error(res, 404, 'agent not found'); return true; }
      if (!agent.agent_endpoint) { sendV2Error(res, 422, 'agent has no endpoint configured'); return true; }

      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?')
        .get(body.taskId, tenantId);
      if (!task) { sendV2Error(res, 404, 'task not found'); return true; }

      // ── Context injection（W4 完整版，替换旧的 inline memory 查询）──
      const dispatchPayload = await buildAgentContext({
        taskId: body.taskId,
        tenantId,
        agentId: body.agentId,
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
        if (!resp.ok) {
          sendV2Error(res, 502, `agent returned ${resp.status}`);
          return true;
        }
      } catch (err) {
        sendV2Error(res, 502, `agent unreachable: ${err.message}`);
        return true;
      }

      await emit('task.claimed', {
        tenantId, taskId: body.taskId, actorId: body.agentId, source: 'scheduler',
      }, { source: 'ui' });

      sendV2Json(res, 200, {
        ok: true,
        agentId: body.agentId,
        taskId: body.taskId,
        memoryStats: dispatchPayload.context?.memoryStats,
      });
      return true;
    }

    // POST /v2/agents/standup
    // agent 与人类共用同一个 standup reducer（actor 抽象体现）
    if (method === 'POST' && path === '/v2/agents/standup') {
      const rawBody = await readBody(req);
      const body = StandupSchema.parse(rawBody);

      await emit('standup.submitted', {
        tenantId,
        actorId: body.agentId,
        date: body.date,
        yesterday: body.yesterday,
        today: body.today,
        blockers: body.blockers || null,
      }, { source: 'agent' });

      console.log(`[v2] standup submitted by agent ${body.agentId} for ${body.date}`);
      sendV2Json(res, 200, { ok: true, agentId: body.agentId, date: body.date });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // SSE 实时事件流
    // ════════════════════════════════════════════════════════════

    if (method === 'GET' && path === '/v2/events/stream') {
      const sinceHours = Number(url.searchParams.get('since_hours') || 24);

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'access-control-allow-origin': '*',
        'x-accel-buffering': 'no',
      });

      // 历史事件
      const db = getDb();
      const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      const history = db.prepare(`
        SELECT * FROM events WHERE tenant_id = ? AND created_at >= ? ORDER BY id ASC LIMIT 200
      `).all(tenantId, cutoff);

      for (const row of history) {
        res.write(`data: ${JSON.stringify({ id: row.id, type: row.type, payload: JSON.parse(row.payload_json), ts: row.created_at })}\n\n`);
      }

      // 实时订阅
      const { emitter } = await import('../events/bus.js');
      const handler = (type, payload) => {
        if (payload.tenantId !== tenantId && tenantId !== 'default') return;
        try { res.write(`data: ${JSON.stringify({ type, payload, ts: new Date().toISOString() })}\n\n`); } catch {}
      };
      emitter.on('*', handler);

      // heartbeat + 清理
      const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
      }, 30_000);
      req.on('close', () => { emitter.removeListener('*', handler); clearInterval(heartbeat); });
      req.on('end', () => { emitter.removeListener('*', handler); clearInterval(heartbeat); });

      return true;
    }

    // 未匹配的 /v2/* 路由
    sendV2Error(res, 404, `v2 route not found: ${method} ${path}`);
    return true;

  } catch (err) {
    if (err instanceof z.ZodError) {
      sendV2Error(res, 400, 'validation error', err.errors);
      return true;
    }
    console.error('[v2] error:', method, path, err.message);
    sendV2Error(res, 500, err.message || 'internal error');
    return true;
  }
}
