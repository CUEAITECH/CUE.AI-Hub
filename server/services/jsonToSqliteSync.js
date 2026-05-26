/**
 * server/services/jsonToSqliteSync.js
 *
 * JSON store → SQLite 单向同步
 *
 * 职责：
 *   - 把 v1 JSON store (db.json) 中的核心实体 upsert 进 v2 SQLite
 *   - 让 v2 路由接口能读到真实业务数据，而不是空表
 *   - 每次 saveStore() 后自动触发（防抖 2s）
 *
 * 同步实体：
 *   tasks / pulls / activities / assignments / standups / projects / users / reviews
 *
 * 不同步：
 *   actors（v2 独立维护）/ api_keys / learning_reports / llm_calls（v2 专属）
 */

import logger from '../logger.js';
import { getDb } from '../db/index.js';

const TENANT = 'default';

// ─── 防抖：避免高频 saveStore 触发重复同步 ─────────────────────────
let _debounceTimer = null;
export function scheduleSyncJsonToSqlite(store) {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    syncJsonToSqlite(store).catch(err =>
      logger.warn('[jsonToSqliteSync] 同步失败:', err.message)
    );
  }, 2000);
}

// ─── 主同步函数 ────────────────────────────────────────────────────
export async function syncJsonToSqlite(store) {
  const db = getDb();
  const stats = {};

  // 临时关闭 FK 检查：JSON store 没有 FK 约束，同步时引用可能乱序
  // 同步完数据一致性由 JSON store 自身保证
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // 顺序：先同步被依赖表，再同步依赖表
      stats.projects    = syncProjects(db, store.projects  || []);
      stats.tasks       = syncTasks(db, store.tasks       || []);
      stats.pulls       = syncPulls(db, store.pulls       || []);
      stats.activities  = syncActivities(db, store.activities || []);
      stats.reviews     = syncReviews(db, store.reviews    || []);
      stats.assignments = syncAssignments(db, store.assignments || []);
      stats.standups    = syncStandups(db, store.standups  || []);
      stats.users       = syncUsers(db, store.users        || []);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total > 0) {
    logger.info(`[jsonToSqliteSync] 同步完成: ${JSON.stringify(stats)}`);
  }
  return stats;
}

// ─── 状态映射：v1 JSON state → v2 SQLite CHECK 约束 ───────────────
const TASK_STATE_MAP = {
  open:        'pending',
  pending:     'pending',
  claimed:     'claimed',
  in_progress: 'in_progress',
  in_review:   'in_review',
  merged:      'merged',
  done:        'done',
  closed:      'done',
  cancelled:   'cancelled',
  canceled:    'cancelled',
};
function normalizeTaskState(s) {
  return TASK_STATE_MAP[s] || 'pending';
}

// ─── tasks ────────────────────────────────────────────────────────
function syncTasks(db, tasks) {
  const stmt = db.prepare(`
    INSERT INTO tasks
      (id, tenant_id, project_id, title, actor_id, owner_legacy, state,
       priority, risk, due, progress, acceptance, signal,
       linked_refs_json, deliverable_id, created_at, updated_at)
    VALUES
      (@id, @tenant_id, @project_id, @title, @actor_id, @owner_legacy, @state,
       @priority, @risk, @due, @progress, @acceptance, @signal,
       @linked_refs_json, @deliverable_id, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title          = excluded.title,
      actor_id       = excluded.actor_id,
      owner_legacy   = excluded.owner_legacy,
      state          = excluded.state,
      priority       = excluded.priority,
      risk           = excluded.risk,
      due            = excluded.due,
      progress       = excluded.progress,
      acceptance     = excluded.acceptance,
      signal         = excluded.signal,
      linked_refs_json = excluded.linked_refs_json,
      deliverable_id = excluded.deliverable_id,
      updated_at     = excluded.updated_at
  `);

  let count = 0;
  for (const t of tasks) {
    const projectId = t.project_id || t.projectId;
    if (!projectId) continue;  // project_id NOT NULL，跳过无项目任务
    stmt.run({
      id:               t.id,
      tenant_id:        t.tenant_id || TENANT,
      project_id:       projectId,
      title:            t.title || '',
      actor_id:         t.actor_id || null,
      owner_legacy:     t.owner_legacy || t.owner || null,
      state:            normalizeTaskState(t.state),
      priority:         t.priority || null,
      risk:             t.risk || null,
      due:              t.due || null,
      progress:         t.progress ?? 0,
      acceptance:       t.acceptance || t.acceptanceCriteria || null,
      signal:           t.signal || null,
      linked_refs_json: t.linked_refs_json || JSON.stringify(t.linkedRefs || []),
      deliverable_id:   t.deliverable_id || t.deliverableId || null,
      created_at:       t.created_at || t.createdAt || new Date().toISOString(),
      updated_at:       t.updated_at || t.updatedAt || new Date().toISOString(),
    });
    count++;
  }
  return count;
}

// ─── pulls ────────────────────────────────────────────────────────
function syncPulls(db, pulls) {
  const stmt = db.prepare(`
    INSERT INTO pulls
      (id, tenant_id, project_id, number, title, body, state, author,
       head_branch, base_branch, merged_at, raw_json, created_at, updated_at)
    VALUES
      (@id, @tenant_id, @project_id, @number, @title, @body, @state, @author,
       @head_branch, @base_branch, @merged_at, @raw_json, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title       = excluded.title,
      body        = excluded.body,
      state       = excluded.state,
      author      = excluded.author,
      merged_at   = excluded.merged_at,
      raw_json    = excluded.raw_json,
      updated_at  = excluded.updated_at
  `);

  let count = 0;
  for (const p of pulls) {
    const projectId = p.projectId || p.project_id;
    if (!projectId) continue;  // project_id NOT NULL
    stmt.run({
      id:          p.id,
      tenant_id:   p.tenant_id || TENANT,
      project_id:  projectId,
      number:      p.number || 0,
      title:       p.title || '',
      body:        p.body || null,
      state:       p.state || 'open',
      author:      p.author || null,
      head_branch: p.headBranch || p.head_branch || null,
      base_branch: p.baseBranch || p.base_branch || null,
      merged_at:   p.mergedAt || p.merged_at || null,
      raw_json:    JSON.stringify(p),
      created_at:  p.createdAt || p.created_at || new Date().toISOString(),
      updated_at:  p.updatedAt || p.updated_at || new Date().toISOString(),
    });
    count++;
  }
  return count;
}

// ─── activities ───────────────────────────────────────────────────
function syncActivities(db, activities) {
  const stmt = db.prepare(`
    INSERT INTO activities
      (id, tenant_id, project_id, type, title, actor_id, owner_legacy,
       repo, branch, sha, files_json, diff, created_at)
    VALUES
      (@id, @tenant_id, @project_id, @type, @title, @actor_id, @owner_legacy,
       @repo, @branch, @sha, @files_json, @diff, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      title        = excluded.title,
      owner_legacy = excluded.owner_legacy,
      files_json   = excluded.files_json
  `);

  let count = 0;
  for (const a of activities) {
    stmt.run({
      id:           a.id,
      tenant_id:    a.tenant_id || TENANT,
      project_id:   a.projectId || a.project_id || null,
      type:         a.type || 'commit',
      title:        a.title || '',
      actor_id:     a.actor_id || null,
      owner_legacy: a.owner || a.owner_legacy || null,
      repo:         a.repo || null,
      branch:       a.branch || null,
      sha:          a.sha || null,
      files_json:   JSON.stringify(a.files || []),
      diff:         a.diff || null,
      created_at:   a.createdAt || a.created_at || new Date().toISOString(),
    });
    count++;
  }
  return count;
}

// ─── assignments ──────────────────────────────────────────────────
function syncAssignments(db, assignments) {
  const stmt = db.prepare(`
    INSERT INTO assignments
      (id, tenant_id, project_id, date, actor_id, owner_legacy,
       task_id, task_title, status, notes, created_at)
    VALUES
      (@id, @tenant_id, @project_id, @date, @actor_id, @owner_legacy,
       @task_id, @task_title, @status, @notes, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      status     = excluded.status,
      notes      = excluded.notes,
      task_title = excluded.task_title
  `);

  let count = 0;
  for (const a of assignments) {
    stmt.run({
      id:           a.id,
      tenant_id:    a.tenant_id || TENANT,
      project_id:   a.projectId || a.project_id || null,
      date:         a.date || null,
      actor_id:     a.actor_id || null,
      owner_legacy: a.owner || a.owner_legacy || null,
      task_id:      a.taskId || a.task_id || null,
      task_title:   a.taskTitle || a.task_title || null,
      status:       a.status || null,
      notes:        a.note || a.notes || null,
      created_at:   a.createdAt || a.created_at || new Date().toISOString(),
    });
    count++;
  }
  return count;
}

// ─── standups ─────────────────────────────────────────────────────
function syncStandups(db, standups) {
  const stmt = db.prepare(`
    INSERT INTO standups
      (id, tenant_id, project_id, date, actor_id, owner_legacy,
       yesterday, today, blockers, status, created_at)
    VALUES
      (@id, @tenant_id, @project_id, @date, @actor_id, @owner_legacy,
       @yesterday, @today, @blockers, @status, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      yesterday = excluded.yesterday,
      today     = excluded.today,
      blockers  = excluded.blockers,
      status    = excluded.status
  `);

  let count = 0;
  for (const s of standups) {
    stmt.run({
      id:           s.id,
      tenant_id:    s.tenant_id || TENANT,
      project_id:   s.projectId || s.project_id || null,
      date:         s.date || null,
      actor_id:     s.actor_id || null,
      owner_legacy: s.owner || s.owner_legacy || null,
      yesterday:    s.yesterday || null,
      today:        s.today || null,
      blockers:     s.blockers || null,
      status:       s.status || null,
      created_at:   s.createdAt || s.created_at || new Date().toISOString(),
    });
    count++;
  }
  return count;
}

// ─── projects ─────────────────────────────────────────────────────
function syncProjects(db, projects) {
  const stmt = db.prepare(`
    INSERT INTO projects
      (id, tenant_id, name, github_owner, github_repo, github_full_repo,
       repository, description, data_json, created_at, updated_at)
    VALUES
      (@id, @tenant_id, @name, @github_owner, @github_repo, @github_full_repo,
       @repository, @description, @data_json, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name             = excluded.name,
      github_owner     = excluded.github_owner,
      github_repo      = excluded.github_repo,
      github_full_repo = excluded.github_full_repo,
      repository       = excluded.repository,
      description      = excluded.description,
      data_json        = excluded.data_json,
      updated_at       = excluded.updated_at
  `);

  let count = 0;
  for (const p of projects) {
    // 把不属于独立列的字段存入 data_json
    const { id, name, githubOwner, githubRepo, githubFullRepo, repository,
            summary, ...rest } = p;
    stmt.run({
      id:               id,
      tenant_id:        p.tenant_id || TENANT,
      name:             name || '',
      github_owner:     githubOwner || null,
      github_repo:      githubRepo || (githubFullRepo ? githubFullRepo.split('/')[1] : null),
      github_full_repo: githubFullRepo || null,
      repository:       repository || null,
      description:      summary || p.description || null,
      data_json:        JSON.stringify(rest),
      created_at:       p.createdAt || p.created_at || new Date().toISOString(),
      updated_at:       p.lastSyncAt || p.updatedAt || p.updated_at || new Date().toISOString(),
    });
    count++;
  }
  return count;
}

// ─── users ────────────────────────────────────────────────────────
function syncUsers(db, users) {
  const stmt = db.prepare(`
    INSERT INTO users
      (id, tenant_id, actor_id, username, name, email, phone,
       role, project_ids_json, project_roles_json, active, password_hash, created_at, updated_at)
    VALUES
      (@id, @tenant_id, @actor_id, @username, @name, @email, @phone,
       @role, @project_ids_json, @project_roles_json, @active, @password_hash, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name               = excluded.name,
      email              = excluded.email,
      phone              = excluded.phone,
      role               = excluded.role,
      project_ids_json   = excluded.project_ids_json,
      project_roles_json = excluded.project_roles_json,
      active             = excluded.active,
      password_hash      = excluded.password_hash,
      updated_at         = excluded.updated_at
  `);

  let count = 0;
  for (const u of users) {
    stmt.run({
      id:                 u.id,
      tenant_id:          u.tenant_id || TENANT,
      actor_id:           u.actorId || u.actor_id || null,
      username:           u.username || u.name || u.id,
      name:               u.name || null,
      email:              u.email || null,
      phone:              u.phone || null,
      role:               u.role || 'member',
      project_ids_json:   JSON.stringify(u.projectIds || u.project_ids || []),
      project_roles_json: JSON.stringify(u.projectRoles || u.project_roles || {}),
      active:             u.active !== false ? 1 : 0,
      password_hash:      u.passwordHash || u.password_hash || null,
      created_at:         u.createdAt || u.created_at || new Date().toISOString(),
      updated_at:         u.updatedAt || u.updated_at || new Date().toISOString(),
    });
    count++;
  }
  return count;
}

// ─── reviews ──────────────────────────────────────────────────────
function syncReviews(db, reviews) {
  const stmt = db.prepare(`
    INSERT INTO reviews
      (id, tenant_id, pull_id, task_id, source, level, score,
       compliance_json, issues_json, findings_json, suggestion,
       human_decision, created_at, updated_at)
    VALUES
      (@id, @tenant_id, @pull_id, @task_id, @source, @level, @score,
       @compliance_json, @issues_json, @findings_json, @suggestion,
       @human_decision, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      level          = excluded.level,
      score          = excluded.score,
      issues_json    = excluded.issues_json,
      findings_json  = excluded.findings_json,
      suggestion     = excluded.suggestion,
      human_decision = excluded.human_decision,
      updated_at     = excluded.updated_at
  `);

  let count = 0;
  for (const r of reviews) {
    stmt.run({
      id:              r.id,
      tenant_id:       r.tenant_id || TENANT,
      pull_id:         r.pullId || r.pull_id || null,
      task_id:         r.taskId || r.task_id || null,
      source:          r.source || 'hub',
      level:           r.level || r.hubReview?.level || null,
      score:           r.score ?? r.hubReview?.score ?? null,
      compliance_json: JSON.stringify(r.compliance || r.hubReview?.compliance || null),
      issues_json:     JSON.stringify(r.issues || r.hubReview?.issues || []),
      findings_json:   JSON.stringify(r.findings || r.hubReview?.findings || []),
      suggestion:      r.suggestion || null,
      human_decision:  r.humanDecision || r.human_decision || null,
      created_at:      r.createdAt || r.created_at || new Date().toISOString(),
      updated_at:      r.updatedAt || r.updated_at || new Date().toISOString(),
    });
    count++;
  }
  return count;
}
