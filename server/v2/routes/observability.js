// server/v2/routes/observability.js — /v2/space, /v2/risks, /v2/runbooks, /v2/alerts, /v2/observability/*

import { z } from 'zod';
import { getDb } from '../../db/index.js';

export async function handle(ctx) {
  const { method, path, url, tenantId, readBody, sendV2Json, sendV2Error } = ctx;

  // GET /v2/space
  if (method === 'GET' && path === '/v2/space') {
    const { computeSpaceMetrics } = await import('../../services/spaceMetrics.js');
    sendV2Json(200, computeSpaceMetrics({
      tenantId,
      projectId:  url.searchParams.get('project_id') || undefined,
      windowDays: Number(url.searchParams.get('window_days') || 14),
    }));
    return true;
  }

  // GET /v2/space/actors
  if (method === 'GET' && path === '/v2/space/actors') {
    const { computePerActorStats } = await import('../../services/spaceMetrics.js');
    const result = computePerActorStats({
      tenantId,
      projectId:  url.searchParams.get('project_id') || undefined,
      windowDays: Number(url.searchParams.get('window_days') || 14),
    });
    sendV2Json(200, { actors: result, total: result.length });
    return true;
  }

  // GET /v2/risks
  if (method === 'GET' && path === '/v2/risks') {
    const { scanRisks } = await import('../../services/riskPropagation.js');
    sendV2Json(200, scanRisks({ tenantId, projectId: url.searchParams.get('project_id') || undefined }));
    return true;
  }

  // POST /v2/risks/propagate
  if (method === 'POST' && path === '/v2/risks/propagate') {
    const { propagateRiskSignals } = await import('../../services/riskPropagation.js');
    const schema = z.object({
      projectId: z.string().optional(),
      threshold: z.number().int().min(1).max(10).default(7),
    });
    const body = schema.parse(await readBody());
    sendV2Json(200, await propagateRiskSignals({ tenantId, ...body }));
    return true;
  }

  // GET /v2/risks/task/:taskId
  if (method === 'GET' && path.startsWith('/v2/risks/task/')) {
    const { getRiskForTask } = await import('../../services/riskPropagation.js');
    const taskId = path.slice('/v2/risks/task/'.length);
    sendV2Json(200, getRiskForTask({ tenantId, taskId }));
    return true;
  }

  // GET /v2/runbooks
  if (method === 'GET' && path === '/v2/runbooks') {
    const { BUILTIN_RUNBOOKS } = await import('../../services/runbook.js');
    sendV2Json(200, { runbooks: BUILTIN_RUNBOOKS, total: BUILTIN_RUNBOOKS.length });
    return true;
  }

  // GET /v2/alerts/evaluate
  if (method === 'GET' && path === '/v2/alerts/evaluate') {
    const { evaluateAlerts } = await import('../../services/runbook.js');
    sendV2Json(200, evaluateAlerts({ tenantId }));
    return true;
  }

  // POST /v2/alerts/cycle
  if (method === 'POST' && path === '/v2/alerts/cycle') {
    const { runAlertCycle } = await import('../../services/runbook.js');
    const schema = z.object({ cooldownHours: z.number().int().min(0).max(168).default(4) });
    const body = schema.parse(await readBody());
    sendV2Json(200, await runAlertCycle({ tenantId, cooldownHours: body.cooldownHours }));
    return true;
  }

  // GET /v2/alerts
  if (method === 'GET' && path === '/v2/alerts') {
    const { queryAlertHistory, ensureAlertsTable } = await import('../../services/runbook.js');
    ensureAlertsTable();
    const ackParam     = url.searchParams.get('acknowledged');
    sendV2Json(200, queryAlertHistory({
      tenantId,
      severity:     url.searchParams.get('severity') || undefined,
      acknowledged: ackParam !== null ? ackParam === 'true' : undefined,
      limit:        Math.min(Number(url.searchParams.get('limit') || 50), 200),
      offset:       Number(url.searchParams.get('offset') || 0),
    }));
    return true;
  }

  // POST /v2/alerts/:id/ack
  if (method === 'POST' && path.match(/^\/v2\/alerts\/\d+\/ack$/)) {
    const { acknowledgeAlert } = await import('../../services/runbook.js');
    const alertId = Number(path.split('/')[3]);
    const schema = z.object({ acknowledgedBy: z.string().optional() });
    const body = schema.parse(await readBody());
    sendV2Json(200, { ok: await acknowledgeAlert({ tenantId, alertId, acknowledgedBy: body.acknowledgedBy }) });
    return true;
  }

  // GET /v2/observability/llm
  if (method === 'GET' && path === '/v2/observability/llm') {
    const db = getDb();
    // SQLite CURRENT_TIMESTAMP 存储格式为 'YYYY-MM-DD HH:MM:SS'（空格，非 ISO T 分隔）
    // toISOString() 产生 'YYYY-MM-DDTHH:MM:SS.mmmZ'，字符串比较时空格(0x20) < T(0x54)
    // 必须统一为空格格式，否则 UTC 时区服务器上今天所有记录都查不到
    const toSqliteTs = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const fiveMinAgo = toSqliteTs(new Date(Date.now() - 5 * 60 * 1000));

    const daily = db.prepare(`
      SELECT
        COUNT(*) as totalCalls,
        SUM(input_tokens)  as totalInput,
        SUM(output_tokens) as totalOutput,
        SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cacheHits,
        SUM(CASE WHEN output_tokens IS NULL OR output_tokens = 0 THEN 1 ELSE 0 END) as failedCalls
      FROM llm_calls WHERE ts >= ?
    `).get(toSqliteTs(todayStart));

    const byPurpose = db.prepare(`
      SELECT purpose, COUNT(*) as calls, SUM(input_tokens) as input, SUM(output_tokens) as output
      FROM llm_calls WHERE ts >= ?
      GROUP BY purpose ORDER BY calls DESC LIMIT 10
    `).all(toSqliteTs(todayStart));

    const recentFailRate = (() => {
      const r = db.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN output_tokens IS NULL OR output_tokens = 0 THEN 1 ELSE 0 END) as failed
        FROM llm_calls WHERE ts >= ?
      `).get(fiveMinAgo);
      return r.total > 0 ? Math.round(r.failed / r.total * 100) : 0;
    })();

    // ── NewAPI：全量真实数据（Hub + PR-Agent + 所有工具）──────────────
    const { fetchTodayLedger, isNewApiAvailable } = await import('../../services/newApiLedger.js');
    let newApiLedger = null;
    let newApiError  = null;
    if (isNewApiAvailable()) {
      try {
        newApiLedger = await fetchTodayLedger();
      } catch (e) {
        newApiError = e.message;
        console.error('[NewAPI] fetchTodayLedger failed:', e.message);
      }
    }

    if (newApiLedger) {
      // 完全用 NewAPI 数据，SQLite 仅提供 Hub 内部用途分组（附表）
      const cacheHitRate = daily.totalCalls > 0
        ? Math.round(daily.cacheHits / daily.totalCalls * 100) : null;
      sendV2Json(200, {
        today: {
          totalCalls:        newApiLedger.totalCalls,
          totalInput:        newApiLedger.totalInput,
          totalOutput:       newApiLedger.totalOutput,
          failedCalls:       daily.failedCalls,         // NewAPI 不区分失败，用 Hub 本地
          cacheHitRate:      cacheHitRate != null ? `${cacheHitRate}%` : null,
          estimatedCostYuan: newApiLedger.costYuan,
          estimatedCostUsd:  newApiLedger.costUsd,
          costSource:        newApiLedger.costSource,   // 'newapi-quota' | 'newapi-tokens'
        },
        recentFailRatePct: recentFailRate,
        byModel:    newApiLedger.byModel,   // 按模型真实用量（主表）
        byPurpose,                          // Hub 内部用途分组（附表）
      });
      return true;
    }

    // ── 降级：仅有 Hub 本地 SQLite 数据 ───────────────────────────────
    const cacheHitRate = daily.totalCalls > 0
      ? Math.round(daily.cacheHits / daily.totalCalls * 100) : null;
    const rawUsd = ((daily.totalInput || 0) * 0.000003 + (daily.totalOutput || 0) * 0.000015);
    sendV2Json(200, {
      today: {
        totalCalls:        daily.totalCalls,
        failedCalls:       daily.failedCalls,
        cacheHitRate:      cacheHitRate != null ? `${cacheHitRate}%` : null,
        estimatedCostYuan: parseFloat((rawUsd * 7.2).toFixed(2)),
        estimatedCostUsd:  parseFloat(rawUsd.toFixed(4)),
        costSource:        'estimate',
      },
      recentFailRatePct: recentFailRate,
      byModel:    [],
      byPurpose,
      newApiAvailable: isNewApiAvailable(),
      newApiError:     newApiError || undefined,
    });
    return true;
  }

  // GET /v2/observability/events
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
    const total       = db.prepare('SELECT COUNT(*) as n FROM events WHERE tenant_id = ?').get(tenantId).n;
    const unprocessed = db.prepare("SELECT COUNT(*) as n FROM events WHERE tenant_id = ? AND processed_at IS NULL").get(tenantId).n;

    sendV2Json(200, {
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

  // GET /v2/observability/sync-health
  if (method === 'GET' && path === '/v2/observability/sync-health') {
    const db = getDb();
    const activeTasks = db.prepare(
      "SELECT COUNT(*) as n FROM tasks WHERE tenant_id = ? AND state IN ('in_progress','in_review')"
    ).get(tenantId).n;
    const linkedTasks = db.prepare(`
      SELECT COUNT(DISTINCT ptl.task_id) as n
      FROM pull_task_links ptl
      JOIN tasks t ON ptl.task_id = t.id
      WHERE t.tenant_id = ? AND t.state IN ('in_progress','in_review')
    `).get(tenantId).n;
    const orphanPRs = db.prepare(`
      SELECT COUNT(*) as n FROM pulls p
      WHERE p.tenant_id = ? AND p.state = 'open'
        AND NOT EXISTS (SELECT 1 FROM pull_task_links ptl WHERE ptl.pull_id = p.id)
    `).get(tenantId).n;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let signatureHits = 0;
    try {
      signatureHits = db.prepare(
        "SELECT COUNT(*) as n FROM sync_signatures WHERE created_at >= ?"
      ).get(sevenDaysAgo).n;
    } catch { /* table may not exist */ }

    const taskPrConsistency = activeTasks > 0
      ? Math.round(linkedTasks / activeTasks * 100) : 100;

    sendV2Json(200, {
      taskPrConsistencyPct: taskPrConsistency,
      activeTasks, linkedTasks, orphanPRs,
      signatureHits7d: signatureHits,
      health: orphanPRs <= 5 && taskPrConsistency >= 80 ? 'healthy' : 'degraded',
    });
    return true;
  }

  return false;
}
