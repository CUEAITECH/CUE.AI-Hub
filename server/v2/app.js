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
import {
  gatewayAuth,
  extractApiKey,
  auditLog,
  ensureGatewayTables,
} from '../middleware/apiGateway.js';
import logger from '../logger.js';

// ── 鉴权豁免路径（无需 API Key）────────────────────────────
const V2_AUTH_EXEMPT = new Set([
  '/v2/health',
  '/v2/info',
  '/v2/openapi.json',
  '/v2/gateway/validate',
]);

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

// Actor-aware 自动派发：不需要指定 agentId，由推荐引擎选择
const AutoDispatchSchema = z.object({
  taskId: z.string(),
  contextOverride: z.record(z.any()).optional(),
  dryRun: z.boolean().optional().default(false),  // true = 只返回推荐，不实际 dispatch
});

const StandupSchema = z.object({
  agentId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  yesterday: z.string().min(1),
  today: z.string().min(1),
  blockers: z.string().optional(),
});

const MemoryCreateSchema = z.object({
  kind: z.enum(['convention', 'decision', 'gotcha', 'pattern', 'taboo', 'success-case', 'failure-case']),
  body: z.string().min(10).max(2000),
  projectId: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  evidenceRefs: z.string().optional(),  // 关联的 PR/任务 URL，逗号分隔
});

const MemoryUpdateSchema = z.object({
  body: z.string().min(10).max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  supersededBy: z.number().int().optional(),  // 被哪条记录取代（软删除）
});

// ── 辅助函数 ─────────────────────────────────────────────────
function tryParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

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
  const startTs = Date.now();

  // ── CORS preflight ───────────────────────────────────────────
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-cue-api-key, x-api-key, authorization, x-tenant-id',
    });
    res.end();
    return true;
  }

  // ── 拦截 writeHead 以记录响应状态码 ──────────────────────────
  let _capturedStatus = 200;
  const _origWriteHead = res.writeHead.bind(res);
  res.writeHead = (code, ...rest) => { _capturedStatus = code; return _origWriteHead(code, ...rest); };

  // ── API Gateway 鉴权 ─────────────────────────────────────────
  // tenantId 优先来自鉴权结果（API Key 携带 tenantId）
  let tenantId = req.headers['x-tenant-id'] || 'default';
  let _authKeyPrefix = null;

  if (!V2_AUTH_EXEMPT.has(path)) {
    const rawKey = extractApiKey(req);

    if (rawKey?.startsWith('cue_')) {
      // V2 API Key — 完整 gateway 校验（rate limit + 多租户隔离 + 审计）
      const auth = await gatewayAuth(req, tenantId !== 'default' ? tenantId : undefined);
      if (!auth.ok) {
        const headers = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
        if (auth.errorCode === 429 && auth.rateLimitInfo) {
          headers['x-ratelimit-limit']     = String(auth.rateLimitInfo.limit);
          headers['x-ratelimit-remaining'] = '0';
          headers['x-ratelimit-reset']     = String(Math.ceil(auth.rateLimitInfo.resetAt / 1000));
        }
        res.writeHead(auth.errorCode, headers);
        res.end(JSON.stringify({ error: auth.errorMessage }));
        return true;
      }
      // 覆盖 tenantId：API Key 携带的 tenantId 优先，防止跨租户伪造
      tenantId = auth.tenantId;
      _authKeyPrefix = auth.keyPrefix;

      // 在响应头中暴露剩余 rate limit 额度
      if (auth.rateLimitInfo) {
        _origWriteHead; // 确保已绑定原始方法
        const rl = auth.rateLimitInfo;
        // 等响应发出时再写 — 通过 writeHead 拦截保证正确顺序（已在上面绑定）
        const _prevWriteHead2 = res.writeHead.bind(res);
        res.writeHead = (code, hdrs, ...rest) => {
          const merged = typeof hdrs === 'object' ? hdrs : {};
          merged['x-ratelimit-limit']     = String(rl.limit);
          merged['x-ratelimit-remaining'] = String(rl.remaining);
          merged['x-ratelimit-reset']     = String(Math.ceil(rl.resetAt / 1000));
          return _prevWriteHead2(code, merged, ...rest);
        };
      }
    } else {
      // Legacy CUE_API_KEY（环境变量配置的固定 key，向下兼容 v1）
      const cueApiKey = process.env.CUE_API_KEY;
      if (cueApiKey) {
        const legacyProvided = req.headers?.['x-cue-api-key'];
        if (legacyProvided !== cueApiKey) {
          sendV2Error(res, 401, 'invalid API key — use Authorization: Bearer cue_xxx or X-CUE-API-Key');
          return true;
        }
      }
      // CUE_API_KEY 未配置 → 开发模式，放行所有请求（与 v1 行为一致）
    }
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
        logger.info(`[v2] AI agent registered: ${id} (${body.displayName})`);
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

    // POST /v2/agents/auto-dispatch — Actor-aware 自动派发（#25 Part Q.1）
    // 由推荐引擎（recommender.js）选出最合适的 actor（人类或 AI Agent）
    // 选出 AI Agent → 自动 dispatch 到 endpoint
    // 选出人类      → 分配 actor_id，通过 WeCom 通知（无需 HTTP dispatch）
    if (method === 'POST' && path === '/v2/agents/auto-dispatch') {
      const rawBody = await readBody(req);
      const body = AutoDispatchSchema.parse(rawBody);
      const db = getDb();

      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?')
        .get(body.taskId, tenantId);
      if (!task) { sendV2Error(res, 404, 'task not found'); return true; }
      if (task.state !== 'pending') {
        sendV2Error(res, 409, `task state is '${task.state}', only pending tasks can be auto-dispatched`);
        return true;
      }

      // ── 推荐引擎：全 actor 评分（不生成 LLM 解释，加速）──
      const { recommendForTask } = await import('../services/recommender.js');
      const result = await recommendForTask({
        taskId: body.taskId,
        tenantId,
        options: { explain: false, limit: 1 },
      });

      if (!result.recommendations || result.recommendations.length === 0) {
        sendV2Error(res, 422, 'recommender returned no candidates');
        return true;
      }

      const top = result.recommendations[0];
      const actorId = top.actorId;
      const actorType = top.type;      // 'human' | 'ai-agent'
      const score = top.score;

      if (body.dryRun) {
        sendV2Json(res, 200, {
          ok: true, dryRun: true,
          recommendation: { actorId, actorType, score, breakdown: top.scoreBreakdown },
        });
        return true;
      }

      // ── 人类 actor：直接分配，发企微通知 ───────────────────
      if (actorType === 'human') {
        await dbWrite(db, () => {
          db.prepare(
            `UPDATE tasks SET actor_id = ?, state = 'claimed', updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`
          ).run(actorId, body.taskId, tenantId);
        });
        await emit('task.claimed', { tenantId, taskId: body.taskId, actorId, source: 'auto-dispatch' }, { source: 'v2' });
        sendV2Json(res, 200, { ok: true, actorType: 'human', actorId, score, taskId: body.taskId });
        return true;
      }

      // ── AI Agent：拿取 endpoint 发 dispatch 请求 ─────────────
      const agent = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(actorId, tenantId);
      if (!agent?.agent_endpoint) {
        sendV2Error(res, 422, `top agent '${actorId}' has no endpoint; cannot auto-dispatch`);
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
        if (!resp.ok) { sendV2Error(res, 502, `agent returned ${resp.status}`); return true; }
      } catch (err) {
        sendV2Error(res, 502, `agent unreachable: ${err.message}`);
        return true;
      }

      await emit('task.claimed', { tenantId, taskId: body.taskId, actorId, source: 'auto-dispatch' }, { source: 'v2' });
      sendV2Json(res, 200, {
        ok: true, actorType: 'ai-agent', actorId, score, taskId: body.taskId,
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

      logger.info(`[v2] standup submitted by agent ${body.agentId} for ${body.date}`);
      sendV2Json(res, 200, { ok: true, agentId: body.agentId, date: body.date });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // Memory 端点（project_memory CRUD）
    // ════════════════════════════════════════════════════════════

    // GET /v2/memory?projectId=&kind=&limit=
    if (method === 'GET' && path === '/v2/memory') {
      const db = getDb();
      const projectId = url.searchParams.get('projectId') || null;
      const kind      = url.searchParams.get('kind') || null;
      const limit     = Math.min(Number(url.searchParams.get('limit') || 50), 200);

      let query = db.prepare(`
        SELECT * FROM project_memory
        WHERE tenant_id = ?
          AND (? IS NULL OR project_id = ?)
          AND (? IS NULL OR kind = ?)
          AND superseded_by IS NULL
        ORDER BY confidence DESC, id DESC
        LIMIT ?
      `);
      const rows = query.all(tenantId, projectId, projectId, kind, kind, limit);

      sendV2Json(res, 200, rows.map(m => ({
        id: m.id,
        kind: m.kind,
        body: m.body,
        projectId: m.project_id,
        confidence: m.confidence,
        source: m.source,
        evidenceRefs: m.evidence_refs,
        validatedAt: m.validated_at,
        createdAt: m.created_at,
      })));
      return true;
    }

    // POST /v2/memory — 手动添加 memory 条目
    if (method === 'POST' && path === '/v2/memory') {
      const rawBody = await readBody(req);
      const body = MemoryCreateSchema.parse(rawBody);
      const now = new Date().toISOString();

      const id = await dbWrite('v2:memory.create', (db) => {
        const result = db.prepare(`
          INSERT INTO project_memory
            (tenant_id, project_id, kind, body, confidence, source, evidence_refs, created_at)
          VALUES (?, ?, ?, ?, ?, 'human-added', ?, ?)
        `).run(
          tenantId,
          body.projectId || null,
          body.kind,
          body.body,
          body.confidence,
          body.evidenceRefs || null,
          now
        );
        return result.lastInsertRowid;
      });

      // 向量索引（sqlite-vec 就绪时嵌入写入，降级时静默跳过）
      const { indexMemoryEntry } = await import('../services/vectorStore.js');
      indexMemoryEntry(getDb(), { memoryId: Number(id), text: body.body });

      logger.info(`[v2] memory created: id=${id} kind=${body.kind} tenant=${tenantId}`);
      sendV2Json(res, 201, { id, kind: body.kind, body: body.body, source: 'human-added', createdAt: now });
      return true;
    }

    // PATCH /v2/memory/:id — 更新或标记废弃
    const memoryMatch = path.match(/^\/v2\/memory\/(\d+)$/);
    if (method === 'PATCH' && memoryMatch) {
      const memId = Number(memoryMatch[1]);
      const rawBody = await readBody(req);
      const body = MemoryUpdateSchema.parse(rawBody);
      const db = getDb();

      const existing = db.prepare('SELECT * FROM project_memory WHERE id = ? AND tenant_id = ?').get(memId, tenantId);
      if (!existing) { sendV2Error(res, 404, 'memory entry not found'); return true; }

      const updates = [];
      const params = [];
      if (body.body !== undefined)        { updates.push('body = ?');          params.push(body.body); }
      if (body.confidence !== undefined)  { updates.push('confidence = ?');    params.push(body.confidence); }
      if (body.supersededBy !== undefined){ updates.push('superseded_by = ?'); params.push(body.supersededBy); }

      if (updates.length === 0) { sendV2Error(res, 400, 'no fields to update'); return true; }

      await dbWrite('v2:memory.update', (db) => {
        db.prepare(`UPDATE project_memory SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`)
          .run(...params, memId, tenantId);
      });

      // 若 body 变更，重建向量索引
      if (body.body !== undefined) {
        const { indexMemoryEntry } = await import('../services/vectorStore.js');
        indexMemoryEntry(getDb(), { memoryId: memId, text: body.body });
      }

      const updated = db.prepare('SELECT * FROM project_memory WHERE id = ?').get(memId);
      sendV2Json(res, 200, { id: updated.id, kind: updated.kind, body: updated.body, confidence: updated.confidence, supersededBy: updated.superseded_by });
      return true;
    }

    // DELETE /v2/memory/:id — 标记废弃（软删除，设置 superseded_by = self）
    if (method === 'DELETE' && memoryMatch) {
      const memId = Number(memoryMatch[1]);
      const db = getDb();
      const existing = db.prepare('SELECT id FROM project_memory WHERE id = ? AND tenant_id = ?').get(memId, tenantId);
      if (!existing) { sendV2Error(res, 404, 'memory entry not found'); return true; }

      await dbWrite('v2:memory.delete', (db) => {
        // 软删除：superseded_by 指向自身（规约：过滤 superseded_by IS NULL 时自动排除）
        db.prepare('UPDATE project_memory SET superseded_by = ? WHERE id = ? AND tenant_id = ?')
          .run(memId, memId, tenantId);
      });

      sendV2Json(res, 200, { ok: true, id: memId, superseded: true });
      return true;
    }

    // GET /v2/memory/stats — 按 kind 统计
    if (method === 'GET' && path === '/v2/memory/stats') {
      const db = getDb();
      const rows = db.prepare(`
        SELECT kind, COUNT(*) as count, AVG(confidence) as avgConfidence
        FROM project_memory
        WHERE tenant_id = ? AND superseded_by IS NULL
        GROUP BY kind
        ORDER BY count DESC
      `).all(tenantId);
      sendV2Json(res, 200, { stats: rows, total: rows.reduce((s, r) => s + r.count, 0) });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // PR 描述生成端点
    // ════════════════════════════════════════════════════════════

    // POST /v2/pulls/generate-description
    if (method === 'POST' && path === '/v2/pulls/generate-description') {
      const { generatePRDescription } = await import('../services/prPromptGenerator.js');
      const rawBody = await readBody(req);
      const schema = z.object({
        taskId:      z.string(),
        branchName:  z.string().optional(),
        diffSummary: z.string().max(3000).optional(),
        artifacts:   z.array(z.string()).optional(),
      });
      const body = schema.parse(rawBody);

      const { body: description, source } = await generatePRDescription({
        taskId: body.taskId,
        tenantId,
        branchName:  body.branchName,
        diffSummary: body.diffSummary,
        artifacts:   body.artifacts || [],
      });

      sendV2Json(res, 200, { description, source, taskId: body.taskId });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // Review 端点（Map-Reduce 审阅）
    // ════════════════════════════════════════════════════════════

    // POST /v2/reviews/trigger — 触发 PR Map-Reduce review
    if (method === 'POST' && path === '/v2/reviews/trigger') {
      const { fetchAndParseDiff } = await import('../services/diffAnalyzer.js');
      const { mapReduceReview } = await import('../services/mapReduceReviewer.js');

      const schema = z.object({
        pullId:    z.string(),                       // pulls 表主键
        taskId:    z.string().optional(),            // 关联任务
        owner:     z.string().optional(),            // GitHub owner（可从 pull 记录读）
        repo:      z.string().optional(),
        prNumber:  z.number().int().positive().optional(),
        rawDiff:   z.string().optional(),            // 直接传 diff 文本（测试用）
        maxFiles:  z.number().int().min(1).max(50).default(20),
      });
      const rawBody = await readBody(req);
      const body = schema.parse(rawBody);
      const db = getDb();

      // 读取 pull 记录（获取 owner/repo/prNumber/title/body）
      const pull = db.prepare('SELECT * FROM pulls WHERE id = ? AND tenant_id = ?').get(body.pullId, tenantId);
      if (!pull) { sendV2Error(res, 404, 'pull not found'); return true; }

      // 读取关联任务的 acceptance（若有）
      let acceptance = '';
      if (body.taskId) {
        const task = db.prepare('SELECT acceptance FROM tasks WHERE id = ? AND tenant_id = ?').get(body.taskId, tenantId);
        acceptance = task?.acceptance || '';
      }
      if (!acceptance && pull.body) {
        // 从 PR body 中提取 AC checklist
        const acMatch = pull.body.match(/验收清单[（(]AC[)）][\s\S]*?(?=\n##|\n---|\n$|$)/i);
        if (acMatch) acceptance = acMatch[0];
      }

      // 读取 project_memory（context injection）
      let memory = [];
      if (pull.project_id) {
        memory = db.prepare(`
          SELECT kind, body, confidence FROM project_memory
          WHERE tenant_id = ? AND (project_id = ? OR project_id IS NULL)
            AND kind IN ('convention','decision','gotcha','taboo')
            AND superseded_by IS NULL
          ORDER BY confidence DESC LIMIT 15
        `).all(tenantId, pull.project_id);
      }

      // 获取 diff
      let files;
      if (body.rawDiff) {
        const { parseDiffText } = await import('../services/diffAnalyzer.js');
        files = parseDiffText(body.rawDiff, { maxFileDiffChars: 6000 });
      } else {
        // 从 raw_json 解析出 owner/repo/number，或使用请求体参数
        let rawJson = {};
        try { rawJson = JSON.parse(pull.raw_json || '{}'); } catch {}
        const owner    = body.owner || rawJson.head?.repo?.owner?.login;
        const repo     = body.repo  || rawJson.head?.repo?.name;
        const prNumber = body.prNumber || pull.number;

        if (!owner || !repo || !prNumber) {
          sendV2Error(res, 422, 'cannot determine owner/repo/prNumber — pass them explicitly or store in raw_json');
          return true;
        }

        const diffResult = await fetchAndParseDiff({ owner, repo, prNumber, options: { maxFiles: body.maxFiles } });
        files = diffResult.files;
      }

      if (files.length === 0) {
        sendV2Json(res, 200, { ok: true, message: 'no reviewable files in diff', level: 'Pass' });
        return true;
      }

      // 运行 Map-Reduce
      const result = await mapReduceReview({
        files,
        prTitle:    pull.title || '(无标题)',
        acceptance,
        memory,
        tenantId,
        pullId:     body.pullId,
        taskId:     body.taskId,
      });

      // 推送企微通知（Block/Escalate 时）
      if (result.level === 'Block' || result.level === 'Escalate') {
        const { broadcast } = await import('../adapters/index.js');
        await broadcast(
          `🚨 **PR Review ${result.level}**\n\n` +
          `PR：\`${pull.title || body.pullId}\`\n` +
          `问题：${result.suggestion}\n` +
          `共 ${result.stats.critical} critical / ${result.stats.major} major issue`,
          { urgency: 'high' }
        ).catch(() => {});
      }

      sendV2Json(res, 200, { ok: true, ...result });
      return true;
    }

    // GET /v2/reviews?pullId=&taskId=&limit=
    if (method === 'GET' && path === '/v2/reviews') {
      const db = getDb();
      const pullId = url.searchParams.get('pullId') || null;
      const taskId = url.searchParams.get('taskId') || null;
      const limit  = Math.min(Number(url.searchParams.get('limit') || 20), 100);

      const rows = db.prepare(`
        SELECT * FROM reviews
        WHERE tenant_id = ?
          AND (? IS NULL OR pull_id = ?)
          AND (? IS NULL OR task_id = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `).all(tenantId, pullId, pullId, taskId, taskId, limit);

      sendV2Json(res, 200, rows.map(r => ({
        id: r.id,
        pullId: r.pull_id,
        taskId: r.task_id,
        source: r.source,
        level: r.level,
        suggestion: r.suggestion,
        compliance: tryParseJson(r.compliance_json, {}),
        issueCount: (() => { try { return JSON.parse(r.findings_json || '[]').length; } catch { return 0; } })(),
        createdAt: r.created_at,
      })));
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // 推荐端点（W7 三阶段管道）
    // ════════════════════════════════════════════════════════════

    // POST /v2/recommend — 为任务推荐 actor
    if (method === 'POST' && path === '/v2/recommend') {
      const { recommendForTask } = await import('../services/recommender.js');
      const schema = z.object({
        taskId:     z.string(),
        topK:       z.number().int().min(1).max(20).default(5),
        actorType:  z.enum(['all', 'human', 'ai-agent']).default('all'),
        minScore:   z.number().min(0).max(100).default(20),
        explain:    z.boolean().default(true),
      });
      const body = schema.parse(await readBody(req));

      const result = await recommendForTask({
        taskId: body.taskId,
        tenantId,
        options: {
          topK:      body.topK,
          actorType: body.actorType,
          minScore:  body.minScore,
          explain:   body.explain,
        },
      });

      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/recommend/batch — 批量为未分配任务推荐
    if (method === 'POST' && path === '/v2/recommend/batch') {
      const { batchRecommend } = await import('../services/recommender.js');
      const schema = z.object({
        projectId:  z.string().optional(),
        actorType:  z.enum(['all', 'human', 'ai-agent']).default('all'),
        minScore:   z.number().min(0).max(100).default(20),
      });
      const body = schema.parse(await readBody(req));

      const result = await batchRecommend({
        tenantId,
        projectId: body.projectId,
        options: { actorType: body.actorType, minScore: body.minScore },
      });

      sendV2Json(res, 200, result);
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // 三端同步端点（W8 doc ↔ PR ↔ task）
    // ════════════════════════════════════════════════════════════

    // POST /v2/sync/webhook — 接收 GitHub PR Webhook（@octokit/webhooks 验签）
    if (method === 'POST' && path === '/v2/sync/webhook') {
      const { handlePRWebhook } = await import('../services/syncBroker.js');
      const { Webhooks } = await import('@octokit/webhooks');

      // 读取原始 body（验签需要原始字节，不能先 JSON.parse）
      const rawBody = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });

      // 签名验证（配置了 GITHUB_WEBHOOK_SECRET 时强制验签）
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
      if (webhookSecret) {
        const signature = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'] || '';
        const wh = new Webhooks({ secret: webhookSecret });
        const deliveryId = req.headers['x-github-delivery'] || `manual-${Date.now()}`;
        const eventName  = req.headers['x-github-event'] || 'push';

        try {
          // verifyAndReceive：验签 + 事件分发（如无注册 handler 则只验签）
          await wh.verifyAndReceive({ id: deliveryId, name: eventName, signature, payload: rawBody });
        } catch (verifyErr) {
          logger.warn('[v2/sync/webhook] signature verification failed:', verifyErr.message);
          sendV2Error(res, 401, 'GitHub webhook signature verification failed');
          return true;
        }
      }

      // 解析 payload
      let payload;
      try { payload = JSON.parse(rawBody); }
      catch { sendV2Error(res, 400, 'invalid JSON payload'); return true; }

      // 解析 X-GitHub-Event header
      const event = req.headers['x-github-event'] || payload.action || 'unknown';

      const result = await handlePRWebhook({ tenantId, event, payload });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/sync/resync — 手动触发全量 PR-Task 链接重建
    if (method === 'POST' && path === '/v2/sync/resync') {
      const { resyncAllPRLinks } = await import('../services/syncBroker.js');
      const schema = z.object({
        projectId: z.string().optional(),
      });
      const body = schema.parse(await readBody(req));

      const result = await resyncAllPRLinks({ tenantId, projectId: body.projectId });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/sync/writeback — 手动触发文档回写
    if (method === 'POST' && path === '/v2/sync/writeback') {
      const { writeProgressDoc } = await import('../services/syncBroker.js');
      const schema = z.object({
        projectId: z.string(),
      });
      const body = schema.parse(await readBody(req));

      const result = await writeProgressDoc({ tenantId, projectId: body.projectId });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/sync/links — 查询 PR-Task 链接关系
    if (method === 'GET' && path === '/v2/sync/links') {
      const db = getDb();
      const projectId = url.searchParams.get('project_id');
      const pullId    = url.searchParams.get('pull_id');
      const taskId    = url.searchParams.get('task_id');

      let q = `
        SELECT ptl.pull_id, ptl.task_id,
               p.title as pr_title, p.state as pr_state, p.number as pr_number,
               t.title as task_title, t.state as task_state
        FROM pull_task_links ptl
        JOIN pulls p ON ptl.pull_id = p.id AND p.tenant_id = ?
        JOIN tasks t ON ptl.task_id = t.id AND t.tenant_id = ?
        WHERE 1=1
      `;
      const params = [tenantId, tenantId];
      if (pullId)    { q += ' AND ptl.pull_id = ?';    params.push(pullId); }
      if (taskId)    { q += ' AND ptl.task_id = ?';    params.push(taskId); }
      if (projectId) { q += ' AND p.project_id = ?';   params.push(projectId); }
      q += ' ORDER BY p.number DESC LIMIT 100';

      const links = db.prepare(q).all(...params);
      sendV2Json(res, 200, { links, total: links.length });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // Outcome Ledger 端点（W9 持续学习）
    // ════════════════════════════════════════════════════════════

    // POST /v2/outcomes — 手动记录一条 outcome
    if (method === 'POST' && path === '/v2/outcomes') {
      const { recordOutcome } = await import('../services/outcomeLedger.js');
      const schema = z.object({
        actionType:    z.string(),
        actionRefId:   z.string(),
        outcomeSignal: z.string().min(1),
        polarity:      z.union([z.literal(1), z.literal(-1), z.literal(0)]),
        evidence:      z.record(z.any()).optional(),
        observer:      z.enum(['auto-rule', 'human-label', 'agent-self']).default('human-label'),
        lagHours:      z.number().int().nonnegative().optional(),
      });
      const body = schema.parse(await readBody(req));
      const id = await recordOutcome({ tenantId, ...body });
      sendV2Json(res, 201, { id, ok: true });
      return true;
    }

    // GET /v2/outcomes — 查询 outcomes（过滤/分页）
    if (method === 'GET' && path === '/v2/outcomes') {
      const { queryOutcomes } = await import('../services/outcomeLedger.js');
      const actionType = url.searchParams.get('action_type') || undefined;
      const polarity   = url.searchParams.has('polarity') ? Number(url.searchParams.get('polarity')) : undefined;
      const observer   = url.searchParams.get('observer') || undefined;
      const since      = url.searchParams.get('since') || undefined;
      const limit      = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const offset     = Number(url.searchParams.get('offset') || 0);

      const result = queryOutcomes({ tenantId, actionType, polarity, observer, since, limit, offset });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/outcomes/stats — 聚合统计
    if (method === 'GET' && path === '/v2/outcomes/stats') {
      const { computeStats } = await import('../services/outcomeLedger.js');
      const since      = url.searchParams.get('since') || undefined;
      const actionType = url.searchParams.get('action_type') || undefined;
      const result = computeStats({ tenantId, since, actionType });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/outcomes/auto-label — 批量自动打标
    if (method === 'POST' && path === '/v2/outcomes/auto-label') {
      const { batchAutoLabel } = await import('../services/outcomeLedger.js');
      const schema = z.object({
        since: z.string().optional(), // ISO datetime
      });
      const body = schema.parse(await readBody(req));
      const result = await batchAutoLabel({ tenantId, since: body.since });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/outcomes/label-task — 为单个任务打标
    if (method === 'POST' && path === '/v2/outcomes/label-task') {
      const { autoLabelTaskOutcome } = await import('../services/outcomeLedger.js');
      const schema = z.object({ taskId: z.string() });
      const body = schema.parse(await readBody(req));
      const id = await autoLabelTaskOutcome({ tenantId, taskId: body.taskId });
      sendV2Json(res, 200, { id, ok: true });
      return true;
    }

    // POST /v2/outcomes/label-review — 为单个审阅打标
    if (method === 'POST' && path === '/v2/outcomes/label-review') {
      const { autoLabelReviewOutcome } = await import('../services/outcomeLedger.js');
      const schema = z.object({ reviewId: z.string() });
      const body = schema.parse(await readBody(req));
      const id = await autoLabelReviewOutcome({ tenantId, reviewId: body.reviewId });
      sendV2Json(res, 200, { id, ok: true });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // Active Learning Queue 端点（W10）
    // ════════════════════════════════════════════════════════════

    // POST /v2/learning/enqueue — 手动推入队列
    if (method === 'POST' && path === '/v2/learning/enqueue') {
      const { enqueue } = await import('../services/activeLearning.js');
      const schema = z.object({
        actionType:   z.string(),
        actionRefId:  z.string(),
        reason:       z.string().min(1),
        priority:     z.number().int().min(0).max(10).default(5),
        aiConfidence: z.number().min(0).max(1).default(0.5),  // 新增：AI 置信度
        metadata:     z.record(z.any()).optional(),
      });
      const body = schema.parse(await readBody(req));
      const id = await enqueue({ tenantId, ...body });
      sendV2Json(res, id !== null ? 201 : 200, { id, ok: true, enqueued: id !== null });
      return true;
    }

    // GET /v2/learning/queue — 查询队列
    if (method === 'GET' && path === '/v2/learning/queue') {
      const { dequeue } = await import('../services/activeLearning.js');
      const status     = (url.searchParams.get('status') || 'pending');
      const actionType = url.searchParams.get('action_type') || undefined;
      const limit      = Math.min(Number(url.searchParams.get('limit') || 20), 100);
      const offset     = Number(url.searchParams.get('offset') || 0);
      const result = dequeue({ tenantId, status, actionType, limit, offset });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/learning/label — 人工打标
    if (method === 'POST' && path === '/v2/learning/label') {
      const { label } = await import('../services/activeLearning.js');
      const schema = z.object({
        queueId:   z.number().int(),
        polarity:  z.union([z.literal(1), z.literal(-1), z.literal(0)]),
        signal:    z.string().min(1),
        labeledBy: z.string().optional(),
      });
      const body = schema.parse(await readBody(req));
      const result = await label({ tenantId, ...body });
      sendV2Json(res, 200, { ...result, ok: true });
      return true;
    }

    // POST /v2/learning/dismiss — 忽略队列条目
    if (method === 'POST' && path === '/v2/learning/dismiss') {
      const { dismiss } = await import('../services/activeLearning.js');
      const schema = z.object({ queueId: z.number().int() });
      const body = schema.parse(await readBody(req));
      const ok = await dismiss({ tenantId, queueId: body.queueId });
      sendV2Json(res, 200, { ok });
      return true;
    }

    // GET /v2/learning/stats — 队列统计
    if (method === 'GET' && path === '/v2/learning/stats') {
      const { queueStats } = await import('../services/activeLearning.js');
      const result = queueStats({ tenantId });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/learning/auto-enqueue — 规则自动入队
    if (method === 'POST' && path === '/v2/learning/auto-enqueue') {
      const { autoEnqueue } = await import('../services/activeLearning.js');
      const schema = z.object({ since: z.string().optional() });
      const body = schema.parse(await readBody(req));
      const result = await autoEnqueue({ tenantId, since: body.since });
      sendV2Json(res, 200, result);
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // 可观测性健康度面板（W10）
    // ════════════════════════════════════════════════════════════

    // GET /v2/health — 系统健康度聚合
    if (method === 'GET' && path === '/v2/health') {
      const { computeHealth } = await import('../services/observability.js');
      const since = url.searchParams.get('since') || undefined;
      const result = computeHealth({ tenantId, since });
      sendV2Json(res, 200, result);
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // SPACE 指标 + 风险传播（W11）
    // ════════════════════════════════════════════════════════════

    // GET /v2/space — SPACE 健康指标
    if (method === 'GET' && path === '/v2/space') {
      const { computeSpaceMetrics } = await import('../services/spaceMetrics.js');
      const projectId  = url.searchParams.get('project_id') || undefined;
      const windowDays = Number(url.searchParams.get('window_days') || 14);
      const result = computeSpaceMetrics({ tenantId, projectId, windowDays });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/space/actors — 按成员维度的 SPACE 贡献
    if (method === 'GET' && path === '/v2/space/actors') {
      const { computePerActorStats } = await import('../services/spaceMetrics.js');
      const projectId  = url.searchParams.get('project_id') || undefined;
      const windowDays = Number(url.searchParams.get('window_days') || 14);
      const result = computePerActorStats({ tenantId, projectId, windowDays });
      sendV2Json(res, 200, { actors: result, total: result.length });
      return true;
    }

    // GET /v2/risks — 扫描项目风险
    if (method === 'GET' && path === '/v2/risks') {
      const { scanRisks } = await import('../services/riskPropagation.js');
      const projectId = url.searchParams.get('project_id') || undefined;
      const result = scanRisks({ tenantId, projectId });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/risks/propagate — 将高风险信号写回任务 signal 字段
    if (method === 'POST' && path === '/v2/risks/propagate') {
      const { propagateRiskSignals } = await import('../services/riskPropagation.js');
      const schema = z.object({
        projectId: z.string().optional(),
        threshold: z.number().int().min(1).max(10).default(7),
      });
      const body = schema.parse(await readBody(req));
      const result = await propagateRiskSignals({ tenantId, ...body });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/risks/task/:taskId — 单任务风险查询
    if (method === 'GET' && path.startsWith('/v2/risks/task/')) {
      const { getRiskForTask } = await import('../services/riskPropagation.js');
      const taskId = path.slice('/v2/risks/task/'.length);
      const result = getRiskForTask({ tenantId, taskId });
      sendV2Json(res, 200, result);
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // Runbook + 自动化告警（W12）
    // ════════════════════════════════════════════════════════════

    // GET /v2/runbooks — 列出内置 runbook 定义
    if (method === 'GET' && path === '/v2/runbooks') {
      const { BUILTIN_RUNBOOKS } = await import('../services/runbook.js');
      sendV2Json(res, 200, { runbooks: BUILTIN_RUNBOOKS, total: BUILTIN_RUNBOOKS.length });
      return true;
    }

    // GET /v2/alerts/evaluate — 实时评估告警（不写入 DB）
    if (method === 'GET' && path === '/v2/alerts/evaluate') {
      const { evaluateAlerts } = await import('../services/runbook.js');
      const result = evaluateAlerts({ tenantId });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/alerts/cycle — 完整告警扫描 + 持久化
    if (method === 'POST' && path === '/v2/alerts/cycle') {
      const { runAlertCycle } = await import('../services/runbook.js');
      const schema = z.object({
        cooldownHours: z.number().int().min(0).max(168).default(4),
      });
      const body = schema.parse(await readBody(req));
      const result = await runAlertCycle({ tenantId, cooldownHours: body.cooldownHours });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/alerts — 查询告警历史
    if (method === 'GET' && path === '/v2/alerts') {
      const { queryAlertHistory, ensureAlertsTable } = await import('../services/runbook.js');
      ensureAlertsTable();
      const severity     = url.searchParams.get('severity') || undefined;
      const ackParam     = url.searchParams.get('acknowledged');
      const acknowledged = ackParam !== null ? ackParam === 'true' : undefined;
      const limit  = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const offset = Number(url.searchParams.get('offset') || 0);
      const result = queryAlertHistory({ tenantId, severity, acknowledged, limit, offset });
      sendV2Json(res, 200, result);
      return true;
    }

    // POST /v2/alerts/:id/ack — 确认告警
    if (method === 'POST' && path.match(/^\/v2\/alerts\/\d+\/ack$/)) {
      const { acknowledgeAlert } = await import('../services/runbook.js');
      const alertId = Number(path.split('/')[3]);
      const schema = z.object({ acknowledgedBy: z.string().optional() });
      const body = schema.parse(await readBody(req));
      const ok = await acknowledgeAlert({ tenantId, alertId, acknowledgedBy: body.acknowledgedBy });
      sendV2Json(res, 200, { ok });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // ════════════════════════════════════════════════════════════
    // 周度学习批处理（W13）
    // ════════════════════════════════════════════════════════════

    // POST /v2/learning/weekly-batch — 运行周报生成
    if (method === 'POST' && path === '/v2/learning/weekly-batch') {
      const { runWeeklyBatch } = await import('../services/weeklyLearning.js');
      const schema = z.object({
        weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        weekEnd:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      });
      const body = schema.parse(await readBody(req));
      const result = await runWeeklyBatch({ tenantId, ...body });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/learning/reports — 查询历史周报列表
    if (method === 'GET' && path === '/v2/learning/reports') {
      const { queryReports } = await import('../services/weeklyLearning.js');
      const limit  = Math.min(Number(url.searchParams.get('limit') || 10), 52);
      const offset = Number(url.searchParams.get('offset') || 0);
      const result = queryReports({ tenantId, limit, offset });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/learning/reports/:id — 获取单条周报
    if (method === 'GET' && path.match(/^\/v2\/learning\/reports\/\d+$/)) {
      const { getReport } = await import('../services/weeklyLearning.js');
      const reportId = Number(path.split('/').pop());
      const result = getReport({ tenantId, reportId });
      if (!result) { sendV2Error(res, 404, `report ${reportId} not found`); return true; }
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/learning/weeks — 工具：返回当前周和上周的日期范围
    if (method === 'GET' && path === '/v2/learning/weeks') {
      const { getISOWeekBounds, getWeekBoundsForDate } = await import('../services/weeklyLearning.js');
      const lastWeek    = getISOWeekBounds();
      const currentWeek = getWeekBoundsForDate(new Date().toISOString().slice(0, 10));
      sendV2Json(res, 200, { lastWeek, currentWeek });
      return true;
    }

    // GET /v2/learning/weights — 查询当前 ranker_weights（供推荐器/调试使用）
    if (method === 'GET' && path === '/v2/learning/weights') {
      const { getRankerWeights } = await import('../services/weeklyLearning.js');
      const weights = getRankerWeights(tenantId);
      sendV2Json(res, 200, { weights, tenantId, ts: new Date().toISOString() });
      return true;
    }

    // POST /v2/learning/weights/reset — 重置 ranker_weights 到默认值
    if (method === 'POST' && path === '/v2/learning/weights/reset') {
      const { ensureRankerWeightsTable, getRankerWeights } = await import('../services/weeklyLearning.js');
      const db = getDb();
      await import('../db/actor.js').then(({ dbWrite }) =>
        dbWrite('ranker_weights:reset', (db) => {
          db.prepare('DELETE FROM ranker_weights WHERE tenant_id = ?').run(tenantId);
        })
      );
      // 重新插入默认值（ensureRankerWeightsTable 里有初始化逻辑，但只针对 'default' tenant）
      ensureRankerWeightsTable(); // 会为 'default' 重新插入默认值
      const weights = getRankerWeights(tenantId);
      sendV2Json(res, 200, { ok: true, weights, message: 'ranker_weights reset to defaults' });
      return true;
    }

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

    // ── W16: 公开 API 网关 ────────────────────────────────────────────────────

    // GET /v2/openapi.json — OpenAPI 3.0 规范（公开，无需鉴权）
    if (method === 'GET' && path === '/v2/openapi.json') {
      const spec = {
        openapi: '3.0.0',
        info: {
          title: 'CUE Project Hub API v2',
          version: '2.0.0',
          description: 'CUE 团队内部 AI 研发交付指挥系统 — v2 公开 API',
          contact: { url: 'https://hub.cueai.top' },
        },
        servers: [{ url: `${process.env.HUB_URL || 'https://hub.cueai.top'}/v2`, description: '生产环境' }],
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'cue_<tenantId>_<hex32>' },
          },
        },
        paths: {
          '/actors': { get: { summary: '列出 Actor', tags: ['actors'] }, post: { summary: '创建 Actor', tags: ['actors'] } },
          '/tasks': { get: { summary: '列出任务', tags: ['tasks'] }, post: { summary: '创建任务', tags: ['tasks'] } },
          '/health': { get: { summary: '系统健康度', tags: ['observability'] } },
          '/space': { get: { summary: 'SPACE 效能指标', tags: ['observability'] } },
          '/risks': { get: { summary: '风险列表', tags: ['risk'] } },
          '/runbooks': { get: { summary: 'Runbook 列表', tags: ['runbooks'] } },
          '/alerts/evaluate': { get: { summary: '评估告警', tags: ['runbooks'] } },
          '/learning/weekly-batch': { post: { summary: '触发周度学习批处理', tags: ['learning'] } },
          '/learning/reports': { get: { summary: '列出学习报告', tags: ['learning'] } },
          '/autonomy': { get: { summary: '列出 Agent 自主级别', tags: ['autonomy'] } },
          '/autonomy/auto-adjust': { post: { summary: '自动调整所有 Agent 自主级别', tags: ['autonomy'] } },
          '/gateway/keys': {
            get: { summary: '列出 API Keys', tags: ['gateway'] },
            post: { summary: '生成新 API Key', tags: ['gateway'] },
          },
          '/gateway/keys/{id}/revoke': { post: { summary: '撤销 API Key', tags: ['gateway'] } },
          '/gateway/audit': { get: { summary: '查询审计日志', tags: ['gateway'] } },
          '/gateway/validate': { get: { summary: '验证当前 API Key', tags: ['gateway'] } },
        },
      };
      sendV2Json(res, 200, spec);
      return true;
    }

    // POST /v2/gateway/keys — 生成新 API Key
    if (method === 'POST' && path === '/v2/gateway/keys') {
      const body = await readBody(req);
      const { name, scopes, rateLimit, expiresAt } = z.object({
        name: z.string().optional(),
        scopes: z.array(z.string()).optional(),
        rateLimit: z.number().int().min(1).max(10000).optional(),
        expiresAt: z.string().optional(),
      }).parse(body);
      const { generateApiKey } = await import('../middleware/apiGateway.js');
      const result = await generateApiKey({ tenantId, name, scopes, rateLimit, expiresAt });
      sendV2Json(res, 201, {
        ...result,
        warning: 'Store this key securely — it cannot be retrieved again',
      });
      return true;
    }

    // GET /v2/gateway/keys — 列出 API Keys（不含完整 key）
    if (method === 'GET' && path === '/v2/gateway/keys') {
      const { listApiKeys } = await import('../middleware/apiGateway.js');
      const keys = listApiKeys({ tenantId });
      sendV2Json(res, 200, { keys, count: keys.length });
      return true;
    }

    // POST /v2/gateway/keys/:id/revoke — 撤销 API Key
    if (method === 'POST' && path.match(/^\/v2\/gateway\/keys\/\d+\/revoke$/)) {
      const keyId = parseInt(path.split('/')[4], 10);
      const { revokeApiKey } = await import('../middleware/apiGateway.js');
      const ok = await revokeApiKey({ tenantId, keyId });
      if (!ok) { sendV2Error(res, 404, 'API key not found or already revoked'); return true; }
      sendV2Json(res, 200, { revoked: true, keyId });
      return true;
    }

    // GET /v2/gateway/audit — 查询审计日志
    if (method === 'GET' && path === '/v2/gateway/audit') {
      const q = url.searchParams;
      const { queryAuditLog } = await import('../middleware/apiGateway.js');
      const result = queryAuditLog({
        tenantId,
        path: q.get('path') || undefined,
        since: q.get('since') || undefined,
        limit: Math.min(200, parseInt(q.get('limit') || '50', 10)),
        offset: parseInt(q.get('offset') || '0', 10),
      });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/gateway/validate — 验证当前 API Key 信息（豁免鉴权，自助查询）
    if (method === 'GET' && path === '/v2/gateway/validate') {
      const rawKey = extractApiKey(req);
      const { validateApiKey } = await import('../middleware/apiGateway.js');
      if (!rawKey?.startsWith('cue_')) {
        sendV2Json(res, 200, { valid: false, reason: 'not a v2 API key (must start with cue_)' });
        return true;
      }
      const info = await validateApiKey(rawKey);
      if (!info) {
        sendV2Json(res, 200, { valid: false, reason: 'invalid or expired key' });
        return true;
      }
      sendV2Json(res, 200, { valid: true, tenantId: info.tenantId, scopes: info.scopes, rateLimit: info.rateLimit });
      return true;
    }

    // ── W14: 渐进式自主权 ─────────────────────────────────────────────────────

    // GET /v2/autonomy — 列出所有 AI Agent 自主级别
    if (method === 'GET' && path === '/v2/autonomy') {
      const { listAutonomyLevels } = await import('../services/autonomy.js');
      const levels = listAutonomyLevels({ tenantId });
      sendV2Json(res, 200, { levels, count: levels.length });
      return true;
    }

    // GET /v2/autonomy/:actorId — 获取单个 Agent 自主级别 + 历史
    if (method === 'GET' && path.match(/^\/v2\/autonomy\/[^/]+$/)) {
      const actorId = path.split('/')[3];
      const { getAutonomyLevel, getAutonomyHistory, AUTONOMY_LEVELS } = await import('../services/autonomy.js');
      const current = getAutonomyLevel({ tenantId, actorId });
      const history = getAutonomyHistory({ tenantId, actorId, limit: 20 });
      sendV2Json(res, 200, { actorId, ...current, history, allLevels: AUTONOMY_LEVELS });
      return true;
    }

    // POST /v2/autonomy/:actorId/adjust — 手动调整自主级别
    if (method === 'POST' && path.match(/^\/v2\/autonomy\/[^/]+\/adjust$/)) {
      const actorId = path.split('/')[3];
      const rawBody = await readBody(req);
      const { level, reason, changedBy } = z.object({
        level:     z.number().int().min(1).max(5),
        reason:    z.string().optional(),
        changedBy: z.string().optional(),
      }).parse(rawBody);
      const { adjustAutonomy } = await import('../services/autonomy.js');
      const result = await adjustAutonomy({
        tenantId, actorId, newLevel: level,
        reason:    reason    || '手动调整',
        changedBy: changedBy || 'manual',
        direction: 'manual',
      });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/autonomy/:actorId/evaluate — 评估升降级建议（不写入）
    if (method === 'GET' && path.match(/^\/v2\/autonomy\/[^/]+\/evaluate$/)) {
      const actorId = path.split('/')[3];
      const { evaluateAutonomy } = await import('../services/autonomy.js');
      const evaluation = evaluateAutonomy({ tenantId, actorId });
      sendV2Json(res, 200, evaluation);
      return true;
    }

    // POST /v2/autonomy/auto-adjust — 自动扫描并调整所有 Agent
    if (method === 'POST' && path === '/v2/autonomy/auto-adjust') {
      const rawBody = await readBody(req);
      const dryRun = rawBody.dryRun === true;
      const { autoAdjustAll } = await import('../services/autonomy.js');
      const result = await autoAdjustAll({ tenantId, dryRun });
      sendV2Json(res, 200, result);
      return true;
    }

    // GET /v2/autonomy/:actorId/can/:action — 权限检查
    if (method === 'GET' && path.match(/^\/v2\/autonomy\/[^/]+\/can\/[^/]+$/)) {
      const parts = path.split('/');
      const actorId = parts[3];
      const action = parts[5];
      const { canPerform, getAutonomyLevel } = await import('../services/autonomy.js');
      const allowed = canPerform({ tenantId, actorId, action });
      const { level } = getAutonomyLevel({ tenantId, actorId });
      sendV2Json(res, 200, { actorId, action, allowed, level });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // GET /v2/events/stream — SSE 实时事件流（Part L 前端补丁依赖）
    // 客户端通过 EventSource 订阅，用于 PR 实时 AC / 晚会 timeline
    // ════════════════════════════════════════════════════════════
    if (method === 'GET' && path === '/v2/events/stream') {
      const typeFilter = url.searchParams.get('type') || null;
      const sinceParam = url.searchParams.get('since');
      let lastId = sinceParam ? parseInt(sinceParam, 10) : 0;

      res.writeHead(200, {
        'content-type':                'text/event-stream',
        'cache-control':               'no-cache',
        'connection':                  'keep-alive',
        'access-control-allow-origin': '*',
        'x-accel-buffering':           'no',  // Nginx: 禁用缓冲
      });
      res.write(': SSE stream connected\n\n');

      const db = getDb();
      const interval = setInterval(() => {
        try {
          const query = typeFilter
            ? `SELECT id, type, payload_json, source, created_at FROM events WHERE id > ? AND type = ? ORDER BY id ASC LIMIT 50`
            : `SELECT id, type, payload_json, source, created_at FROM events WHERE id > ? ORDER BY id ASC LIMIT 50`;
          const rows = typeFilter
            ? db.prepare(query).all(lastId, typeFilter)
            : db.prepare(query).all(lastId);

          for (const row of rows) {
            const data = JSON.stringify({
              id:        row.id,
              type:      row.type,
              source:    row.source,
              createdAt: row.created_at,
              payload:   (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })(),
            });
            res.write(`id: ${row.id}\ndata: ${data}\n\n`);
            lastId = row.id;
          }

          // Keepalive comment 每 15 秒一次
          if (rows.length === 0) {
            res.write(': keepalive\n\n');
          }
        } catch (e) {
          // DB 不可用时静默，不断开连接
        }
      }, 2000);

      // 客户端断开时清理
      req.on('close', () => { clearInterval(interval); });
      req.on('error', () => { clearInterval(interval); });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // GET /v2/tasks/:taskId/explanation — V1 推荐理由（Part L 前端补丁依赖）
    // ════════════════════════════════════════════════════════════
    const taskExplainMatch = path.match(/^\/v2\/tasks\/([^/]+)\/explanation$/);
    if (method === 'GET' && taskExplainMatch) {
      const taskId = taskExplainMatch[1];
      const db = getDb();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
      if (!task) { sendV2Error(res, 404, 'task not found'); return true; }

      // 从推荐引擎获取解释（带 LLM 解释，稍慢但有意义）
      const { recommendForTask } = await import('../services/recommender.js');
      const result = await recommendForTask({ taskId, tenantId, options: { explain: true, limit: 3 } });

      const topRec = result.recommendations?.[0];
      sendV2Json(res, 200, {
        taskId,
        topActor: topRec ? {
          actorId:        topRec.actorId,
          displayName:    topRec.displayName,
          type:           topRec.type,
          score:          topRec.score,
          confidence:     topRec.aiConfidence ?? topRec.score / 100,
          explanation:    topRec.explanation || topRec.explainText || null,
          scoreBreakdown: topRec.scoreBreakdown || null,
        } : null,
        allCandidates: (result.recommendations || []).map(r => ({
          actorId: r.actorId,
          displayName: r.displayName,
          type: r.type,
          score: r.score,
        })),
      });
      return true;
    }

    // GET /v2/events/grouped — V4 Timeline（24h 事件按 actor 分组）
    if (method === 'GET' && path === '/v2/events/grouped') {
      const params = new URL(`http://x${req.url}`).searchParams;
      const hours = Math.min(parseInt(params.get('hours') || '24', 10), 72);
      const db = getDb();
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

      const rows = db.prepare(`
        SELECT e.id, e.type, e.source, e.created_at, e.payload_json
        FROM events e
        WHERE e.created_at >= ? AND e.tenant_id = ?
        ORDER BY e.created_at ASC
        LIMIT 500
      `).all(since, tenantId);

      // 按 actorId 分组（从 payload 提取）
      const grouped = {};
      for (const row of rows) {
        let payload = {};
        try { payload = JSON.parse(row.payload_json); } catch { /* skip */ }
        const actor = payload.actorId || payload.actor_id || payload.owner || 'system';
        if (!grouped[actor]) grouped[actor] = [];
        grouped[actor].push({
          id:        row.id,
          type:      row.type,
          source:    row.source,
          createdAt: row.created_at,
          payload,
        });
      }

      sendV2Json(res, 200, { since, hours, grouped, totalEvents: rows.length });
      return true;
    }

    // ════════════════════════════════════════════════════════════
    // GET /v2/observability/llm — LLM 调用账本
    // GET /v2/observability/events — 事件流历史
    // GET /v2/observability/sync-health — 三端同步健康度
    // ════════════════════════════════════════════════════════════
    if (method === 'GET' && path === '/v2/observability/llm') {
      const db = getDb();
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      const daily = db.prepare(`
        SELECT
          COUNT(*) as totalCalls,
          SUM(input_tokens)  as totalInput,
          SUM(output_tokens) as totalOutput,
          SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cacheHits,
          SUM(CASE WHEN output_tokens IS NULL OR output_tokens = 0 THEN 1 ELSE 0 END) as failedCalls
        FROM llm_calls WHERE ts >= ?
      `).get(todayStart.toISOString());

      const byPurpose = db.prepare(`
        SELECT purpose, COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output
        FROM llm_calls WHERE ts >= ?
        GROUP BY purpose ORDER BY calls DESC LIMIT 10
      `).all(todayStart.toISOString());

      const recentFailRate = (() => {
        const r = db.prepare(`
          SELECT COUNT(*) as total,
            SUM(CASE WHEN output_tokens IS NULL OR output_tokens = 0 THEN 1 ELSE 0 END) as failed
          FROM llm_calls WHERE ts >= ?
        `).get(fiveMinAgo);
        return r.total > 0 ? Math.round(r.failed / r.total * 100) : 0;
      })();

      // 成本估算（Sonnet 4.5 定价近似值）
      const costUsd = ((daily.totalInput || 0) * 0.000003 + (daily.totalOutput || 0) * 0.000015);
      const costYuan = costUsd * 7.2;
      const cacheHitRate = daily.totalCalls > 0
        ? Math.round(daily.cacheHits / daily.totalCalls * 100) : 0;

      sendV2Json(res, 200, {
        today: {
          totalCalls:    daily.totalCalls,
          failedCalls:   daily.failedCalls,
          cacheHitRate:  `${cacheHitRate}%`,
          estimatedCostYuan: parseFloat(costYuan.toFixed(2)),
          estimatedCostUsd:  parseFloat(costUsd.toFixed(4)),
        },
        recentFailRatePct: recentFailRate,
        byPurpose,
      });
      return true;
    }

    if (method === 'GET' && path === '/v2/observability/events') {
      const db = getDb();
      const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const type   = url.searchParams.get('type') || null;
      const source = url.searchParams.get('source') || null;

      let q = 'SELECT id, type, payload_json, source, created_at, processed_at FROM events WHERE tenant_id = ?';
      const params = [tenantId];
      if (type)   { q += ' AND type = ?';   params.push(type); }
      if (source) { q += ' AND source = ?'; params.push(source); }
      q += ' ORDER BY id DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = db.prepare(q).all(...params);
      const total = db.prepare('SELECT COUNT(*) as n FROM events WHERE tenant_id = ?').get(tenantId).n;
      const unprocessed = db.prepare("SELECT COUNT(*) as n FROM events WHERE tenant_id = ? AND processed_at IS NULL").get(tenantId).n;

      sendV2Json(res, 200, {
        total, unprocessed, limit, offset,
        events: rows.map(r => ({
          id:          r.id,
          type:        r.type,
          source:      r.source,
          createdAt:   r.created_at,
          processedAt: r.processed_at,
          payload:     (() => { try { return JSON.parse(r.payload_json); } catch { return {}; } })(),
        })),
      });
      return true;
    }

    if (method === 'GET' && path === '/v2/observability/sync-health') {
      const db = getDb();

      // task ↔ PR 一致性（有 PR 关联的任务 vs 所有 in_progress/in_review 任务）
      const activeTasks = db.prepare(
        "SELECT COUNT(*) as n FROM tasks WHERE tenant_id = ? AND state IN ('in_progress','in_review')"
      ).get(tenantId).n;
      const linkedTasks = db.prepare(`
        SELECT COUNT(DISTINCT ptl.task_id) as n
        FROM pull_task_links ptl
        JOIN tasks t ON ptl.task_id = t.id
        WHERE t.tenant_id = ? AND t.state IN ('in_progress','in_review')
      `).get(tenantId).n;

      // 孤儿 PR（有 PR 但没有关联任务）
      const orphanPRs = db.prepare(`
        SELECT COUNT(*) as n FROM pulls p
        WHERE p.tenant_id = ? AND p.state = 'open'
          AND NOT EXISTS (SELECT 1 FROM pull_task_links ptl WHERE ptl.pull_id = p.id)
      `).get(tenantId).n;

      // 防循环签名命中（sync_signatures 表，7 天内）
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      let signatureHits = 0;
      try {
        signatureHits = db.prepare(
          "SELECT COUNT(*) as n FROM sync_signatures WHERE created_at >= ?"
        ).get(sevenDaysAgo).n;
      } catch { /* sync_signatures 表可能不存在 */ }

      const taskPrConsistency = activeTasks > 0
        ? Math.round(linkedTasks / activeTasks * 100) : 100;

      sendV2Json(res, 200, {
        taskPrConsistencyPct: taskPrConsistency,
        activeTasks,
        linkedTasks,
        orphanPRs,
        signatureHits7d: signatureHits,
        health: orphanPRs <= 5 && taskPrConsistency >= 80 ? 'healthy' : 'degraded',
      });
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
    logger.error('[v2] error:', method, path, err.message);
    sendV2Error(res, 500, err.message || 'internal error');
    return true;
  } finally {
    // ── 审计日志（fire and forget，仅 cue_ key 请求）────────────
    if (_authKeyPrefix) {
      auditLog({
        tenantId,
        keyPrefix: _authKeyPrefix,
        method,
        path,
        statusCode: _capturedStatus,
        latencyMs: Date.now() - startTs,
        ip: req.socket?.remoteAddress,
        userAgent: req.headers?.['user-agent'],
      });
    }
  }
}
