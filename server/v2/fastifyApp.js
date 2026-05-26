// server/v2/fastifyApp.js
// Fastify v2 路由层（正式迁移，不再是 handleV2 桥接）
//
// 架构：
//   - Fastify 负责：CORS、路由分发（radix tree）、JSON 序列化、请求日志
//   - 各路由模块（routes/*.js）导出 handle(ctx) 被 Fastify handler 调用
//   - SSE 路由（/v2/events/stream）用 reply.hijack() 接管原始流
//   - /v2/sync/webhook 需要原始字节签名验证，通过 req.rawBody 传递
//   - 鉴权逻辑保留在 app.js handleV2 的 ctx 构建前，此文件只负责请求路由
//
// 与 app.js 的分工：
//   app.js (handleV2)  ← 鉴权 + ctx 构建 + 路由模块调度
//   fastifyApp.js      ← Fastify 生命周期 + 体解析 + 连接管理

import Fastify from 'fastify';
import { handleV2 } from './app.js';
import logger from '../logger.js';

// SSE 路径：需要 reply.hijack() + 原始流写入
const SSE_PATHS = new Set(['/v2/events/stream']);

// 各模块的路径前缀（顺序影响 Fastify 路由注册，长前缀优先）
const MODULE_PREFIXES = [
  '/v2/agents',
  '/v2/actors',
  '/v2/memory',
  '/v2/pulls',
  '/v2/reviews',
  '/v2/recommend',
  '/v2/sync',
  '/v2/outcomes',
  '/v2/learning',
  '/v2/autonomy',
  '/v2/space',
  '/v2/risks',
  '/v2/runbooks',
  '/v2/alerts',
  '/v2/observability',
  '/v2/gateway',
  '/v2/openapi.json',
  '/v2/events',
  '/v2/tasks',
  '/v2/info',
];

let _fastify = null;

/**
 * 初始化并返回 Fastify 实例（单例）
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function getFastifyApp() {
  if (_fastify) return _fastify;

  const fastify = Fastify({
    logger:               false,  // 统一使用 pino singleton（server/logger.js）
    ignoreTrailingSlash:  true,
    trustProxy:           true,
    // 关闭 Fastify 内置 body 解析器，改用下面的自定义 content-type parser
    // （目的：在 JSON 解析前捕获原始 Buffer，供 /v2/sync/webhook 签名验证）
  });

  // ── 1. 自定义 JSON content-type parser：解析 JSON 并保留原始字节 ──────────
  // 使用 parseAs:'buffer' 获取原始字节，再手动 JSON.parse
  // req.rawBody = Buffer（供 webhook 签名验证使用）
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
    (req, body, done) => {
      req.raw.rawBody = body;  // 存入底层 IncomingMessage（req.raw），供 sync.js webhook 使用
      // 注意：content-type parser 的 req 是 Fastify Request，req.raw 才是 Node.js IncomingMessage
      if (!body || body.length === 0) { done(null, {}); return; }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        done(null, {});  // JSON 解析失败时返回空对象，不中断请求
      }
    }
  );

  // ── 2. CORS preflight + 响应头 ──────────────────────────────────────────────
  fastify.addHook('onRequest', async (request, reply) => {
    // SSE 路由不在这里设置 CORS（events.js 在 res.writeHead 中设置）
    if (!SSE_PATHS.has(new URL(request.url, 'http://x').pathname)) {
      reply.header('access-control-allow-origin', '*');
    }
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
           .header('access-control-allow-headers', 'content-type,x-cue-api-key,x-api-key,authorization,x-tenant-id')
           .code(204)
           .send('');
    }
  });

  // ── 3. 请求日志（跳过健康检查，避免噪音）──────────────────────────────────
  fastify.addHook('onResponse', async (request, reply) => {
    const ms = Math.round(reply.elapsedTime);
    if (request.url !== '/v2/health') {
      logger.info(`[fastify] ${request.method} ${request.url} → ${reply.statusCode} (${ms}ms)`);
    }
  });

  // ── 4. /v2/health — Fastify 原生（无 hijack，完整生命周期）──────────────
  fastify.get('/v2/health', {
    schema: {
      description: 'V2 系统健康检查',
      response: {
        200: {
          type: 'object',
          properties: {
            ok:        { type: 'boolean' },
            version:   { type: 'string' },
            uptime:    { type: 'number' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    return reply.send({
      ok:        true,
      version:   '2.0',
      uptime:    Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // ── 5. 每个模块前缀注册两条路由（精确 + 子路径通配）──────────────────────
  // 通过 handleV2（app.js）完成鉴权 + 模块调度
  // readBody: 使用 Fastify 已解析的 request.body（避免重复消费流）
  for (const prefix of MODULE_PREFIXES) {
    const isOpenApi = prefix === '/v2/openapi.json';
    // openapi.json 只注册精确路由，其他注册精确 + 通配
    const patterns = isOpenApi ? [prefix] : [prefix, `${prefix}/*`];

    for (const pattern of patterns) {
      fastify.all(pattern, async (request, reply) => {
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        const isSSE = SSE_PATHS.has(url.pathname);

        // SSE 路由：接管原始响应流
        if (isSSE) reply.hijack();

        await handleV2(request.raw, reply.raw, url, {
          // 传入 Fastify 已解析的请求体（解决 stream 被消费问题）
          parsedBody: request.body,
        });
      });
    }
  }

  await fastify.ready();
  _fastify = fastify;

  logger.info('[fastify] V2 ready — native routing per module, body capture enabled, SSE hijack on demand');
  return fastify;
}

/**
 * 重置单例（用于测试）
 */
export function resetFastifyApp() {
  _fastify = null;
}
