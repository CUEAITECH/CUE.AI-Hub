// server/v2/routes/sync.js — /v2/sync/*

import { z } from 'zod';
import { getDb } from '../../db/index.js';
import logger from '../../logger.js';

export async function handle(ctx) {
  const { method, path, url, tenantId, req, readBody, sendV2Json, sendV2Error } = ctx;

  // POST /v2/sync/webhook
  if (method === 'POST' && path === '/v2/sync/webhook') {
    const { handlePRWebhook } = await import('../../services/syncBroker.js');
    const { Webhooks } = await import('@octokit/webhooks');

    // req.rawBody: Buffer captured by Fastify's custom JSON content-type parser (fastifyApp.js)
    // Fallback: stream the body directly (when handleV2 is called without Fastify, e.g. tests)
    const rawBody = req.rawBody instanceof Buffer
      ? req.rawBody.toString('utf8')
      : await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          req.on('error', reject);
        });

    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'] || '';
      const wh = new Webhooks({ secret: webhookSecret });
      const deliveryId = req.headers['x-github-delivery'] || `manual-${Date.now()}`;
      const eventName  = req.headers['x-github-event'] || 'push';

      try {
        await wh.verifyAndReceive({ id: deliveryId, name: eventName, signature, payload: rawBody });
      } catch (verifyErr) {
        logger.warn('[v2/sync/webhook] signature verification failed:', verifyErr.message);
        sendV2Error(401, 'GitHub webhook signature verification failed');
        return true;
      }
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { sendV2Error(400, 'invalid JSON payload'); return true; }

    const event = req.headers['x-github-event'] || payload.action || 'unknown';
    const result = await handlePRWebhook({ tenantId, event, payload });
    sendV2Json(200, result);
    return true;
  }

  // POST /v2/sync/resync
  if (method === 'POST' && path === '/v2/sync/resync') {
    const { resyncAllPRLinks } = await import('../../services/syncBroker.js');
    const schema = z.object({ projectId: z.string().optional() });
    const body = schema.parse(await readBody());

    const result = await resyncAllPRLinks({ tenantId, projectId: body.projectId });
    sendV2Json(200, result);
    return true;
  }

  // POST /v2/sync/writeback
  if (method === 'POST' && path === '/v2/sync/writeback') {
    const { writeProgressDoc } = await import('../../services/syncBroker.js');
    const schema = z.object({ projectId: z.string() });
    const body = schema.parse(await readBody());

    const result = await writeProgressDoc({ tenantId, projectId: body.projectId });
    sendV2Json(200, result);
    return true;
  }

  // GET /v2/sync/links
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
    sendV2Json(200, { links, total: links.length });
    return true;
  }

  return false;
}
