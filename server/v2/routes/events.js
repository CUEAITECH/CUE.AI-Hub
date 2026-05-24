// server/v2/routes/events.js — /v2/events/*, /v2/tasks/:taskId/explanation

import { getDb } from '../../db/index.js';

export async function handle(ctx) {
  const { method, path, url, tenantId, req, sendV2Json, sendV2Error, res } = ctx;

  // GET /v2/events/stream — SSE (polling DB approach, supports type filter + since)
  if (method === 'GET' && path === '/v2/events/stream') {
    const typeFilter = url.searchParams.get('type') || null;
    const sinceParam = url.searchParams.get('since');
    let lastId = sinceParam ? parseInt(sinceParam, 10) : 0;

    res.writeHead(200, {
      'content-type':                'text/event-stream',
      'cache-control':               'no-cache',
      'connection':                  'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering':           'no',
    });
    res.write(': SSE stream connected\n\n');

    const db = getDb();
    const interval = setInterval(() => {
      try {
        const query = typeFilter
          ? `SELECT id, type, payload_json, source, created_at FROM events WHERE id > ? AND type = ? ORDER BY id ASC LIMIT 50`
          : `SELECT id, type, payload_json, source, created_at FROM events WHERE id > ? ORDER BY id ASC LIMIT 50`;
        const rows = typeFilter
          ? db.prepare(query).all(lastId, typeFilter)
          : db.prepare(query).all(lastId);

        for (const row of rows) {
          const data = JSON.stringify({
            id:        row.id,
            type:      row.type,
            source:    row.source,
            createdAt: row.created_at,
            payload:   (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })(),
          });
          res.write(`id: ${row.id}\ndata: ${data}\n\n`);
          lastId = row.id;
        }
        if (rows.length === 0) res.write(': keepalive\n\n');
      } catch { /* DB unavailable, keep connection alive */ }
    }, 2000);

    req.on('close', () => { clearInterval(interval); });
    req.on('error', () => { clearInterval(interval); });
    return true;
  }

  // GET /v2/events/grouped — 24h events grouped by actor (for V4 timeline)
  if (method === 'GET' && path === '/v2/events/grouped') {
    const hours = Math.min(parseInt(url.searchParams.get('hours') || '24', 10), 72);
    const db = getDb();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT e.id, e.type, e.source, e.created_at, e.payload_json
      FROM events e
      WHERE e.created_at >= ? AND e.tenant_id = ?
      ORDER BY e.created_at ASC
      LIMIT 500
    `).all(since, tenantId);

    const grouped = {};
    for (const row of rows) {
      let payload = {};
      try { payload = JSON.parse(row.payload_json); } catch {}
      const actor = payload.actorId || payload.actor_id || payload.owner || 'system';
      if (!grouped[actor]) grouped[actor] = [];
      grouped[actor].push({
        id:        row.id,
        type:      row.type,
        source:    row.source,
        createdAt: row.created_at,
        payload,
      });
    }

    sendV2Json(200, { since, hours, grouped, totalEvents: rows.length });
    return true;
  }

  // GET /v2/tasks/:taskId/explanation — V1 recommendation reason
  const taskExplainMatch = path.match(/^\/v2\/tasks\/([^/]+)\/explanation$/);
  if (method === 'GET' && taskExplainMatch) {
    const taskId = taskExplainMatch[1];
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) { sendV2Error(404, 'task not found'); return true; }

    const { recommendForTask } = await import('../../services/recommender.js');
    const result = await recommendForTask({ taskId, tenantId, options: { explain: true, limit: 3 } });
    const topRec = result.recommendations?.[0];

    sendV2Json(200, {
      taskId,
      topActor: topRec ? {
        actorId:        topRec.actorId,
        displayName:    topRec.displayName,
        type:           topRec.type,
        score:          topRec.score,
        confidence:     topRec.aiConfidence ?? topRec.score / 100,
        explanation:    topRec.explanation || topRec.explainText || null,
        scoreBreakdown: topRec.scoreBreakdown || null,
      } : null,
      allCandidates: (result.recommendations || []).map(r => ({
        actorId: r.actorId, displayName: r.displayName, type: r.type, score: r.score,
      })),
    });
    return true;
  }

  return false;
}
