// server/v2/routes/outcomes.js — /v2/outcomes/*

import { z } from 'zod';

export async function handle(ctx) {
  const { method, path, url, tenantId, readBody, sendV2Json } = ctx;

  // POST /v2/outcomes
  if (method === 'POST' && path === '/v2/outcomes') {
    const { recordOutcome } = await import('../../services/outcomeLedger.js');
    const schema = z.object({
      actionType:    z.string(),
      actionRefId:   z.string(),
      outcomeSignal: z.string().min(1),
      polarity:      z.union([z.literal(1), z.literal(-1), z.literal(0)]),
      evidence:      z.record(z.any()).optional(),
      observer:      z.enum(['auto-rule', 'human-label', 'agent-self']).default('human-label'),
      lagHours:      z.number().int().nonnegative().optional(),
    });
    const body = schema.parse(await readBody());
    const id = await recordOutcome({ tenantId, ...body });
    sendV2Json(201, { id, ok: true });
    return true;
  }

  // GET /v2/outcomes/stats — before /v2/outcomes to avoid conflict
  if (method === 'GET' && path === '/v2/outcomes/stats') {
    const { computeStats } = await import('../../services/outcomeLedger.js');
    const since      = url.searchParams.get('since') || undefined;
    const actionType = url.searchParams.get('action_type') || undefined;
    sendV2Json(200, computeStats({ tenantId, since, actionType }));
    return true;
  }

  // GET /v2/outcomes
  if (method === 'GET' && path === '/v2/outcomes') {
    const { queryOutcomes } = await import('../../services/outcomeLedger.js');
    const result = queryOutcomes({
      tenantId,
      actionType: url.searchParams.get('action_type') || undefined,
      polarity:   url.searchParams.has('polarity') ? Number(url.searchParams.get('polarity')) : undefined,
      observer:   url.searchParams.get('observer') || undefined,
      since:      url.searchParams.get('since') || undefined,
      limit:      Math.min(Number(url.searchParams.get('limit') || 50), 200),
      offset:     Number(url.searchParams.get('offset') || 0),
    });
    sendV2Json(200, result);
    return true;
  }

  // POST /v2/outcomes/auto-label
  if (method === 'POST' && path === '/v2/outcomes/auto-label') {
    const { batchAutoLabel } = await import('../../services/outcomeLedger.js');
    const schema = z.object({ since: z.string().optional() });
    const body = schema.parse(await readBody());
    sendV2Json(200, await batchAutoLabel({ tenantId, since: body.since }));
    return true;
  }

  // POST /v2/outcomes/label-task
  if (method === 'POST' && path === '/v2/outcomes/label-task') {
    const { autoLabelTaskOutcome } = await import('../../services/outcomeLedger.js');
    const schema = z.object({ taskId: z.string() });
    const body = schema.parse(await readBody());
    const id = await autoLabelTaskOutcome({ tenantId, taskId: body.taskId });
    sendV2Json(200, { id, ok: true });
    return true;
  }

  // POST /v2/outcomes/label-review
  if (method === 'POST' && path === '/v2/outcomes/label-review') {
    const { autoLabelReviewOutcome } = await import('../../services/outcomeLedger.js');
    const schema = z.object({ reviewId: z.string() });
    const body = schema.parse(await readBody());
    const id = await autoLabelReviewOutcome({ tenantId, reviewId: body.reviewId });
    sendV2Json(200, { id, ok: true });
    return true;
  }

  return false;
}
