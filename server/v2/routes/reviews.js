// server/v2/routes/reviews.js — /v2/reviews/*

import { z } from 'zod';
import { getDb } from '../../db/index.js';

function tryParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

export async function handle(ctx) {
  const { method, path, url, tenantId, readBody, sendV2Json, sendV2Error } = ctx;

  // POST /v2/reviews/trigger
  if (method === 'POST' && path === '/v2/reviews/trigger') {
    const { fetchAndParseDiff } = await import('../../services/diffAnalyzer.js');
    const { mapReduceReview } = await import('../../services/mapReduceReviewer.js');

    const schema = z.object({
      pullId:    z.string(),
      taskId:    z.string().optional(),
      owner:     z.string().optional(),
      repo:      z.string().optional(),
      prNumber:  z.number().int().positive().optional(),
      rawDiff:   z.string().optional(),
      maxFiles:  z.number().int().min(1).max(50).default(20),
    });
    const body = schema.parse(await readBody());
    const db = getDb();

    const pull = db.prepare('SELECT * FROM pulls WHERE id = ? AND tenant_id = ?').get(body.pullId, tenantId);
    if (!pull) { sendV2Error(404, 'pull not found'); return true; }

    let acceptance = '';
    if (body.taskId) {
      const task = db.prepare('SELECT acceptance FROM tasks WHERE id = ? AND tenant_id = ?').get(body.taskId, tenantId);
      acceptance = task?.acceptance || '';
    }
    if (!acceptance && pull.body) {
      const acMatch = pull.body.match(/验收清单[（(]AC[)）][\s\S]*?(?=\n##|\n---|\n$|$)/i);
      if (acMatch) acceptance = acMatch[0];
    }

    let memory = [];
    if (pull.project_id) {
      memory = db.prepare(`
        SELECT kind, body, confidence FROM project_memory
        WHERE tenant_id = ? AND (project_id = ? OR project_id IS NULL)
          AND kind IN ('convention','decision','gotcha','taboo')
          AND superseded_by IS NULL
        ORDER BY confidence DESC LIMIT 15
      `).all(tenantId, pull.project_id);
    }

    let files;
    if (body.rawDiff) {
      const { parseDiffText } = await import('../../services/diffAnalyzer.js');
      files = parseDiffText(body.rawDiff, { maxFileDiffChars: 6000 });
    } else {
      let rawJson = {};
      try { rawJson = JSON.parse(pull.raw_json || '{}'); } catch {}
      const owner    = body.owner || rawJson.head?.repo?.owner?.login;
      const repo     = body.repo  || rawJson.head?.repo?.name;
      const prNumber = body.prNumber || pull.number;

      if (!owner || !repo || !prNumber) {
        sendV2Error(422, 'cannot determine owner/repo/prNumber — pass them explicitly or store in raw_json');
        return true;
      }

      const diffResult = await fetchAndParseDiff({ owner, repo, prNumber, options: { maxFiles: body.maxFiles } });
      files = diffResult.files;
    }

    if (files.length === 0) {
      sendV2Json(200, { ok: true, message: 'no reviewable files in diff', level: 'Pass' });
      return true;
    }

    const result = await mapReduceReview({
      files, prTitle: pull.title || '(无标题)', acceptance, memory,
      tenantId, pullId: body.pullId, taskId: body.taskId,
    });

    if (result.level === 'Block' || result.level === 'Escalate') {
      const { broadcast } = await import('../../adapters/index.js');
      await broadcast(
        `🚨 **PR Review ${result.level}**\n\n` +
        `PR：\`${pull.title || body.pullId}\`\n` +
        `问题：${result.suggestion}\n` +
        `共 ${result.stats.critical} critical / ${result.stats.major} major issue`,
        { urgency: 'high' }
      ).catch(() => {});

      // E3 次路：建修复任务 + 设 task.blocked（SPEC-E3）
      const { handleReviewOutcome } = await import('../../services/reviewTaskLinker.js');
      const { updateStore } = await import('../../store.js');
      await handleReviewOutcome(
        { id: `rev_${body.pullId}_${result.level}`, level: result.level, suggestion: result.suggestion, taskId: body.taskId },
        updateStore
      ).catch((err) => import('../../logger.js').then(({ default: log }) => log.warn('[E3] reviews.js handleReviewOutcome 失败:', err.message)).catch(() => {}));
    }

    sendV2Json(200, { ok: true, ...result });
    return true;
  }

  // GET /v2/reviews
  if (method === 'GET' && path === '/v2/reviews') {
    const db = getDb();
    const pullId = url.searchParams.get('pullId') || null;
    const taskId = url.searchParams.get('taskId') || null;
    const limit  = Math.min(Number(url.searchParams.get('limit') || 20), 100);

    const rows = db.prepare(`
      SELECT * FROM reviews
      WHERE tenant_id = ?
        AND (? IS NULL OR pull_id = ?)
        AND (? IS NULL OR task_id = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(tenantId, pullId, pullId, taskId, taskId, limit);

    sendV2Json(200, rows.map(r => ({
      id: r.id, pullId: r.pull_id, taskId: r.task_id, source: r.source,
      level: r.level, suggestion: r.suggestion, compliance: tryParseJson(r.compliance_json, {}),
      issueCount: (() => { try { return JSON.parse(r.findings_json || '[]').length; } catch { return 0; } })(),
      createdAt: r.created_at,
    })));
    return true;
  }

  return false;
}
