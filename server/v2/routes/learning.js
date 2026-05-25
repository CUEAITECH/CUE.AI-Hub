// server/v2/routes/learning.js — /v2/learning/*

import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { dbWrite } from '../../db/actor.js';

export async function handle(ctx) {
  const { method, path, url, tenantId, readBody, sendV2Json, sendV2Error } = ctx;

  if (!path.startsWith('/v2/learning/')) return false;

  // POST /v2/learning/enqueue
  if (method === 'POST' && path === '/v2/learning/enqueue') {
    const { enqueue } = await import('../../services/activeLearning.js');
    const schema = z.object({
      actionType:   z.string(),
      actionRefId:  z.string(),
      reason:       z.string().min(1),
      priority:     z.number().int().min(0).max(10).default(5),
      aiConfidence: z.number().min(0).max(1).default(0.5),
      metadata:     z.record(z.any()).optional(),
    });
    const body = schema.parse(await readBody());
    const id = await enqueue({ tenantId, ...body });
    sendV2Json(id !== null ? 201 : 200, { id, ok: true, enqueued: id !== null });
    return true;
  }

  // GET /v2/learning/queue
  if (method === 'GET' && path === '/v2/learning/queue') {
    const { dequeue } = await import('../../services/activeLearning.js');
    const result = dequeue({
      tenantId,
      status:     url.searchParams.get('status') || 'pending',
      actionType: url.searchParams.get('action_type') || undefined,
      limit:      Math.min(Number(url.searchParams.get('limit') || 20), 100),
      offset:     Number(url.searchParams.get('offset') || 0),
    });
    sendV2Json(200, result);
    return true;
  }

  // POST /v2/learning/label
  if (method === 'POST' && path === '/v2/learning/label') {
    const { label } = await import('../../services/activeLearning.js');
    const schema = z.object({
      queueId:   z.number().int(),
      polarity:  z.union([z.literal(1), z.literal(-1), z.literal(0)]),
      signal:    z.string().min(1),
      labeledBy: z.string().optional(),
    });
    const body = schema.parse(await readBody());
    sendV2Json(200, { ...await label({ tenantId, ...body }), ok: true });
    return true;
  }

  // POST /v2/learning/dismiss
  if (method === 'POST' && path === '/v2/learning/dismiss') {
    const { dismiss } = await import('../../services/activeLearning.js');
    const schema = z.object({ queueId: z.number().int() });
    const body = schema.parse(await readBody());
    sendV2Json(200, { ok: await dismiss({ tenantId, queueId: body.queueId }) });
    return true;
  }

  // GET /v2/learning/stats
  if (method === 'GET' && path === '/v2/learning/stats') {
    const { queueStats } = await import('../../services/activeLearning.js');
    sendV2Json(200, queueStats({ tenantId }));
    return true;
  }

  // POST /v2/learning/auto-enqueue
  if (method === 'POST' && path === '/v2/learning/auto-enqueue') {
    const { autoEnqueue } = await import('../../services/activeLearning.js');
    const schema = z.object({ since: z.string().optional() });
    const body = schema.parse(await readBody());
    sendV2Json(200, await autoEnqueue({ tenantId, since: body.since }));
    return true;
  }

  // POST /v2/learning/weekly-batch
  if (method === 'POST' && path === '/v2/learning/weekly-batch') {
    const { runWeeklyBatch } = await import('../../services/weeklyLearning.js');
    const schema = z.object({
      weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      weekEnd:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    });
    const body = schema.parse(await readBody());
    sendV2Json(200, await runWeeklyBatch({ tenantId, ...body }));
    return true;
  }

  // GET /v2/learning/reports — list
  if (method === 'GET' && path === '/v2/learning/reports') {
    const { queryReports } = await import('../../services/weeklyLearning.js');
    const result = queryReports({
      tenantId,
      limit:  Math.min(Number(url.searchParams.get('limit') || 10), 52),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    sendV2Json(200, result);
    return true;
  }

  // GET /v2/learning/reports/:id
  if (method === 'GET' && path.match(/^\/v2\/learning\/reports\/\d+$/)) {
    const { getReport } = await import('../../services/weeklyLearning.js');
    const reportId = Number(path.split('/').pop());
    const result = getReport({ tenantId, reportId });
    if (!result) { sendV2Error(404, `report ${reportId} not found`); return true; }
    sendV2Json(200, result);
    return true;
  }

  // GET /v2/learning/weeks
  if (method === 'GET' && path === '/v2/learning/weeks') {
    const { getISOWeekBounds, getWeekBoundsForDate } = await import('../../services/weeklyLearning.js');
    const lastWeek    = getISOWeekBounds();
    const currentWeek = getWeekBoundsForDate(new Date().toISOString().slice(0, 10));
    sendV2Json(200, { lastWeek, currentWeek });
    return true;
  }

  // GET /v2/learning/weights
  if (method === 'GET' && path === '/v2/learning/weights') {
    const { getRankerWeights } = await import('../../services/weeklyLearning.js');
    sendV2Json(200, { weights: getRankerWeights(tenantId), tenantId, ts: new Date().toISOString() });
    return true;
  }

  // POST /v2/learning/weights/reset
  if (method === 'POST' && path === '/v2/learning/weights/reset') {
    const { ensureRankerWeightsTable, getRankerWeights } = await import('../../services/weeklyLearning.js');
    await dbWrite('ranker_weights:reset', (db) => {
      db.prepare('DELETE FROM ranker_weights WHERE tenant_id = ?').run(tenantId);
    });
    ensureRankerWeightsTable();
    sendV2Json(200, { ok: true, weights: getRankerWeights(tenantId), message: 'ranker_weights reset to defaults' });
    return true;
  }

  return false;
}
