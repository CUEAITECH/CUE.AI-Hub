// server/v2/routes/gateway.js — /v2/openapi.json, /v2/gateway/*

import { z } from 'zod';
import { extractApiKey } from '../../middleware/apiGateway.js';

export async function handle(ctx) {
  const { method, path, url, tenantId, req, readBody, sendV2Json, sendV2Error } = ctx;

  // GET /v2/openapi.json
  if (method === 'GET' && path === '/v2/openapi.json') {
    const spec = {
      openapi: '3.0.0',
      info: {
        title: 'CUE Project Hub API v2',
        version: '2.0.0',
        description: 'CUE 团队内部 AI 研发交付指挥系统 — v2 公开 API',
        contact: { url: 'https://hub.cueai.top' },
      },
      servers: [{ url: `${process.env.HUB_URL || 'https://hub.cueai.top'}/v2`, description: '生产环境' }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'cue_<tenantId>_<hex32>' },
        },
      },
      paths: {
        '/actors': { get: { summary: '列出 Actor', tags: ['actors'] }, post: { summary: '创建 Actor', tags: ['actors'] } },
        '/tasks':  { get: { summary: '列出任务',  tags: ['tasks'] },   post: { summary: '创建任务', tags: ['tasks'] } },
        '/health': { get: { summary: '系统健康度', tags: ['observability'] } },
        '/space':  { get: { summary: 'SPACE 效能指标', tags: ['observability'] } },
        '/risks':  { get: { summary: '风险列表', tags: ['risk'] } },
        '/runbooks': { get: { summary: 'Runbook 列表', tags: ['runbooks'] } },
        '/alerts/evaluate': { get: { summary: '评估告警', tags: ['runbooks'] } },
        '/learning/weekly-batch': { post: { summary: '触发周度学习批处理', tags: ['learning'] } },
        '/learning/reports': { get: { summary: '列出学习报告', tags: ['learning'] } },
        '/autonomy': { get: { summary: '列出 Agent 自主级别', tags: ['autonomy'] } },
        '/autonomy/auto-adjust': { post: { summary: '自动调整所有 Agent 自主级别', tags: ['autonomy'] } },
        '/gateway/keys': {
          get:  { summary: '列出 API Keys', tags: ['gateway'] },
          post: { summary: '生成新 API Key', tags: ['gateway'] },
        },
        '/gateway/keys/{id}/revoke': { post: { summary: '撤销 API Key', tags: ['gateway'] } },
        '/gateway/audit': { get: { summary: '查询审计日志', tags: ['gateway'] } },
        '/gateway/validate': { get: { summary: '验证当前 API Key', tags: ['gateway'] } },
      },
    };
    sendV2Json(200, spec);
    return true;
  }

  // POST /v2/gateway/keys
  if (method === 'POST' && path === '/v2/gateway/keys') {
    const { generateApiKey } = await import('../../middleware/apiGateway.js');
    const { name, scopes, rateLimit, expiresAt } = z.object({
      name:      z.string().optional(),
      scopes:    z.array(z.string()).optional(),
      rateLimit: z.number().int().min(1).max(10000).optional(),
      expiresAt: z.string().optional(),
    }).parse(await readBody());

    const result = await generateApiKey({ tenantId, name, scopes, rateLimit, expiresAt });
    sendV2Json(201, { ...result, warning: 'Store this key securely — it cannot be retrieved again' });
    return true;
  }

  // GET /v2/gateway/keys
  if (method === 'GET' && path === '/v2/gateway/keys') {
    const { listApiKeys } = await import('../../middleware/apiGateway.js');
    const keys = listApiKeys({ tenantId });
    sendV2Json(200, { keys, count: keys.length });
    return true;
  }

  // POST /v2/gateway/keys/:id/revoke
  if (method === 'POST' && path.match(/^\/v2\/gateway\/keys\/\d+\/revoke$/)) {
    const keyId = parseInt(path.split('/')[4], 10);
    const { revokeApiKey } = await import('../../middleware/apiGateway.js');
    const ok = await revokeApiKey({ tenantId, keyId });
    if (!ok) { sendV2Error(404, 'API key not found or already revoked'); return true; }
    sendV2Json(200, { revoked: true, keyId });
    return true;
  }

  // GET /v2/gateway/audit
  if (method === 'GET' && path === '/v2/gateway/audit') {
    const { queryAuditLog } = await import('../../middleware/apiGateway.js');
    sendV2Json(200, queryAuditLog({
      tenantId,
      path:   url.searchParams.get('path') || undefined,
      since:  url.searchParams.get('since') || undefined,
      limit:  Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)),
      offset: parseInt(url.searchParams.get('offset') || '0', 10),
    }));
    return true;
  }

  // GET /v2/gateway/validate — auth-exempt, uses req directly
  if (method === 'GET' && path === '/v2/gateway/validate') {
    const rawKey = extractApiKey(req);
    const { validateApiKey } = await import('../../middleware/apiGateway.js');
    if (!rawKey?.startsWith('cue_')) {
      sendV2Json(200, { valid: false, reason: 'not a v2 API key (must start with cue_)' });
      return true;
    }
    const info = await validateApiKey(rawKey);
    if (!info) {
      sendV2Json(200, { valid: false, reason: 'invalid or expired key' });
      return true;
    }
    sendV2Json(200, { valid: true, tenantId: info.tenantId, scopes: info.scopes, rateLimit: info.rateLimit });
    return true;
  }

  return false;
}
