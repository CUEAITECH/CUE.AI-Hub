// server/v2/routes/system.js — /v2/health, /v2/info

import { getDb } from '../../db/index.js';

export async function handle(ctx) {
  const { method, path, sendV2Json } = ctx;

  // GET /v2/health
  if (method === 'GET' && path === '/v2/health') {
    const db = getDb();
    const { count } = db.prepare('SELECT COUNT(*) as count FROM actors').get();
    sendV2Json(200, { status: 'ok', version: 'v2', actors: count, ts: new Date().toISOString() });
    return true;
  }

  // GET /v2/info
  if (method === 'GET' && path === '/v2/info') {
    const { getAllAdapters } = await import('../../adapters/index.js');
    sendV2Json(200, {
      version: 'v2',
      vision: 'Operating system for hybrid human+AI teams',
      adapters: getAllAdapters().map(a => a.name),
      features: ['actor-abstraction', 'event-bus', 'state-machine', 'notification-adapter', 'agent-protocol'],
    });
    return true;
  }

  return false;
}
