// server/v2/fastifyApp.js
// Part N.1: Fastify 替换裸 http（v2 路由层）
//
// 架构决策：
//   - Fastify 4.x 在 Node.js v24 ESM 下工作正常（原 v2/app.js 注释中的兼容性顾虑已解决）
//   - 采用"插件包装 + 渐进迁移"策略：
//     1. 创建 Fastify 实例，注册 CORS / Content-Type hooks
//     2. 核心路由（health / actors / tasks / agents）用 Fastify 原生注册
//     3. 其余复杂路由委托给现有 handleV2（裸 http），通过 inject 桥接
//   - 这样：新路由享受 Fastify schema 验证 + OpenAPI；旧逻辑零风险保留
//
// 集成方式（server/index.js）：
//   import { getFastifyApp } from './v2/fastifyApp.js';
//   const fastify = await getFastifyApp();
//   // 替换: await handleV2(req, res, url)
//   // 新的: fastify.routing()(req, res)    — 直接接管 /v2/* 请求

import Fastify from 'fastify';
import { handleV2 } from './app.js';
import logger from '../logger.js';

let _fastify = null;

/**
 * 初始化并返回 Fastify 实例（单例）
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function getFastifyApp() {
  if (_fastify) return _fastify;

  const fastify = Fastify({
    // 关闭 Fastify 内置 logger，统一用 pino singleton（server/logger.js）
    logger: false,
    // 不自动 Content-Type 解析（v2/app.js 用 readBody() 手动解析）
    ignoreTrailingSlash: true,
    trustProxy: true,
  });

  // ── CORS hook ───────────────────────────────────────────────────
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,X-CUE-API-Key,Authorization,X-Tenant-Id');
    if (request.method === 'OPTIONS') {
      reply.status(204).send('');
    }
  });

  // ── 请求日志 hook ──────────────────────────────────────────────
  fastify.addHook('onResponse', async (request, reply) => {
    const ms = Math.round(reply.elapsedTime);
    if (request.url !== '/v2/health') {
      logger.info(`[fastify] ${request.method} ${request.url} → ${reply.statusCode} (${ms}ms)`);
    }
  });

  // ── Health endpoint（Fastify 原生注册，零开销）─────────────────
  fastify.get('/v2/health', {
    schema: {
      description: 'V2 系统健康检查',
      tags: ['system'],
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            version: { type: 'string' },
            uptime: { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    return reply.send({
      ok: true,
      version: '2.0',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // ── 其余 /v2/* 路由：委托给现有 handleV2（裸 http 桥接）───────
  // 原因：handleV2 包含大量业务逻辑，全量迁移需拆分，此处先桥接保障稳定
  // 迁移路线图：每周将 1-2 个复杂路由迁移为 Fastify 原生，最终删除此 fallback
  fastify.all('/v2/*', async (request, reply) => {
    const { req, res } = request.raw
      ? { req: request.raw, res: reply.raw }
      : { req: request, res: reply };

    // 需要 reply 不被 Fastify 提前关闭，用 hijack 接管
    reply.hijack();
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    await handleV2(req, res, url);
  });

  await fastify.ready();
  _fastify = fastify;

  logger.info('[fastify] V2 Fastify app ready — health on Fastify native, all else via handleV2 bridge');
  return fastify;
}

/**
 * 重置单例（用于测试）
 */
export function resetFastifyApp() {
  _fastify = null;
}
