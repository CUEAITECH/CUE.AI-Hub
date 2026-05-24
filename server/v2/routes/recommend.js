// server/v2/routes/recommend.js — /v2/recommend/*

import { z } from 'zod';

export async function handle(ctx) {
  const { method, path, tenantId, readBody, sendV2Json } = ctx;

  // POST /v2/recommend
  if (method === 'POST' && path === '/v2/recommend') {
    const { recommendForTask } = await import('../../services/recommender.js');
    const schema = z.object({
      taskId:    z.string(),
      topK:      z.number().int().min(1).max(20).default(5),
      actorType: z.enum(['all', 'human', 'ai-agent']).default('all'),
      minScore:  z.number().min(0).max(100).default(20),
      explain:   z.boolean().default(true),
    });
    const body = schema.parse(await readBody());

    const result = await recommendForTask({
      taskId: body.taskId, tenantId,
      options: { topK: body.topK, actorType: body.actorType, minScore: body.minScore, explain: body.explain },
    });

    sendV2Json(200, result);
    return true;
  }

  // POST /v2/recommend/batch
  if (method === 'POST' && path === '/v2/recommend/batch') {
    const { batchRecommend } = await import('../../services/recommender.js');
    const schema = z.object({
      projectId: z.string().optional(),
      actorType: z.enum(['all', 'human', 'ai-agent']).default('all'),
      minScore:  z.number().min(0).max(100).default(20),
    });
    const body = schema.parse(await readBody());

    const result = await batchRecommend({
      tenantId, projectId: body.projectId,
      options: { actorType: body.actorType, minScore: body.minScore },
    });

    sendV2Json(200, result);
    return true;
  }

  return false;
}
