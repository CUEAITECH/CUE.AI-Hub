// server/db/index.js
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'v2.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let _db = null;
let _kysely = null;

export function getDb() {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.');
  return _db;
}

export function getKysely() {
  if (!_kysely) throw new Error('Kysely not initialized. Call initDb() first.');
  return _kysely;
}

export function initDb() {
  if (_db) return { db: _db, kysely: _kysely };

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // 跑 schema（idempotent，IF NOT EXISTS）
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  _db.exec(schema);

  _kysely = new Kysely({
    dialect: new SqliteDialect({ database: _db })
  });

  console.log('[DB] initialized:', DB_PATH);
  return { db: _db, kysely: _kysely };
}

/** 带 tenant_id 的查询帮助函数 */
export function withTenant(tenantId = 'default') {
  const k = getKysely();
  return {
    tasks:   () => k.selectFrom('tasks').where('tenant_id', '=', tenantId),
    actors:  () => k.selectFrom('actors').where('tenant_id', '=', tenantId),
    pulls:   () => k.selectFrom('pulls').where('tenant_id', '=', tenantId),
    reviews: () => k.selectFrom('reviews').where('tenant_id', '=', tenantId),
    events:  () => k.selectFrom('events').where('tenant_id', '=', tenantId),
    llm:     () => k.selectFrom('llm_calls').where('tenant_id', '=', tenantId),
    memory:  () => k.selectFrom('project_memory').where('tenant_id', '=', tenantId),
  };
}
