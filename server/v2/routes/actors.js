// server/v2/routes/actors.js — /v2/actors/*

import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { withTenant } from '../../db/index.js';
import { dbWrite } from '../../db/actor.js';
import logger from '../../logger.js';

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

function mapActor(a) {
  return {
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
  };
}

export async function handle(ctx) {
  const { method, path, tenantId, readBody, sendV2Json, sendV2Error } = ctx;

  // GET /v2/actors
  if (method === 'GET' && path === '/v2/actors') {
    const actors = await withTenant(tenantId).actors().selectAll().execute();
    sendV2Json(200, actors.map(mapActor));
    return true;
  }

  // POST /v2/actors
  if (method === 'POST' && path === '/v2/actors') {
    const body = ActorCreateSchema.parse(await readBody());
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
    sendV2Json(201, { id, type: body.type, displayName: body.displayName });
    return true;
  }

  // GET /v2/actors/:id
  const actorMatch = path.match(/^\/v2\/actors\/([^/]+)$/);
  if (method === 'GET' && actorMatch) {
    const id = actorMatch[1];
    const db = getDb();
    const actor = db.prepare('SELECT * FROM actors WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!actor) { sendV2Error(404, 'actor not found'); return true; }
    sendV2Json(200, {
      id: actor.id, type: actor.type, displayName: actor.display_name,
      email: actor.email, commHandle: actor.comm_handle,
      agentModel: actor.agent_model, agentEndpoint: actor.agent_endpoint,
      capabilities: JSON.parse(actor.capabilities_json || '[]'),
      contextWindow: actor.context_window, autonomyLevel: actor.autonomy_level,
      active: Boolean(actor.active), createdAt: actor.created_at, updatedAt: actor.updated_at,
    });
    return true;
  }

  return false;
}
