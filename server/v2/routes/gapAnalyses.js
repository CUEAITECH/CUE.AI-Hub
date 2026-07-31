// server/v2/routes/gapAnalyses.js — /v2/gap-analyses/*
// L4-c: PR 业务缺口分析读取 + 手动补跑（SPEC-L4c REQ-003 / REQ-006）

import { z } from 'zod';

export async function handle(ctx) {
  const { method, path, url, tenantId, readBody, sendV2Json, sendV2Error } = ctx;

  if (!path.startsWith('/v2/gap-analyses')) return false;

  const { loadStore, updateStore } = await import('../../store.js');

  // GET /v2/gap-analyses[?taskId=] — 列出当前租户的缺口分析记录
  if (method === 'GET' && path === '/v2/gap-analyses') {
    const store = await loadStore(tenantId);
    const filterTaskId = url.searchParams.get('taskId') || null;
    const all = Object.values(store.gapAnalyses || {});
    const items = all
      .filter((g) => !g.tenantId || g.tenantId === tenantId)
      .filter((g) => !filterTaskId || g.taskId === filterTaskId)
      .sort((a, b) => String(b.analyzedAt || '').localeCompare(String(a.analyzedAt || '')));
    sendV2Json(200, { items, total: items.length });
    return true;
  }

  // POST /v2/gap-analyses/run { pullId } — 手动补跑单个 PR 的缺口分析
  if (method === 'POST' && path === '/v2/gap-analyses/run') {
    const schema = z.object({ pullId: z.string().min(1) });
    const { pullId } = schema.parse(await readBody());

    const store = await loadStore(tenantId);
    const pull = (store.pulls || []).find((p) => p.id === pullId);
    if (!pull) { sendV2Error(404, `pull ${pullId} not found`); return true; }

    const { analyzeGap } = await import('../../services/gapAnalyzer.js');
    const result = await analyzeGap(pull, store, updateStore, tenantId);

    if (result.skipped) {
      sendV2Json(200, { ok: true, skipped: true, reason: result.reason });
    } else {
      sendV2Json(200, { ok: true, analysis: result.analysis });
    }
    return true;
  }

  sendV2Error(404, `v2 route not found: ${method} ${path}`);
  return true;
}
