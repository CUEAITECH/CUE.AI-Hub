// server/services/configStore.js
// 系统配置存储：DB（hub_config 表）优先，env 变量兜底
//
// 支持的 key：
//   openai.apiKey     → OPENAI_API_KEY
//   openai.baseUrl    → OPENAI_BASE_URL
//   openai.model      → OPENAI_MODEL      (default: gpt-5.5)
//   openai.miniModel  → OPENAI_MINI_MODEL (default: gpt-5.4-mini)
//   newapi.token      → NEWAPI_TOKEN
//   newapi.userId     → NEWAPI_USER_ID
//   newapi.quotaRate  → NEWAPI_QUOTA_RATE (default: 500000)

import { getDb } from '../db/index.js';

const ENV_MAP = {
  'openai.apiKey':    'OPENAI_API_KEY',
  'openai.baseUrl':   'OPENAI_BASE_URL',
  'openai.model':     'OPENAI_MODEL',
  'openai.miniModel': 'OPENAI_MINI_MODEL',
  'newapi.token':     'NEWAPI_TOKEN',
  'newapi.userId':    'NEWAPI_USER_ID',
  'newapi.quotaRate': 'NEWAPI_QUOTA_RATE',
};

const DEFAULTS = {
  'openai.model':     'gpt-5.5',
  'openai.miniModel': 'gpt-5.4-mini',
  'newapi.quotaRate': '500000',
};

const SENSITIVE = new Set(['openai.apiKey', 'newapi.token']);

/** 读取单个配置项，优先级：DB > env > 默认值 */
export function getConfig(key) {
  try {
    const row = getDb().prepare('SELECT value FROM hub_config WHERE key = ?').get(key);
    if (row?.value) return row.value;
  } catch { /* DB 未初始化时跳过 */ }
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return DEFAULTS[key] ?? null;
}

/** 写入单个配置项（空字符串等价于删除：恢复 env 优先级） */
export function setConfig(key, value) {
  if (value === '' || value == null) {
    getDb().prepare('DELETE FROM hub_config WHERE key = ?').run(key);
  } else {
    getDb().prepare(
      "INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(key, String(value));
  }
}

/** 批量写入 */
export function setConfigs(entries) {
  const db = getDb();
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO hub_config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  );
  const del = db.prepare('DELETE FROM hub_config WHERE key = ?');
  const tx = db.transaction((map) => {
    for (const [k, v] of Object.entries(map)) {
      if (v === '' || v == null) del.run(k);
      else upsert.run(k, String(v));
    }
  });
  tx(entries);
}

/** 返回所有配置（含来源标注；敏感值打码） */
export function getAllConfig({ mask = true } = {}) {
  let dbRows = {};
  try {
    for (const row of getDb().prepare('SELECT key, value FROM hub_config').all()) {
      dbRows[row.key] = row.value;
    }
  } catch { /* DB 未初始化 */ }

  const result = {};
  for (const key of Object.keys(ENV_MAP)) {
    const dbVal = dbRows[key];
    const envKey = ENV_MAP[key];
    const envVal = envKey ? (process.env[envKey] || null) : null;
    const defVal = DEFAULTS[key] ?? null;

    let value, source;
    if (dbVal) {
      value  = dbVal;
      source = 'db';
    } else if (envVal) {
      value  = envVal;
      source = 'env';
    } else {
      value  = defVal ?? '';
      source = 'default';
    }
    result[key] = {
      value:  (mask && SENSITIVE.has(key) && value) ? maskSecret(value) : value,
      source,
      hasValue: Boolean(value),
    };
  }
  return result;
}

function maskSecret(v) {
  if (!v || v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}
