// server/v2/app.js
// V2 路由层 — 纯 Node.js http 模块（无框架，与 v1 handleApi 模式一致）
//
// 拆分结构（每域一文件，export async function handle(ctx)）：
//   routes/system.js         ← /v2/health, /v2/info
//   routes/actors.js         ← /v2/actors/*
//   routes/agents.js         ← /v2/agents/*
//   routes/memory.js         ← /v2/memory/*
//   routes/pulls.js          ← /v2/pulls/*
//   routes/reviews.js        ← /v2/reviews/*
//   routes/recommend.js      ← /v2/recommend/*
//   routes/sync.js           ← /v2/sync/*
//   routes/outcomes.js       ← /v2/outcomes/*
//   routes/gapAnalyses.js    ← /v2/gap-analyses/*
//   routes/learning.js       ← /v2/learning/*
//   routes/observability.js  ← /v2/space, /v2/risks, /v2/runbooks, /v2/alerts, /v2/observability/*
//   routes/gateway.js        ← /v2/openapi.json, /v2/gateway/*
//   routes/autonomy.js       ← /v2/autonomy/*
//   routes/events.js         ← /v2/events/*, /v2/tasks/:taskId/explanation

import { z } from 'zod';
import {
  gatewayAuth,
  extractApiKey,
  auditLog,
} from '../middleware/apiGateway.js';
import { getSessionToken, verifySessionToken } from '../services/auth.js';
import logger from '../logger.js';

// ── 按 path prefix 延迟加载对应路由模块 ───────────────────────────
const ROUTE_MODULES = [
  // 顺序敏感：优先匹配更具体的路径前缀
  ['/v2/agents',       () => import('./routes/agents.js')],
  ['/v2/actors',       () => import('./routes/actors.js')],
  ['/v2/memory',       () => import('./routes/memory.js')],
  ['/v2/pulls',        () => import('./routes/pulls.js')],
  ['/v2/reviews',      () => import('./routes/reviews.js')],
  ['/v2/recommend',    () => import('./routes/recommend.js')],
  ['/v2/sync',         () => import('./routes/sync.js')],
  ['/v2/outcomes',     () => import('./routes/outcomes.js')],
  ['/v2/gap-analyses', () => import('./routes/gapAnalyses.js')],
  ['/v2/learning',     () => import('./routes/learning.js')],
  ['/v2/autonomy',     () => import('./routes/autonomy.js')],
  ['/v2/space',        () => import('./routes/observability.js')],
  ['/v2/risks',        () => import('./routes/observability.js')],
  ['/v2/runbooks',     () => import('./routes/observability.js')],
  ['/v2/alerts',       () => import('./routes/observability.js')],
  ['/v2/observability',() => import('./routes/observability.js')],
  ['/v2/gateway',      () => import('./routes/gateway.js')],
  ['/v2/openapi.json', () => import('./routes/gateway.js')],
  ['/v2/events',       () => import('./routes/events.js')],
  ['/v2/tasks',        () => import('./routes/events.js')],
  ['/v2/config',       () => import('./routes/config.js')],
  ['/v2/health',       () => import('./routes/system.js')],
  ['/v2/info',         () => import('./routes/system.js')],
];

// Module cache (Map<loader, Promise<module>>)
const _moduleCache = new Map();

async function loadModule(loader) {
  if (_moduleCache.has(loader)) return _moduleCache.get(loader);
  const p = loader();
  _moduleCache.set(loader, p);
  return p;
}

// ── 鉴权豁免路径 ──────────────────────────────────────────────────
const V2_AUTH_EXEMPT = new Set([
  '/v2/health',
  '/v2/info',
  '/v2/openapi.json',
  '/v2/gateway/validate',
]);

// ── 辅助函数 ──────────────────────────────────────────────────────
function sendV2JsonFn(res) {
  return (statusCode, data) => {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'content-type':                'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control':               'no-cache',
    });
    res.end(body);
  };
}

function sendV2ErrorFn(res) {
  const send = sendV2JsonFn(res);
  return (statusCode, message, details) =>
    send(statusCode, { error: message, ...(details ? { details } : {}) });
}

/**
 * 读取请求体
 * - Fastify 路径：body 已由自定义 content-type parser 解析，parsedBody 非 undefined，直接返回
 * - 直接调用路径（server/index.js bypass）：流式读取并 JSON.parse
 */
async function readBody(req, parsedBody) {
  if (parsedBody !== undefined) return parsedBody;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────
// resolveAuthContext — 单一权威鉴权函数
//
// 规则（优先级从高到低）：
//   1. cue_ API key  → DB 校验，tenantId 从密钥记录读取（最可信）
//   2. Session + gateway 路径 → 需 admin/project_admin 角色，tenantId 从 JWT 读取
//   3. Session + 只读请求（GET/HEAD） → 直接放行，tenantId 从 JWT 读取
//   4. Legacy CUE_API_KEY 环境变量 → 写操作 + 无 session 时校验（向下兼容 v1）
//   5. 其余 → 放行，tenantId 降级为请求头或 'default'
//
// 返回值（ok=true）：
//   { ok: true, tenantId, userId, role, keyPrefix, rateLimitInfo? }
// 返回值（ok=false）：
//   { ok: false, errorCode, errorMessage, rateLimitInfo? }
//
// 注意：tenantId 和 projectId 在当前架构中是同义词（1项目 = 1租户）。
// JWT 同时存储两者（见 auth.js createSessionToken），这里统一读取 tenantId。
// ─────────────────────────────────────────────────────────────────
const GATEWAY_ADMIN_ROLES = new Set(['admin', 'project_admin']);

async function resolveAuthContext(req, path, method) {
  const rawKey = extractApiKey(req);
  const session = verifySessionToken(getSessionToken(req));

  // ── 1. cue_ API key（优先级最高，DB 校验，不可伪造）──────────────
  if (rawKey?.startsWith('cue_')) {
    const auth = await gatewayAuth(req);
    if (!auth.ok) {
      return {
        ok: false,
        errorCode:    auth.errorCode,
        errorMessage: auth.errorMessage,
        rateLimitInfo: auth.rateLimitInfo,
      };
    }
    return {
      ok:           true,
      tenantId:     auth.tenantId,
      userId:       null,
      role:         null,
      keyPrefix:    auth.keyPrefix,
      rateLimitInfo: auth.rateLimitInfo,
    };
  }

  // ── 2. Session + gateway 管理端点 ──────────────────────────────────
  // gateway 路径必须有 session，legacy key 不可访问（防止 env key 泄漏后被滥用）
  if (path.startsWith('/v2/gateway/')) {
    if (!session) {
      return { ok: false, errorCode: 401, errorMessage: 'gateway management requires a valid session — please log in' };
    }
    if (!GATEWAY_ADMIN_ROLES.has(session.role)) {
      return { ok: false, errorCode: 403, errorMessage: 'gateway management requires admin or project_admin role' };
    }
    // 从 JWT 读 tenantId(=orgId)，忽略请求头（防止 project_admin 伪造 X-Tenant-Id 跨租户操作）
    // admin → 'default'（系统级）；其余 → 自己的组织（orgId）
    const tenantId = session.role === 'admin'
      ? 'default'
      : (session.orgId || session.tenantId || 'default');
    return { ok: true, tenantId, userId: session.sub, role: session.role, keyPrefix: null };
  }

  // ── 3. Session + 只读请求（GET/HEAD）──────────────────────────────
  const isReadOnly = method === 'GET' || method === 'HEAD';
  if (session && isReadOnly) {
    const tenantId = session.orgId || session.tenantId || 'default';
    return { ok: true, tenantId, userId: session.sub, role: session.role, keyPrefix: null };
  }

  // ── 4. Legacy CUE_API_KEY（向下兼容 v1）──────────────────────────
  // 适用范围：无 session 的任意请求 + session 的写操作
  const cueApiKey = process.env.CUE_API_KEY;
  if (cueApiKey) {
    const provided = req.headers?.['x-cue-api-key'];
    if (provided !== cueApiKey) {
      return {
        ok: false,
        errorCode:    401,
        errorMessage: 'invalid API key — use Authorization: Bearer cue_xxx or X-CUE-API-Key',
      };
    }
  }

  // ── 5. 放行（session 写操作通过 legacy 校验 / 无 env key / 匿名）──
  // tenantId 优先级：JWT session(orgId) > 请求头（用户可控，仅作提示） > 'default'
  const tenantId = (session && (session.orgId || session.tenantId))
    || req.headers['x-tenant-id']
    || 'default';
  return {
    ok:       true,
    tenantId,
    userId:   session?.sub  ?? null,
    role:     session?.role ?? null,
    keyPrefix: null,
  };
}

/**
 * V2 路由主处理函数
 * 由 server/index.js 在 pathname.startsWith('/v2/') 时调用
 * @param {object} [fastifyCtx] - Fastify 上下文（可选）
 * @param {object} [fastifyCtx.parsedBody] - Fastify 已解析的请求体
 * @returns {Promise<boolean>} 是否已处理
 */
export async function handleV2(req, res, url, fastifyCtx = {}) {
  const method = req.method;
  const path   = url.pathname;
  const startTs = Date.now();

  // ── CORS preflight ───────────────────────────────────────────────
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-cue-api-key, x-cue-session-token, x-api-key, authorization, x-tenant-id',
    });
    res.end();
    return true;
  }

  // ── 拦截 writeHead 记录响应状态码（用于审计日志）────────────────
  let _capturedStatus = 200;
  const _origWriteHead = res.writeHead.bind(res);
  res.writeHead = (code, ...rest) => { _capturedStatus = code; return _origWriteHead(code, ...rest); };

  // ── 鉴权：统一通过 resolveAuthContext 处理 ────────────────────────
  let tenantId     = 'default';
  let _keyPrefix   = null;

  if (!V2_AUTH_EXEMPT.has(path)) {
    const authCtx = await resolveAuthContext(req, path, method);

    if (!authCtx.ok) {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
      if (authCtx.errorCode === 429 && authCtx.rateLimitInfo) {
        headers['x-ratelimit-limit']     = String(authCtx.rateLimitInfo.limit);
        headers['x-ratelimit-remaining'] = '0';
        headers['x-ratelimit-reset']     = String(Math.ceil(authCtx.rateLimitInfo.resetAt / 1000));
      }
      res.writeHead(authCtx.errorCode, headers);
      res.end(JSON.stringify({ error: authCtx.errorMessage }));
      return true;
    }

    tenantId   = authCtx.tenantId;
    _keyPrefix = authCtx.keyPrefix;

    // 成功通过 cue_ key 时：在后续响应头中注入 rate limit 信息
    if (authCtx.rateLimitInfo) {
      const rl = authCtx.rateLimitInfo;
      const _prevWH = res.writeHead.bind(res);
      res.writeHead = (code, hdrs, ...rest) => {
        const merged = typeof hdrs === 'object' ? hdrs : {};
        merged['x-ratelimit-limit']     = String(rl.limit);
        merged['x-ratelimit-remaining'] = String(rl.remaining);
        merged['x-ratelimit-reset']     = String(Math.ceil(rl.resetAt / 1000));
        return _prevWH(code, merged, ...rest);
      };
    }
  }

  // ── 构建路由上下文（传给各路由模块）────────────────────────────
  const { parsedBody } = fastifyCtx;
  const sendV2Json  = sendV2JsonFn(res);
  const sendV2Error = sendV2ErrorFn(res);
  const ctx = {
    method, path, url,
    tenantId,   // 已解析（来自 DB/JWT/header，顺序见 resolveAuthContext）
    req, res,
    readBody:   () => readBody(req, parsedBody),
    sendV2Json,
    sendV2Error,
  };

  try {
    // ── 按 path prefix 查找并调用路由模块 ────────────────────────
    const seen = new Set(); // 防止同一模块被调用两次（多个前缀指向同一模块）
    for (const [prefix, loader] of ROUTE_MODULES) {
      if (!path.startsWith(prefix)) continue;
      if (seen.has(loader)) continue;
      seen.add(loader);

      const mod = await loadModule(loader);
      const handled = await mod.handle(ctx);
      if (handled) return true;
    }

    // ── 未匹配 ───────────────────────────────────────────────────
    sendV2Error(404, `v2 route not found: ${method} ${path}`);
    return true;

  } catch (err) {
    if (err instanceof z.ZodError) {
      sendV2Error(400, 'validation error', err.errors);
      return true;
    }
    logger.error('[v2] error:', method, path, err.message);
    sendV2Error(500, err.message || 'internal error');
    return true;

  } finally {
    // ── 审计日志（fire and forget，仅 cue_ key 请求）──────────────
    if (_keyPrefix) {
      auditLog({
        tenantId,
        keyPrefix:  _keyPrefix,
        method,
        path,
        statusCode: _capturedStatus,
        latencyMs:  Date.now() - startTs,
        ip:         req.socket?.remoteAddress,
        userAgent:  req.headers?.['user-agent'],
      });
    }
  }
}
