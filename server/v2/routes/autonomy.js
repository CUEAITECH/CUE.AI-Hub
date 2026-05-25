// server/v2/routes/autonomy.js — /v2/autonomy/*

import { z } from 'zod';

export async function handle(ctx) {
  const { method, path, tenantId, readBody, sendV2Json } = ctx;

  if (!path.startsWith('/v2/autonomy')) return false;

  // GET /v2/autonomy
  if (method === 'GET' && path === '/v2/autonomy') {
    const { listAutonomyLevels } = await import('../../services/autonomy.js');
    const levels = listAutonomyLevels({ tenantId });
    sendV2Json(200, { levels, count: levels.length });
    return true;
  }

  // POST /v2/autonomy/auto-adjust — before /:actorId routes
  if (method === 'POST' && path === '/v2/autonomy/auto-adjust') {
    const rawBody = await readBody();
    const dryRun = rawBody.dryRun === true;
    const { autoAdjustAll } = await import('../../services/autonomy.js');
    sendV2Json(200, await autoAdjustAll({ tenantId, dryRun }));
    return true;
  }

  // POST /v2/autonomy/:actorId/adjust
  if (method === 'POST' && path.match(/^\/v2\/autonomy\/[^/]+\/adjust$/)) {
    const actorId = path.split('/')[3];
    const { level, reason, changedBy } = z.object({
      level:     z.number().int().min(1).max(5),
      reason:    z.string().optional(),
      changedBy: z.string().optional(),
    }).parse(await readBody());
    const { adjustAutonomy } = await import('../../services/autonomy.js');
    sendV2Json(200, await adjustAutonomy({
      tenantId, actorId, newLevel: level,
      reason:    reason    || '手动调整',
      changedBy: changedBy || 'manual',
      direction: 'manual',
    }));
    return true;
  }

  // GET /v2/autonomy/:actorId/evaluate
  if (method === 'GET' && path.match(/^\/v2\/autonomy\/[^/]+\/evaluate$/)) {
    const actorId = path.split('/')[3];
    const { evaluateAutonomy } = await import('../../services/autonomy.js');
    sendV2Json(200, evaluateAutonomy({ tenantId, actorId }));
    return true;
  }

  // GET /v2/autonomy/:actorId/can/:action
  if (method === 'GET' && path.match(/^\/v2\/autonomy\/[^/]+\/can\/[^/]+$/)) {
    const parts = path.split('/');
    const actorId = parts[3];
    const action  = parts[5];
    const { canPerform, getAutonomyLevel } = await import('../../services/autonomy.js');
    const allowed = canPerform({ tenantId, actorId, action });
    const { level } = getAutonomyLevel({ tenantId, actorId });
    sendV2Json(200, { actorId, action, allowed, level });
    return true;
  }

  // GET /v2/autonomy/:actorId
  if (method === 'GET' && path.match(/^\/v2\/autonomy\/[^/]+$/)) {
    const actorId = path.split('/')[3];
    const { getAutonomyLevel, getAutonomyHistory, AUTONOMY_LEVELS } = await import('../../services/autonomy.js');
    const current = getAutonomyLevel({ tenantId, actorId });
    const history = getAutonomyHistory({ tenantId, actorId, limit: 20 });
    sendV2Json(200, { actorId, ...current, history, allLevels: AUTONOMY_LEVELS });
    return true;
  }

  return false;
}
