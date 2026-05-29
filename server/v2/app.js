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
  ensureGatewayTables,
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
  // Fastify 已解析（parsedBody 由 fastifyApp.js 传入，避免重复消费流）
  if (parsedBody !== undefined) return parsedBody;
  // 直接调用路径：流式读取
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

  // ── API Gateway 鉴权 ──────────────────────────────────────────────
  let tenantId = req.headers['x-tenant-id'] || 'default';
  let _authKeyPrefix = null;

  if (!V2_AUTH_EXEMPT.has(path)) {
    const rawKey = extractApiKey(req);
    const session = verifySessionToken(getSessionToken(req));
    const readOnlySession = session && (method === 'GET' || method === 'HEAD');

    if (rawKey?.startsWith('cue_')) {
      // V2 API Key — 完整 gateway 校验（rate limit + 多租户隔离 + 审计）
      const auth = await gatewayAuth(req, tenantId !== 'default' ? tenantId : undefined);
      if (!auth.ok) {
        const headers = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
        if (auth.errorCode === 429 && auth.rateLimitInfo) {
          headers['x-ratelimit-limit']     = String(auth.rateLimitInfo.limit);
          headers['x-ratelimit-remaining'] = '0';
          headers['x-ratelimit-reset']     = String(Math.ceil(auth.rateLimitInfo.resetAt / 1000));
        }
        res.writeHead(auth.errorCode, headers);
        res.end(JSON.stringify({ error: auth.errorMessage }));
        return true;
      }
      tenantId = auth.tenantId;
      _authKeyPrefix = auth.keyPrefix;

      if (auth.rateLimitInfo) {
        const rl = auth.rateLimitInfo;
        const _prevWH = res.writeHead.bind(res);
        res.writeHead = (code, hdrs, ...rest) => {
          const merged = typeof hdrs === 'object' ? hdrs : {};
          merged['x-ratelimit-limit']     = String(rl.limit);
          merged['x-ratelimit-remaining'] = String(rl.remaining);
          merged['x-ratelimit-reset']     = String(Math.ceil(rl.resetAt / 1000));
          return _prevWH(code, merged, ...rest);
        };
      }
    } else if (path.startsWith('/v2/gateway/')) {
      // Gateway 管理端点：要求有效 session 且角色为 admin 或 project_admin
      // role 已由 createSessionToken 签入 JWT payload，verifySessionToken 直接返回
      const GATEWAY_ADMIN_ROLES = new Set(['admin', 'project_admin']);
      const isGatewayAdmin = session && GATEWAY_ADMIN_ROLES.has(session.role);
      if (!session) {
        const sendErr = sendV2ErrorFn(res);
        sendErr(401, 'gateway management requires a valid session — please log in');
        return true;
      }
      if (!isGatewayAdmin) {
        const sendErr = sendV2ErrorFn(res);
        sendErr(403, 'gateway management requires admin or project_admin role');
        return true;
      }
    } else if (!readOnlySession) {
      // Legacy CUE_API_KEY（向下兼容 v1，非 gateway 路径）
      const cueApiKey = process.env.CUE_API_KEY;
      if (cueApiKey) {
        const provided = req.headers?.['x-cue-api-key'];
        if (provided !== cueApiKey) {
          const sendErr = sendV2ErrorFn(res);
          sendErr(401, 'invalid API key — use Authorization: Bearer cue_xxx or X-CUE-API-Key');
          return true;
        }
      }
    }
  }

  // ── 构建路由上下文（传给各路由模块）────────────────────────────
  const { parsedBody } = fastifyCtx;
  const sendV2Json = sendV2JsonFn(res);
  const sendV2Error = sendV2ErrorFn(res);
  const ctx = {
    method, path, url, tenantId,
    req, res,
    // parsedBody 由 Fastify 的自定义 content-type parser 传入（见 fastifyApp.js）
    // 避免重复消费流；直接调用路径时 parsedBody=undefined，回退到流式读取
    readBody: () => readBody(req, parsedBody),
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
    if (_authKeyPrefix) {
      auditLog({
        tenantId,
        keyPrefix: _authKeyPrefix,
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
