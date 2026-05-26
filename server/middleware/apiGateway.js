// server/middleware/apiGateway.js
// W16: 公开 API 网关 — API Key 认证 + Rate Limiting + 多租户隔离
//
// 设计原则：
//   - API Key 格式：cue_<tenantId>_<32位随机 hex>
//   - Rate Limit：默认 100 req/min per tenant（可配置）
//   - 多租户隔离：从 API Key 提取 tenantId，强制绑定请求上下文
//   - 审计日志：记录每次 API 调用（路由 + tenantId + latency）
//
// 不依赖 Redis：纯内存滑动窗口（适合单进程）

import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';

// ══════════════════════════════════════════════════════════════
// 常量与配置
// ══════════════════════════════════════════════════════════════

const DEFAULT_RATE_LIMIT = parseInt(process.env.API_RATE_LIMIT || '100', 10);
const RATE_WINDOW_MS = 60 * 1000; // 1 分钟滑动窗口

// 内存中的 rate limit 计数器（仅单进程，生产环境换 Redis）
// Map<apiKeyHash, { count: number, windowStart: number }>
const _rateLimitState = new Map();

// ══════════════════════════════════════════════════════════════
// 表初始化
// ══════════════════════════════════════════════════════════════

export function ensureGatewayTables() {
  const db = getDb();

  // API Key 注册表
  db.prepare(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      key_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of the key
      key_prefix  TEXT NOT NULL,         -- 前 8 位（用于展示，不泄漏完整 key）
      name        TEXT,                  -- 用途描述（如 "production-server"）
      scopes      TEXT NOT NULL DEFAULT '["read","write"]',  -- JSON array
      rate_limit  INTEGER NOT NULL DEFAULT 100,              -- req/min
      active      BOOLEAN NOT NULL DEFAULT 1,
      last_used   DATETIME,
      expires_at  DATETIME,
      created_at  DATETIME NOT NULL
    )
  `).run();

  // API 调用审计日志
  db.prepare(`
    CREATE TABLE IF NOT EXISTS api_audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      key_prefix  TEXT,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status_code INTEGER,
      latency_ms  INTEGER,
      ip          TEXT,
      user_agent  TEXT,
      created_at  DATETIME NOT NULL
    )
  `).run();
}

// ══════════════════════════════════════════════════════════════
// API Key 管理
// ══════════════════════════════════════════════════════════════

/**
 * 生成新的 API Key
 * 格式：cue_<tenantId>_<32位随机 hex>
 *
 * @returns {Promise<object>} { key, keyPrefix, keyHash, id }
 */
export async function generateApiKey({ tenantId, name, scopes = ['read', 'write'], rateLimit = DEFAULT_RATE_LIMIT, expiresAt }) {
  ensureGatewayTables();

  // 生成随机 key
  const { randomBytes, createHash } = await import('crypto');
  const rawKey = `cue_${tenantId}_${randomBytes(16).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 16); // cue_<part-of-tenantId>

  return dbWrite('apikey:generate', (db) => {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, name, scopes, rate_limit, active, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(tenantId, keyHash, keyPrefix, name || null, JSON.stringify(scopes), rateLimit, expiresAt || null, now);

    return {
      key: rawKey,   // 只在创建时返回一次，之后无法恢复
      keyPrefix,
      keyHash,
      id: result.lastInsertRowid,
      tenantId,
      scopes,
      rateLimit,
    };
  });
}

/**
 * 验证 API Key（查 DB + 检查有效期 + rate limit）
 *
 * @param {string} rawKey  - 完整 API Key
 * @returns {object|null}  - { tenantId, scopes, rateLimit, keyPrefix } 或 null（验证失败）
 */
export async function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('cue_')) return null;

  ensureGatewayTables();
  const db = getDb();

  const { createHash } = await import('crypto');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const row = db.prepare(`
    SELECT * FROM api_keys
    WHERE key_hash = ? AND active = 1
  `).get(keyHash);

  if (!row) return null;

  // 检查过期
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // 更新 last_used（fire and forget）
  dbWrite('apikey:touch', (db) => {
    db.prepare(`UPDATE api_keys SET last_used = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id);
  }).catch(() => {});

  return {
    tenantId: row.tenant_id,
    scopes: JSON.parse(row.scopes || '["read","write"]'),
    rateLimit: row.rate_limit,
    keyPrefix: row.key_prefix,
  };
}

/**
 * 撤销 API Key
 */
export async function revokeApiKey({ tenantId, keyId }) {
  ensureGatewayTables();
  return dbWrite('apikey:revoke', (db) => {
    const result = db.prepare(`
      UPDATE api_keys SET active = 0 WHERE id = ? AND tenant_id = ?
    `).run(keyId, tenantId);
    return result.changes > 0;
  });
}

/**
 * 列出租户的 API Keys（不返回完整 key）
 */
export function listApiKeys({ tenantId }) {
  ensureGatewayTables();
  const db = getDb();
  return db.prepare(`
    SELECT id, key_prefix, name, scopes, rate_limit, active, last_used, expires_at, created_at
    FROM api_keys WHERE tenant_id = ?
    ORDER BY created_at DESC
  `).all(tenantId).map(r => ({
    ...r,
    scopes: JSON.parse(r.scopes || '["read","write"]'),
  }));
}

// ══════════════════════════════════════════════════════════════
// Rate Limiting（滑动窗口，内存）
// ══════════════════════════════════════════════════════════════

/**
 * 检查并更新 rate limit
 *
 * @param {string} keyHash   - API Key 哈希（避免存明文）
 * @param {number} limit     - 每分钟最大请求数
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
 */
export function checkRateLimit(keyHash, limit = DEFAULT_RATE_LIMIT) {
  const now = Date.now();
  let state = _rateLimitState.get(keyHash);

  if (!state || now - state.windowStart >= RATE_WINDOW_MS) {
    // 新窗口
    state = { count: 0, windowStart: now };
    _rateLimitState.set(keyHash, state);
  }

  const remaining = Math.max(0, limit - state.count);
  const allowed = state.count < limit;

  if (allowed) state.count++;

  return {
    allowed,
    remaining: Math.max(0, remaining - 1),
    limit,
    resetAt: state.windowStart + RATE_WINDOW_MS,
  };
}

/**
 * 重置某个 key 的 rate limit 状态（测试用）
 */
export function resetRateLimit(keyHash) {
  _rateLimitState.delete(keyHash);
}

// ══════════════════════════════════════════════════════════════
// 审计日志
// ══════════════════════════════════════════════════════════════

/**
 * 记录一次 API 调用到审计日志（异步，不阻塞响应）
 */
export function auditLog({ tenantId, keyPrefix, method, path, statusCode, latencyMs, ip, userAgent }) {
  ensureGatewayTables();
  // fire and forget
  dbWrite('audit:log', (db) => {
    db.prepare(`
      INSERT INTO api_audit_log
        (tenant_id, key_prefix, method, path, status_code, latency_ms, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId, keyPrefix || null, method, path,
      statusCode || null, latencyMs || null,
      ip || null, userAgent || null,
      new Date().toISOString()
    );
  }).catch(() => {});
}

/**
 * 查询审计日志
 */
export function queryAuditLog({ tenantId, path, since, limit = 50, offset = 0 }) {
  ensureGatewayTables();
  const db = getDb();

  let q = 'SELECT * FROM api_audit_log WHERE tenant_id = ?';
  const params = [tenantId];
  if (path) { q += ' AND path LIKE ?'; params.push(`%${path}%`); }
  if (since) { q += ' AND created_at >= ?'; params.push(since); }

  const total = db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...params).c;
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return { logs: db.prepare(q).all(...params), total };
}

// ══════════════════════════════════════════════════════════════
// 多租户隔离验证
// ══════════════════════════════════════════════════════════════

/**
 * 验证请求方是否属于指定 tenantId
 * 用于二次检查（已通过 validateApiKey 的基础上再验证 URL 中的 tenantId）
 *
 * @param {string} authTenantId  - 从 API Key 提取的 tenantId
 * @param {string} reqTenantId   - 请求 URL/Body 中的 tenantId
 * @returns {boolean}
 */
export function assertTenantIsolation(authTenantId, reqTenantId) {
  // 'default' 是系统租户，拥有全局访问权
  if (authTenantId === 'default') return true;
  return authTenantId === reqTenantId;
}

/**
 * 从请求头提取 API Key
 * 支持：Authorization: Bearer cue_xxx / X-API-Key: cue_xxx
 */
export function extractApiKey(req) {
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const key = authHeader.slice(7).trim();
    if (key.startsWith('cue_')) return key;
  }

  const xApiKey = req.headers?.['x-api-key'];
  if (xApiKey?.startsWith('cue_')) return xApiKey;

  // 兼容原有 X-CUE-API-Key（从环境变量配置）
  const cueLegacy = req.headers?.['x-cue-api-key'];
  if (cueLegacy) return cueLegacy;

  return null;
}

// ══════════════════════════════════════════════════════════════
// 中间件函数（供 v2/app.js 调用）
// ══════════════════════════════════════════════════════════════

/**
 * 完整的 API 网关鉴权流程
 *
 * @param {object} req   - Node.js IncomingMessage
 * @param {string} [overrideTenantId]  - 如果请求路径中已解析出 tenantId
 * @returns {Promise<object>} {
 *   ok: boolean,
 *   tenantId: string,
 *   scopes: string[],
 *   keyPrefix: string,
 *   rateLimitInfo: object,
 *   errorCode?: number,
 *   errorMessage?: string
 * }
 */
export async function gatewayAuth(req, overrideTenantId) {
  const rawKey = extractApiKey(req);

  if (!rawKey) {
    return { ok: false, errorCode: 401, errorMessage: 'missing API key (Authorization: Bearer cue_xxx or X-API-Key)' };
  }

  const keyInfo = await validateApiKey(rawKey);
  if (!keyInfo) {
    return { ok: false, errorCode: 401, errorMessage: 'invalid or expired API key' };
  }

  // 多租户隔离
  if (overrideTenantId && !assertTenantIsolation(keyInfo.tenantId, overrideTenantId)) {
    return { ok: false, errorCode: 403, errorMessage: 'tenant isolation violation' };
  }

  // Rate limit
  const { createHash } = await import('crypto');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const rl = checkRateLimit(keyHash, keyInfo.rateLimit);

  if (!rl.allowed) {
    return {
      ok: false,
      errorCode: 429,
      errorMessage: `rate limit exceeded: ${keyInfo.rateLimit} req/min`,
      rateLimitInfo: rl,
    };
  }

  return {
    ok: true,
    tenantId: keyInfo.tenantId,
    scopes: keyInfo.scopes,
    keyPrefix: keyInfo.keyPrefix,
    rateLimitInfo: rl,
  };
}
