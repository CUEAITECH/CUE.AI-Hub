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
