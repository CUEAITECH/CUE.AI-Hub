// server/v2/routes/memory.js — /v2/memory/*

import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { dbWrite } from '../../db/actor.js';
import logger from '../../logger.js';

const MemoryCreateSchema = z.object({
  kind: z.enum(['convention', 'decision', 'gotcha', 'pattern', 'taboo', 'success-case', 'failure-case']),
  body: z.string().min(10).max(2000),
  projectId: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  evidenceRefs: z.string().optional(),
});

const MemoryUpdateSchema = z.object({
  body: z.string().min(10).max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  supersededBy: z.number().int().optional(),
});

export async function handle(ctx) {
  const { method, path, url, tenantId, readBody, sendV2Json, sendV2Error } = ctx;

  // GET /v2/memory/stats — must come before the generic /v2/memory/:id match
  if (method === 'GET' && path === '/v2/memory/stats') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT kind, COUNT(*) as count, AVG(confidence) as avgConfidence
      FROM project_memory
      WHERE tenant_id = ? AND superseded_by IS NULL
      GROUP BY kind
      ORDER BY count DESC
    `).all(tenantId);
    sendV2Json(200, { stats: rows, total: rows.reduce((s, r) => s + r.count, 0) });
    return true;
  }

  // GET /v2/memory
  if (method === 'GET' && path === '/v2/memory') {
    const db = getDb();
    const projectId = url.searchParams.get('projectId') || null;
    const kind      = url.searchParams.get('kind') || null;
    const limit     = Math.min(Number(url.searchParams.get('limit') || 50), 200);

    const rows = db.prepare(`
      SELECT * FROM project_memory
      WHERE tenant_id = ?
        AND (? IS NULL OR project_id = ?)
        AND (? IS NULL OR kind = ?)
        AND superseded_by IS NULL
      ORDER BY confidence DESC, id DESC
      LIMIT ?
    `).all(tenantId, projectId, projectId, kind, kind, limit);

    sendV2Json(200, rows.map(m => ({
      id: m.id, kind: m.kind, body: m.body, projectId: m.project_id,
      confidence: m.confidence, source: m.source, evidenceRefs: m.evidence_refs,
      validatedAt: m.validated_at, createdAt: m.created_at,
    })));
    return true;
  }

  // POST /v2/memory
  if (method === 'POST' && path === '/v2/memory') {
    const body = MemoryCreateSchema.parse(await readBody());
    const now = new Date().toISOString();

    const id = await dbWrite('v2:memory.create', (db) => {
      const result = db.prepare(`
        INSERT INTO project_memory
          (tenant_id, project_id, kind, body, confidence, source, evidence_refs, created_at)
        VALUES (?, ?, ?, ?, ?, 'human-added', ?, ?)
      `).run(tenantId, body.projectId || null, body.kind, body.body, body.confidence, body.evidenceRefs || null, now);
      return result.lastInsertRowid;
    });

    const { indexMemoryEntry } = await import('../../services/vectorStore.js');
    indexMemoryEntry(getDb(), { memoryId: Number(id), text: body.body });

    logger.info(`[v2] memory created: id=${id} kind=${body.kind} tenant=${tenantId}`);
    sendV2Json(201, { id, kind: body.kind, body: body.body, source: 'human-added', createdAt: now });
    return true;
  }

  // PATCH /v2/memory/:id and DELETE /v2/memory/:id
  const memoryMatch = path.match(/^\/v2\/memory\/(\d+)$/);
  if (memoryMatch) {
    const memId = Number(memoryMatch[1]);

    if (method === 'PATCH') {
      const body = MemoryUpdateSchema.parse(await readBody());
      const db = getDb();

      const existing = db.prepare('SELECT * FROM project_memory WHERE id = ? AND tenant_id = ?').get(memId, tenantId);
      if (!existing) { sendV2Error(404, 'memory entry not found'); return true; }

      const updates = [];
      const params = [];
      if (body.body !== undefined)        { updates.push('body = ?');          params.push(body.body); }
      if (body.confidence !== undefined)  { updates.push('confidence = ?');    params.push(body.confidence); }
      if (body.supersededBy !== undefined){ updates.push('superseded_by = ?'); params.push(body.supersededBy); }

      if (updates.length === 0) { sendV2Error(400, 'no fields to update'); return true; }

      await dbWrite('v2:memory.update', (db) => {
        db.prepare(`UPDATE project_memory SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`)
          .run(...params, memId, tenantId);
      });

      if (body.body !== undefined) {
        const { indexMemoryEntry } = await import('../../services/vectorStore.js');
        indexMemoryEntry(getDb(), { memoryId: memId, text: body.body });
      }

      const updated = db.prepare('SELECT * FROM project_memory WHERE id = ?').get(memId);
      sendV2Json(200, { id: updated.id, kind: updated.kind, body: updated.body, confidence: updated.confidence, supersededBy: updated.superseded_by });
      return true;
    }

    if (method === 'DELETE') {
      const db = getDb();
      const existing = db.prepare('SELECT id FROM project_memory WHERE id = ? AND tenant_id = ?').get(memId, tenantId);
      if (!existing) { sendV2Error(404, 'memory entry not found'); return true; }

      await dbWrite('v2:memory.delete', (db) => {
        db.prepare('UPDATE project_memory SET superseded_by = ? WHERE id = ? AND tenant_id = ?')
          .run(memId, memId, tenantId);
      });

      sendV2Json(200, { ok: true, id: memId, superseded: true });
      return true;
    }
  }

  return false;
}
