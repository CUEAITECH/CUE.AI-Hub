// server/v2/routes/pulls.js — /v2/pulls/*

import { z } from 'zod';

export async function handle(ctx) {
  const { method, path, tenantId, readBody, sendV2Json } = ctx;

  // POST /v2/pulls/generate-description
  if (method === 'POST' && path === '/v2/pulls/generate-description') {
    const { generatePRDescription } = await import('../../services/prPromptGenerator.js');
    const schema = z.object({
      taskId:      z.string(),
      branchName:  z.string().optional(),
      diffSummary: z.string().max(3000).optional(),
      artifacts:   z.array(z.string()).optional(),
    });
    const body = schema.parse(await readBody());

    const { body: description, source } = await generatePRDescription({
      taskId: body.taskId, tenantId,
      branchName:  body.branchName,
      diffSummary: body.diffSummary,
      artifacts:   body.artifacts || [],
    });

    sendV2Json(200, { description, source, taskId: body.taskId });
    return true;
  }

  return false;
}
