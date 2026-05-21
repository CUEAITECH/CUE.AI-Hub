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

      console.log(`[v2] memory created: id=${id} kind=${body.kind} tenant=${tenantId}`);
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

    // POST /v2/sync/webhook — 接收 GitHub PR Webhook
    if (method === 'POST' && path === '/v2/sync/webhook') {
      const { handlePRWebhook } = await import('../services/syncBroker.js');
      const payload = await readBody(req);

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
