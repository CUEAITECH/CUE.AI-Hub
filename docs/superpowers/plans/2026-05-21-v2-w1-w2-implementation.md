# V2 实施计划 · W1-W2

> 基于：`2026-05-21-v2-architecture-plan.md` + `2026-05-21-product-vision.md`
> 决策：所有 30 个决策按推荐答案，27-30 全 ✅
> 工作目录：`/Users/dirtortian/Documents/GitHub/CUE-Project-Hub`
> 执行规则：每个 Task 完成后跑 checkpoint，通过再继续。不许跳过。

---

## 前置条件核查

在开始 T1 前，确认：
- [ ] `node --version` ≥ 18（实测 v24 ✅）
- [ ] `server/data/db.json` 备份一份到 `server/data/db.json.pre-v2`
- [ ] 当前 `npm run check` 全部通过
- [ ] git 当前状态干净（或 stash）

```bash
cp server/data/db.json server/data/db.json.pre-v2
npm run check
git status
```

---

## W1：地基（目标：SQLite 双写，business logic 零改动）

W1 的核心约束：**现有所有路由和服务代码一行不动**。
通过双写适配器让 SQLite 和 db.json 并行运行 7 天，验证数据一致性后再切单源。

---

### T1 · 安装依赖

```bash
npm install better-sqlite3 kysely \
            @octokit/rest @octokit/webhooks \
            fastify @fastify/cors \
            p-queue node-cron \
            zod \
            pino pino-pretty \
            nodemailer \
            parse-diff
```

**不安装**（推迟到对应的周）：
- `tree-sitter`：W6
- `sqlite-vec`：W7
- `eta`：W4

**checkpoint：**
```bash
node -e "import('better-sqlite3').then(m => console.log('✅ better-sqlite3', m.default.version))"
node -e "import('kysely').then(() => console.log('✅ kysely'))"
node -e "import('p-queue').then(() => console.log('✅ p-queue'))"
node -e "import('node-cron').then(() => console.log('✅ node-cron'))"
node -e "import('zod').then(() => console.log('✅ zod'))"
node -e "import('pino').then(() => console.log('✅ pino'))"
```

---

### T2 · Schema DDL

创建 `server/db/schema.sql`：

```sql
-- ============================================================
-- CUE Hub v2 · SQLite Schema
-- 原则：每张表都有 tenant_id（多租户预留），自托管默认 'default'
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- actors：人类成员 + AI agent 统一抽象（愿景核心）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS actors (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  type          TEXT NOT NULL CHECK(type IN ('human', 'ai-agent')),
  display_name  TEXT NOT NULL,

  -- 人类字段
  email         TEXT,
  comm_handle   TEXT,        -- WeCom/Slack/Feishu handle，adapter 层映射

  -- AI agent 字段
  agent_model   TEXT,        -- 'claude-code' / 'devin' / 'sweep' / 'custom'
  agent_endpoint TEXT,       -- webhook URL，Hub 分配任务时调用
  agent_api_key_ref TEXT,    -- 密钥引用，不存明文

  capabilities_json TEXT DEFAULT '[]',  -- ["code","review","research"]
  context_window    INTEGER DEFAULT 200000,

  -- 共同字段
  autonomy_level INTEGER NOT NULL DEFAULT 0,  -- 0-5，Part M.5
  active         BOOLEAN NOT NULL DEFAULT 1,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_actors_tenant ON actors(tenant_id, type, active);

-- ------------------------------------------------------------
-- tasks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  project_id    TEXT NOT NULL,

  title         TEXT NOT NULL,
  actor_id      TEXT REFERENCES actors(id),   -- 替代 owner 字符串
  owner_legacy  TEXT,                          -- 迁移期保留，读写都用 actor_id

  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK(state IN ('pending','claimed','in_progress','in_review','merged','done','cancelled')),
  priority      TEXT,
  risk          TEXT,
  due           DATE,
  progress      INTEGER NOT NULL DEFAULT 0,
  acceptance    TEXT,
  signal        TEXT,
  linked_refs_json TEXT DEFAULT '[]',
  deliverable_id TEXT,

  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_state ON tasks(tenant_id, state, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_actor ON tasks(actor_id) WHERE state IN ('claimed','in_progress','in_review');

-- ------------------------------------------------------------
-- pulls（PR）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pulls (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  project_id    TEXT NOT NULL,
  number        INTEGER NOT NULL,
  title         TEXT,
  body          TEXT,
  state         TEXT,                -- 'open' / 'closed' / 'merged'
  author        TEXT,
  head_branch   TEXT,
  base_branch   TEXT,
  merged_at     DATETIME,
  raw_json      TEXT,                -- 完整 GitHub PR payload
  created_at    DATETIME,
  updated_at    DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulls_tenant_number ON pulls(tenant_id, project_id, number);

-- pull ↔ task 多对多
CREATE TABLE IF NOT EXISTS pull_task_links (
  pull_id   TEXT NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (pull_id, task_id)
);

-- ------------------------------------------------------------
-- reviews
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  pull_id         TEXT REFERENCES pulls(id),
  task_id         TEXT REFERENCES tasks(id),
  source          TEXT NOT NULL,   -- 'hub' / 'pr-agent'
  level           TEXT,            -- 'Pass'/'Warning'/'Block'/'Escalate'
  score           INTEGER,
  compliance_json TEXT,            -- {done, notDone, needsHumanCheck}
  issues_json     TEXT DEFAULT '[]',
  findings_json   TEXT DEFAULT '[]',
  suggestion      TEXT,
  human_decision  TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_pull ON reviews(pull_id, source);

-- ------------------------------------------------------------
-- events（outbox + audit log）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  source          TEXT,            -- 'webhook'/'wecom'/'scheduler'/'ui'/'agent'
  event_id        TEXT UNIQUE,     -- 幂等键（GitHub delivery-id 等）
  processed_at    DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(tenant_id, processed_at)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_type ON events(tenant_id, type, created_at DESC);

-- ------------------------------------------------------------
-- llm_calls（LLM 调用账本，Part M.3 / Part O.3）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  ts            DATETIME DEFAULT CURRENT_TIMESTAMP,
  purpose       TEXT NOT NULL,     -- 'reviewer'/'planner'/'doc-sync'/'risk'/'explainer'
  model         TEXT,
  prompt_hash   TEXT,
  cache_hit     BOOLEAN,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  latency_ms    INTEGER,
  ref_type      TEXT,              -- 'task'/'pull'/'actor'
  ref_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose ON llm_calls(tenant_id, purpose, ts DESC);

-- ------------------------------------------------------------
-- sync_signatures（防三端同步循环）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_signatures (
  signature  TEXT PRIMARY KEY,
  source     TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- project_memory（RAG 层，Part M.2，W5 填充）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  project_id    TEXT,
  kind          TEXT NOT NULL
                CHECK(kind IN ('convention','decision','gotcha','pattern','taboo','success-case','failure-case')),
  body          TEXT NOT NULL,
  evidence_refs TEXT,
  confidence    REAL DEFAULT 0.5,
  source        TEXT NOT NULL,     -- 'human-added'/'auto-extracted'/'weekly-learning'
  validated_at  DATETIME,
  validated_by  TEXT,
  superseded_by INTEGER REFERENCES project_memory(id),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- ai_outcomes（持续学习，Part M.1，W9 填充）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_outcomes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id             TEXT NOT NULL DEFAULT 'default',
  action_type           TEXT NOT NULL,
  action_ref_id         TEXT NOT NULL,
  outcome_signal        TEXT NOT NULL,
  polarity              INTEGER NOT NULL,   -- +1 / -1 / 0
  evidence_json         TEXT,
  observer              TEXT,               -- 'auto-rule'/'human-label'
  observation_lag_hours INTEGER,
  observed_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- activities / assignments / standups（从 db.json 迁移）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  project_id  TEXT,
  type        TEXT,
  title       TEXT,
  actor_id    TEXT REFERENCES actors(id),
  owner_legacy TEXT,
  repo        TEXT,
  branch      TEXT,
  sha         TEXT,
  files_json  TEXT DEFAULT '[]',
  diff        TEXT,
  created_at  DATETIME
);

CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  project_id  TEXT,
  date        TEXT,
  actor_id    TEXT REFERENCES actors(id),
  owner_legacy TEXT,
  task_id     TEXT REFERENCES tasks(id),
  task_title  TEXT,
  status      TEXT,
  notes       TEXT,
  ai_suggested BOOLEAN DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS standups (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'default',
  project_id  TEXT,
  date        TEXT NOT NULL,
  actor_id    TEXT REFERENCES actors(id),
  owner_legacy TEXT,
  yesterday   TEXT,
  today       TEXT,
  blockers    TEXT,
  status      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT 'default',
  name              TEXT,
  github_owner      TEXT,
  github_repo       TEXT,
  github_full_repo  TEXT,
  repository        TEXT,
  description       TEXT,
  data_json         TEXT,   -- 其余字段序列化存储
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  actor_id      TEXT REFERENCES actors(id),
  username      TEXT UNIQUE,
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  role          TEXT,
  project_ids_json TEXT DEFAULT '["*"]',
  project_roles_json TEXT DEFAULT '{}',
  active        BOOLEAN DEFAULT 1,
  password_hash TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**checkpoint：**
```bash
node -e "
import Database from 'better-sqlite3';
const db = new Database('server/data/v2-test.db');
db.exec(require('fs').readFileSync('server/db/schema.sql','utf8'));
console.log('✅ schema created, tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name).join(', '));
db.close();
require('fs').unlinkSync('server/data/v2-test.db');
" 2>&1
```

---

### T3 · Kysely 实例 + Migration Runner

创建 `server/db/index.js`：

```javascript
// server/db/index.js
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { readFileSync, existsSync } from 'node:fs';
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
```

**checkpoint：**
```bash
node -e "
import { initDb, withTenant } from './server/db/index.js';
const { kysely } = initDb();
const rows = await withTenant().tasks().selectAll().execute();
console.log('✅ Kysely OK, tasks:', rows.length);
"
```

---

### T4 · p-queue 单写者 Actor

创建 `server/db/actor.js`：

```javascript
// server/db/actor.js
// 所有写入 SQLite 的操作都通过这个队列串行化
// 解决：并发 webhook 下的 lost-update（postmortem M4）

import PQueue from 'p-queue';
import { getDb } from './index.js';

const writeQueue = new PQueue({ concurrency: 1 });

let _pendingWrites = 0;
let _totalWrites = 0;

/**
 * 串行执行一个写操作（事务）
 * @param {string} label - 用于 debug 的标签
 * @param {function} fn - 同步函数，接收 better-sqlite3 db 实例
 * @returns {Promise<any>} fn 的返回值
 */
export async function dbWrite(label, fn) {
  _pendingWrites++;
  return writeQueue.add(() => {
    const db = getDb();
    _pendingWrites--;
    _totalWrites++;
    try {
      return db.transaction(fn)(db);
    } catch (err) {
      console.error(`[actor] write failed (${label}):`, err.message);
      throw err;
    }
  }, { priority: 0 });
}

/**
 * 高优先级写（如 P1 事件处理）
 */
export async function dbWriteUrgent(label, fn) {
  _pendingWrites++;
  return writeQueue.add(() => {
    const db = getDb();
    _pendingWrites--;
    _totalWrites++;
    return db.transaction(fn)(db);
  }, { priority: 10 });
}

export function getWriteStats() {
  return {
    pending: _pendingWrites,
    total: _totalWrites,
    queueSize: writeQueue.size
  };
}
```

**checkpoint：**
```bash
node -e "
import { initDb } from './server/db/index.js';
import { dbWrite, getWriteStats } from './server/db/actor.js';
initDb();
await Promise.all([
  dbWrite('test1', db => db.prepare('INSERT OR IGNORE INTO tasks(id,title,project_id) VALUES(?,?,?)').run('t1','test1','p1')),
  dbWrite('test2', db => db.prepare('INSERT OR IGNORE INTO tasks(id,title,project_id) VALUES(?,?,?)').run('t2','test2','p1')),
  dbWrite('test3', db => db.prepare('INSERT OR IGNORE INTO tasks(id,title,project_id) VALUES(?,?,?)').run('t3','test3','p1')),
]);
console.log('✅ actor writes:', getWriteStats());
dbWrite('cleanup', db => {
  db.prepare('DELETE FROM tasks WHERE id IN (?,?,?)').run('t1','t2','t3');
});
"
```

---

### T5 · Migration Script：db.json → SQLite

创建 `scripts/migrate-from-json.js`：

```javascript
// scripts/migrate-from-json.js
// 一次性迁移：把 db.json 数据全量 INSERT 进 SQLite
// 安全：全部 INSERT OR IGNORE，可重复跑

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, getDb } from '../server/db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_JSON = join(__dirname, '..', 'server', 'data', 'db.json');
const TENANT = 'default';

function safeJson(v) {
  return v != null ? JSON.stringify(v) : null;
}

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function main() {
  const { db } = initDb();
  const store = JSON.parse(readFileSync(DB_JSON, 'utf8'));

  console.log('📦 Starting migration from db.json...');

  // ── 1. actors：从 members + users 生成 ──────────────────
  console.log('\n[1/9] actors (members + users)');
  const actorStmt = db.prepare(`
    INSERT OR IGNORE INTO actors
      (id, tenant_id, type, display_name, email, comm_handle, capabilities_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // members → human actors
  const memberActorMap = {};
  for (const m of store.members || []) {
    const actorId = `actor_human_${m.id || m.name.replace(/\s+/g,'_')}`;
    actorStmt.run(actorId, TENANT, 'human', m.name, null, null, '["code","review","plan"]', new Date().toISOString());
    memberActorMap[m.name] = actorId;
    console.log(`  ✓ member → actor: ${m.name} → ${actorId}`);
  }

  // users → human actors（若 member 里已有同名，指向同一 actorId）
  const userActorMap = {};
  for (const u of store.users || []) {
    if (!u.name || u.name === '系统管理员') continue;
    const existing = memberActorMap[u.name];
    const actorId = existing || `actor_human_user_${u.id}`;
    if (!existing) {
      actorStmt.run(actorId, TENANT, 'human', u.name, u.email, null, '["code","review","plan"]', iso(u.createdAt));
    }
    userActorMap[u.id] = actorId;
    console.log(`  ✓ user → actor: ${u.username} (${u.name}) → ${actorId}`);
  }

  // owner 字符串 → actor_id 的查找函数
  function resolveActor(ownerStr) {
    if (!ownerStr) return null;
    return memberActorMap[ownerStr] || Object.values(memberActorMap).find(id => id.includes(ownerStr)) || null;
  }

  // ── 2. projects ───────────────────────────────────────────
  console.log('\n[2/9] projects');
  const projStmt = db.prepare(`
    INSERT OR IGNORE INTO projects
      (id, tenant_id, name, github_owner, github_repo, github_full_repo, repository, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of store.projects || []) {
    const { id, name, githubOwner, repository, githubFullRepo, ...rest } = p;
    const repo = githubFullRepo?.split('/')[1] || repository;
    projStmt.run(id, TENANT, name || id, githubOwner, repo, githubFullRepo, repository, safeJson(rest), new Date().toISOString(), new Date().toISOString());
    console.log(`  ✓ project: ${id}`);
  }

  // ── 3. tasks ─────────────────────────────────────────────
  console.log('\n[3/9] tasks');
  const taskStmt = db.prepare(`
    INSERT OR IGNORE INTO tasks
      (id, tenant_id, project_id, title, actor_id, owner_legacy, state, priority, risk, due,
       progress, acceptance, signal, linked_refs_json, deliverable_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 状态映射：旧自由文本 → 新枚举
  function mapState(s) {
    const t = (s || '').toLowerCase();
    if (t.includes('完成') || t.includes('done')) return 'done';
    if (t.includes('进行') || t.includes('in_progress')) return 'in_progress';
    if (t.includes('待确认') || t.includes('pending')) return 'pending';
    if (t.includes('review') || t.includes('审阅')) return 'in_review';
    if (t.includes('取消') || t.includes('cancel')) return 'cancelled';
    return 'pending';
  }
  for (const t of store.tasks || []) {
    taskStmt.run(
      t.id, TENANT, t.projectId || 'cue_ai_classroom',
      t.title, resolveActor(t.owner), t.owner,
      mapState(t.status), t.priority, t.risk,
      t.due, t.progress || 0, t.acceptance, t.signal,
      safeJson(t.linkedRefs), t.deliverableId,
      iso(t.createdAt), iso(t.updatedAt)
    );
    console.log(`  ✓ task: ${t.id} (${t.title?.slice(0,20)})`);
  }

  // ── 4. reviews ───────────────────────────────────────────
  console.log('\n[4/9] reviews');
  const revStmt = db.prepare(`
    INSERT OR IGNORE INTO reviews
      (id, tenant_id, task_id, source, level, score, compliance_json, issues_json, findings_json, suggestion, human_decision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let revCount = 0;
  for (const r of store.reviews || []) {
    revStmt.run(
      r.id, TENANT, r.taskId || null,
      'hub', r.level, r.score,
      safeJson(r.compliance), safeJson(r.issues), safeJson(r.findings),
      r.suggestion, r.humanDecision,
      iso(r.createdAt), iso(r.updatedAt)
    );
    revCount++;
  }
  console.log(`  ✓ ${revCount} reviews`);

  // ── 5. activities ────────────────────────────────────────
  console.log('\n[5/9] activities');
  const actStmt = db.prepare(`
    INSERT OR IGNORE INTO activities
      (id, tenant_id, project_id, type, title, actor_id, owner_legacy, repo, branch, sha, files_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let actCount = 0;
  for (const a of store.activities || []) {
    actStmt.run(
      a.id, TENANT, a.projectId,
      a.type, a.title,
      resolveActor(a.owner || a.actor), a.owner || a.actor,
      a.repo, a.branch, a.sha,
      safeJson(a.files), iso(a.createdAt || a.date)
    );
    actCount++;
  }
  console.log(`  ✓ ${actCount} activities`);

  // ── 6. assignments ───────────────────────────────────────
  console.log('\n[6/9] assignments');
  const asgStmt = db.prepare(`
    INSERT OR IGNORE INTO assignments
      (id, tenant_id, project_id, date, actor_id, owner_legacy, task_id, task_title, status, notes, ai_suggested, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of store.assignments || []) {
    asgStmt.run(
      a.id, TENANT, a.projectId, a.date,
      resolveActor(a.owner), a.owner,
      a.taskId, a.taskTitle, a.status, a.notes,
      a.aiSuggested ? 1 : 0, iso(a.createdAt)
    );
  }
  console.log(`  ✓ ${(store.assignments||[]).length} assignments`);

  // ── 7. standups ──────────────────────────────────────────
  console.log('\n[7/9] standups');
  const suStmt = db.prepare(`
    INSERT OR IGNORE INTO standups
      (id, tenant_id, project_id, date, actor_id, owner_legacy, yesterday, today, blockers, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of store.standups || []) {
    suStmt.run(
      s.id, TENANT, s.projectId, s.date,
      resolveActor(s.owner), s.owner,
      s.yesterday, s.today, s.blockers, s.status, iso(s.createdAt)
    );
  }
  console.log(`  ✓ ${(store.standups||[]).length} standups`);

  // ── 8. users ─────────────────────────────────────────────
  console.log('\n[8/9] users');
  const userStmt = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, tenant_id, actor_id, username, name, email, phone, role,
       project_ids_json, project_roles_json, active, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const u of store.users || []) {
    userStmt.run(
      u.id, TENANT, userActorMap[u.id] || null,
      u.username, u.name, u.email, u.phone, u.role,
      safeJson(u.projectIds), safeJson(u.projectRoles),
      u.active !== false ? 1 : 0, u.passwordHash,
      iso(u.createdAt), iso(u.updatedAt)
    );
  }
  console.log(`  ✓ ${(store.users||[]).length} users`);

  // ── 9. 验证行数 ───────────────────────────────────────────
  console.log('\n[9/9] 验证');
  const tables = ['actors','tasks','reviews','activities','assignments','standups','projects','users'];
  for (const t of tables) {
    const { count } = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get();
    console.log(`  ${t}: ${count} rows`);
  }

  console.log('\n✅ Migration complete.');
  console.log('   db.json 原文件保持不变（双写期 7 天）。');
  console.log('   确认数据正确后运行 scripts/cutover.js 切单源。');
}

main().catch(err => { console.error('❌ Migration failed:', err); process.exit(1); });
```

**运行：**
```bash
node scripts/migrate-from-json.js
```

**checkpoint：**
```bash
node -e "
import { initDb, withTenant } from './server/db/index.js';
initDb();
const k = withTenant();
const tasks = await k.tasks().selectAll().execute();
const actors = await k.actors().selectAll().execute();
const reviews = await k.reviews().selectAll().execute();
console.log('tasks:', tasks.length, '/ actors:', actors.length, '/ reviews:', reviews.length);
console.log('sample task:', JSON.stringify(tasks[0], null, 2));
console.log('sample actor:', JSON.stringify(actors[0], null, 2));
"
```

---

### T6 · 双写适配器（7 天过渡期）

创建 `server/db/doubleWrite.js`：

```javascript
// server/db/doubleWrite.js
// 在 v2.db 写入的同时，保持 db.json 同步
// 7 天后确认一致性，运行 cutover.js 删除此层

import { loadStore, saveStore } from '../store.js';

let _enabled = process.env.DOUBLE_WRITE !== 'false';

export function isDoubleWriteEnabled() { return _enabled; }
export function disableDoubleWrite() { _enabled = false; }

/**
 * 在 SQLite 写入后，同步更新 db.json 对应字段
 * 调用方：reducer.js 每次 mutation 后
 */
export async function syncToJsonStore(table, id, data) {
  if (!_enabled) return;
  try {
    const store = await loadStore();
    const collectionMap = {
      tasks: 'tasks', actors: null, pulls: 'pulls',
      reviews: 'reviews', activities: 'activities',
      assignments: 'assignments', standups: 'standups',
    };
    const collection = collectionMap[table];
    if (!collection || !store[collection]) return;

    const idx = store[collection].findIndex(r => r.id === id);
    if (idx === -1) store[collection].unshift(data);
    else store[collection][idx] = data;

    await saveStore(store);
  } catch (err) {
    // 双写失败不应阻断主流程
    console.error('[doubleWrite] sync failed:', err.message);
  }
}
```

---

## W2：事件层（目标：所有状态变更通过 event→reducer，outbox 可回放）

---

### T7 · Event Types（zod schema）

创建 `server/events/types.js`：

```javascript
// server/events/types.js
import { z } from 'zod';

// 公共字段
const base = { tenantId: z.string().default('default'), projectId: z.string().optional() };

export const EventSchemas = {
  // ── PR 生命周期 ──────────────────────────────────────
  'pr.opened': z.object({ ...base, prNumber: z.number(), author: z.string(), title: z.string(), repoFull: z.string() }),
  'pr.synchronized': z.object({ ...base, prNumber: z.number(), repoFull: z.string(), beforeSha: z.string().optional(), afterSha: z.string().optional() }),
  'pr.merged': z.object({ ...base, prNumber: z.number(), repoFull: z.string(), mergedAt: z.string(), taskIds: z.array(z.string()).default([]) }),
  'pr.closed': z.object({ ...base, prNumber: z.number(), repoFull: z.string() }),
  'pr.review.posted': z.object({ ...base, prId: z.string(), source: z.enum(['hub','pr-agent']), level: z.string(), complianceDelta: z.object({ done: z.array(z.string()), notDone: z.array(z.string()), needsHumanCheck: z.array(z.string()) }).optional() }),
  'pr.bypass.detected': z.object({ ...base, sha: z.string(), branch: z.string(), pusher: z.string() }),

  // ── Task 生命周期 ─────────────────────────────────────
  'task.created': z.object({ ...base, taskId: z.string(), source: z.enum(['ai-pm','manual','wecom','agent']) }),
  'task.claimed': z.object({ ...base, taskId: z.string(), actorId: z.string(), source: z.enum(['ui','wecom','agent','scheduler']) }),
  'task.progressed': z.object({ ...base, taskId: z.string(), fromProgress: z.number(), toProgress: z.number(), signal: z.string().optional(), source: z.string() }),
  'task.state.changed': z.object({ ...base, taskId: z.string(), from: z.string(), to: z.string(), reason: z.string().optional() }),
  'task.merged': z.object({ ...base, taskId: z.string(), prId: z.string() }),
  'task.cancelled': z.object({ ...base, taskId: z.string(), reason: z.string().optional() }),

  // ── Agent ─────────────────────────────────────────────
  'agent.task.accepted': z.object({ ...base, agentId: z.string(), taskId: z.string() }),
  'agent.task.completed': z.object({ ...base, agentId: z.string(), taskId: z.string(), artifacts: z.array(z.string()).default([]), acStatus: z.any().optional() }),
  'agent.task.blocked': z.object({ ...base, agentId: z.string(), taskId: z.string(), reason: z.string() }),
  'agent.task.needs-human': z.object({ ...base, agentId: z.string(), taskId: z.string(), question: z.string() }),

  // ── Doc ───────────────────────────────────────────────
  'doc.scan.requested': z.object({ ...base, paths: z.array(z.string()).optional() }),
  'doc.updated': z.object({ ...base, path: z.string(), sha: z.string().optional() }),

  // ── Standup ───────────────────────────────────────────
  'standup.submitted': z.object({ ...base, actorId: z.string(), date: z.string(), yesterday: z.string(), today: z.string(), blockers: z.string().optional() }),

  // ── Evening report ────────────────────────────────────
  'evening.report.due': z.object({ ...base, date: z.string() }),
  'evening.report.generated': z.object({ ...base, date: z.string(), reportId: z.string() }),

  // ── Health / Risk ─────────────────────────────────────
  'risk.detected': z.object({ ...base, alertId: z.string(), severity: z.string(), ref: z.string().optional() }),
  'health.recomputed': z.object({ ...base, score: z.number(), components: z.any() }),
};

/**
 * 校验并构造一个 event payload
 * @param {string} type
 * @param {object} payload
 * @returns {object} 已校验的 payload
 */
export function validateEvent(type, payload) {
  const schema = EventSchemas[type];
  if (!schema) throw new Error(`Unknown event type: ${type}`);
  return schema.parse(payload);
}
```

**checkpoint：**
```bash
node -e "
import { validateEvent } from './server/events/types.js';
const p = validateEvent('pr.opened', { prNumber: 128, author: '罗子宽', title: 'test', repoFull: 'CUEAITECH/Cue.AI' });
console.log('✅ event validated:', JSON.stringify(p));
try { validateEvent('pr.opened', { prNumber: 'bad' }); } catch(e) { console.log('✅ bad input rejected:', e.errors?.[0]?.message); }
"
```

---

### T8 · EventBus + Outbox

创建 `server/events/bus.js`：

```javascript
// server/events/bus.js
// in-process EventEmitter + outbox 落库
// 保证：emit 之前先落库，落库失败则 emit 也不发生（原子性）

import { EventEmitter } from 'node:events';
import { validateEvent } from './types.js';
import { dbWrite } from '../db/actor.js';
import { getDb } from '../db/index.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/**
 * 发布事件
 * 1. 校验 payload（zod）
 * 2. 写入 events 表（幂等键去重）
 * 3. 触发内存订阅者
 *
 * @param {string} type
 * @param {object} payload
 * @param {object} [meta]
 * @param {string} [meta.source]     - 'webhook'/'wecom'/'scheduler'/'ui'/'agent'
 * @param {string} [meta.eventId]    - 幂等键（GitHub delivery id 等）
 */
export async function emit(type, payload, meta = {}) {
  const validated = validateEvent(type, payload);
  const tenantId = validated.tenantId || 'default';

  // 落 outbox（串行写）
  const eventId = meta.eventId || `${type}:${tenantId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  await dbWrite(`emit:${type}`, (db) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO events (tenant_id, type, payload_json, source, event_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(tenantId, type, JSON.stringify(validated), meta.source || null, eventId);
    return result.lastInsertRowid;
  });

  // 触发内存订阅者（fire and forget，失败不影响落库）
  try {
    emitter.emit(type, validated);
    emitter.emit('*', type, validated);  // 通配符订阅
  } catch (err) {
    console.error(`[EventBus] subscriber error for ${type}:`, err.message);
  }
}

/**
 * 订阅事件
 * @param {string|string[]} types
 * @param {function} handler - async (payload) => void
 */
export function on(types, handler) {
  const typeList = Array.isArray(types) ? types : [types];
  for (const t of typeList) {
    emitter.on(t, async (payload) => {
      try {
        await handler(payload);
      } catch (err) {
        console.error(`[EventBus] handler error for ${t}:`, err.message);
      }
    });
  }
}

/**
 * 标记事件已处理
 */
export async function markProcessed(eventRowId) {
  await dbWrite('mark-processed', (db) => {
    db.prepare('UPDATE events SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(eventRowId);
  });
}

/**
 * 重放未处理事件（服务重启后调用）
 */
export async function replayUnprocessed() {
  const db = getDb();
  const pending = db.prepare(`
    SELECT * FROM events WHERE processed_at IS NULL ORDER BY id ASC LIMIT 100
  `).all();

  console.log(`[EventBus] replaying ${pending.length} unprocessed events`);
  for (const row of pending) {
    try {
      const payload = JSON.parse(row.payload_json);
      emitter.emit(row.type, payload);
      emitter.emit('*', row.type, payload);
      db.prepare('UPDATE events SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    } catch (err) {
      console.error(`[EventBus] replay failed for event ${row.id}:`, err.message);
    }
  }
}

export { emitter };
```

**checkpoint：**
```bash
node -e "
import { initDb } from './server/db/index.js';
import { emit, on } from './server/events/bus.js';
initDb();

let received = null;
on('task.created', p => { received = p; });

await emit('task.created', { taskId: 'test_123', projectId: 'p1', source: 'manual' });
await new Promise(r => setTimeout(r, 50));
console.log('✅ received:', received?.taskId === 'test_123' ? 'OK' : 'FAIL');

import { getDb } from './server/db/index.js';
const row = getDb().prepare(\"SELECT * FROM events WHERE type='task.created' ORDER BY id DESC LIMIT 1\").get();
console.log('✅ outbox:', row?.type, row?.payload_json?.slice(0,50));
"
```

---

### T9 · 核心 Reducer（5 个状态转移）

创建 `server/state/reducer.js`：

```javascript
// server/state/reducer.js
// 处理 event → DB mutation
// 规则：reducer 是纯数据库操作，不调 LLM，不发通知

import { on } from '../events/bus.js';
import { dbWrite } from '../db/actor.js';
import { syncToJsonStore } from '../db/doubleWrite.js';
import { getDb } from '../db/index.js';

// ── 任务状态机（显式枚举，见 Part I 决策 6）───────────────
const VALID_TRANSITIONS = {
  pending:     ['claimed', 'cancelled'],
  claimed:     ['in_progress', 'cancelled', 'pending'],
  in_progress: ['in_review', 'claimed', 'cancelled'],
  in_review:   ['in_progress', 'merged', 'cancelled'],
  merged:      ['done'],
  done:        [],
  cancelled:   ['pending'],
};

function canTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

function now() { return new Date().toISOString(); }

// ── Reducer 注册 ──────────────────────────────────────────

/** task.claimed → state: claimed, actor_id 设置 */
on('task.claimed', async ({ tenantId, taskId, actorId }) => {
  await dbWrite('reducer:task.claimed', (db) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task) return;
    if (!canTransition(task.state, 'claimed')) {
      console.warn(`[reducer] task.claimed blocked: ${task.state} → claimed`);
      return;
    }
    db.prepare(`
      UPDATE tasks SET actor_id = ?, state = 'claimed', updated_at = ? WHERE id = ? AND tenant_id = ?
    `).run(actorId, now(), taskId, tenantId);
  });
});

/** task.state.changed → 任意合法状态转移 */
on('task.state.changed', async ({ tenantId, taskId, from, to }) => {
  await dbWrite('reducer:task.state.changed', (db) => {
    const task = db.prepare('SELECT state FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
    if (!task || task.state !== from) return;
    if (!canTransition(from, to)) {
      console.warn(`[reducer] invalid transition ${from} → ${to} for ${taskId}`);
      return;
    }
    db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?').run(to, now(), taskId, tenantId);
  });
});

/** task.progressed → progress 更新，signal 记录 */
on('task.progressed', async ({ tenantId, taskId, toProgress, signal }) => {
  await dbWrite('reducer:task.progressed', (db) => {
    const progress = Math.max(0, Math.min(100, toProgress));
    db.prepare(`
      UPDATE tasks SET progress = ?, signal = COALESCE(?, signal), updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(progress, signal || null, now(), taskId, tenantId);
  });
});

/** pr.merged → task state → merged，写 pull_task_links */
on('pr.merged', async ({ tenantId, prId, taskIds, mergedAt }) => {
  if (!taskIds?.length) return;
  await dbWrite('reducer:pr.merged', (db) => {
    for (const taskId of taskIds) {
      const task = db.prepare('SELECT state FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
      if (!task) continue;
      // in_review → merged → done（两步状态机串接）
      if (canTransition(task.state, 'in_review')) {
        db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
          .run('in_review', now(), taskId, tenantId);
      }
      db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run('merged', now(), taskId, tenantId);
    }
  });
});

/** pr.review.posted → upsert reviews 表 */
on('pr.review.posted', async ({ tenantId, prId, source, level, complianceDelta }) => {
  await dbWrite('reducer:pr.review.posted', (db) => {
    const id = `review_${prId}_${source}_${Date.now()}`;
    db.prepare(`
      INSERT INTO reviews (id, tenant_id, pull_id, source, level, compliance_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, prId, source, level, JSON.stringify(complianceDelta || {}), now(), now());
  });
});

console.log('[reducer] ✅ registered');
```

**checkpoint：**
```bash
node -e "
import { initDb } from './server/db/index.js';
import './server/state/reducer.js';
import { emit } from './server/events/bus.js';
import { dbWrite } from './server/db/actor.js';
import { getDb } from './server/db/index.js';
initDb();

// 创建测试 task
await dbWrite('test-setup', db => {
  db.prepare('INSERT OR IGNORE INTO tasks(id,title,project_id,state) VALUES(?,?,?,?)').run('t_test','测试任务','p1','pending');
  db.prepare('INSERT OR IGNORE INTO actors(id,type,display_name) VALUES(?,?,?)').run('actor_test','human','测试人员');
});

await emit('task.claimed', { taskId: 't_test', actorId: 'actor_test', source: 'ui' });
await new Promise(r => setTimeout(r, 100));

const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get('t_test');
console.log('✅ task.state after claim:', task?.state === 'claimed' ? 'claimed ✓' : task?.state + ' ✗');

// cleanup
await dbWrite('test-cleanup', db => db.prepare('DELETE FROM tasks WHERE id = ?').run('t_test'));
"
```

---

### T10 · node-cron 替换 setInterval

创建 `server/cron/index.js`：

```javascript
// server/cron/index.js
// 替代 scheduler.js 的 setInterval 时钟
// cron 表达式清晰，不再手写 hour/minute 判断

import cron from 'node-cron';
import { emit } from '../events/bus.js';

const TENANT = process.env.DEFAULT_TENANT_ID || 'default';

export function startCron({ meetingHour = 18, isCompanyWorkday, todayText, githubSyncIntervalMinutes = 10 }) {
  const prepHour = meetingHour === 0 ? 23 : meetingHour - 1;

  // ── 17:45 晚会作战包（工作日）─────────────────────────────
  // cron: 45 分钟、prepHour 点、周一二四五日（公司工作日）
  // 注意：公司工作日是 1/2/4/5/0（非周三、非周六）
  cron.schedule(`45 ${prepHour} * * 0,1,2,4,5`, async () => {
    const today = todayText();
    if (!isCompanyWorkday(today)) return;
    console.log(`[cron] evening.report.due: ${today}`);
    await emit('evening.report.due', { tenantId: TENANT, date: today }, { source: 'scheduler', eventId: `evening:${today}` });
  }, { timezone: 'Asia/Shanghai' });

  // ── 18:00 会议开始提醒 ────────────────────────────────────
  cron.schedule(`0 ${meetingHour} * * 0,1,2,4,5`, async () => {
    const today = todayText();
    if (!isCompanyWorkday(today)) return;
    // 保留现有逻辑，通过 event 触发
  }, { timezone: 'Asia/Shanghai' });

  // ── GitHub 定时同步（改为 event 驱动，减少直接 LLM 调用）──
  if (githubSyncIntervalMinutes > 0) {
    // 首次启动 15 秒后
    setTimeout(() => {
      emit('doc.scan.requested', { tenantId: TENANT }, { source: 'scheduler' }).catch(console.error);
    }, 15_000);

    cron.schedule(`*/${githubSyncIntervalMinutes} * * * *`, async () => {
      await emit('doc.scan.requested', { tenantId: TENANT }, {
        source: 'scheduler',
        eventId: `github-sync:${Date.now()}`
      });
    });
  }

  // ── 每日 23:55 db.json 快照到 git（决策 4）───────────────
  cron.schedule('55 23 * * *', async () => {
    const { exec } = await import('node:child_process');
    exec('cp server/data/db.json server/data/db.json.daily-snapshot', (err) => {
      if (!err) console.log('[cron] daily db.json snapshot done');
    });
  }, { timezone: 'Asia/Shanghai' });

  console.log('[cron] ✅ scheduled (meetingHour:', meetingHour, ')');
}
```

---

### T11 · 引导：在 server/index.js 顶部初始化新模块

在现有 `server/index.js` **顶部** 插入（不动其他代码）：

```javascript
// ── V2 地基初始化（在任何路由注册之前）──
import { initDb } from './db/index.js';
import './state/reducer.js';          // 注册 reducer 订阅者
import { replayUnprocessed } from './events/bus.js';

const { db, kysely } = initDb();
await replayUnprocessed();            // 重启后回放未处理事件
console.log('[V2] DB + EventBus + reducers initialized');
// ── END V2 初始化 ──────────────────────────────────────────
```

**启动服务，观察日志：**
```bash
npm run dev 2>&1 | head -30
# 期望看到：
# [DB] initialized: .../server/data/v2.db
# [EventBus] replaying 0 unprocessed events
# [reducer] ✅ registered
# [cron] ✅ scheduled
# [V2] DB + EventBus + reducers initialized
# [然后是原来的启动日志]
```

---

## W1-W2 完成检查清单

```
W1
[ ] T1: npm install 全部通过
[ ] T2: schema.sql 建表成功
[ ] T3: Kysely 实例 + withTenant() 可查询
[ ] T4: p-queue actor 串行写 3 条并发测试通过
[ ] T5: migrate-from-json.js 跑通，行数验证通过
[ ] T6: doubleWrite.js 已接入 reducer

W2
[ ] T7: zod event types，合法/非法输入均测试通过
[ ] T8: EventBus emit → outbox 落库 → subscriber 触发
[ ] T9: reducer 5 个状态转移测试通过
[ ] T10: node-cron 启动无报错
[ ] T11: npm run dev 启动日志含 V2 初始化信息
[ ] 全程：npm run check 零错误
[ ] 全程：现有 smoke test 全部通过（业务逻辑零改动）
```

---

## W1-W2 结束后的 7 天双写期

W2 完成后，**不立即切单源**。双写 7 天：

1. 每天对比 `v2.db` 和 `db.json` 的行数（写一个 5 行脚本）
2. 发现不一致 → 修 doubleWrite.js，不动业务代码
3. 7 天无不一致 → 运行 `scripts/cutover.js`（只需 `store.js` 的 `loadStore/saveStore` 改为从 SQLite 读写）

**切换信号**：`DOUBLE_WRITE=false npm run dev` 服务正常跑 24 小时，则正式切单源。

---

## 下一步：W3 开始的工作

W3 的三件事（独立 PR，可并行）：
1. Fastify 替换裸 http（路由层）
2. Octokit 替换 `githubApi.js`（GitHub API 层）
3. NotificationAdapter 接口 + WeComAdapter 包装（通信层）

W4 的重点：Agent Integration Protocol（愿景里最关键的一周）。
