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
    const actorId = `actor_human_${(m.id || m.name || 'unknown').replace(/\s+/g, '_')}`;
    actorStmt.run(actorId, TENANT, 'human', m.name || m.id, null, null, '["code","review","plan"]', new Date().toISOString());
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
    // 精确匹配
    if (memberActorMap[ownerStr]) return memberActorMap[ownerStr];
    // 模糊匹配（包含关系）
    const found = Object.entries(memberActorMap).find(([name]) =>
      name.includes(ownerStr) || ownerStr.includes(name)
    );
    return found ? found[1] : null;
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
    projStmt.run(id, TENANT, name || id, githubOwner, repo, githubFullRepo, repository,
      safeJson(rest), new Date().toISOString(), new Date().toISOString());
    console.log(`  ✓ project: ${id} (${name})`);
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
  let taskCount = 0;
  for (const t of store.tasks || []) {
    taskStmt.run(
      t.id, TENANT, t.projectId || 'cue_ai_classroom',
      t.title, resolveActor(t.owner), t.owner,
      mapState(t.status), t.priority, t.risk,
      t.due, t.progress || 0, t.acceptance, t.signal,
      safeJson(t.linkedRefs), t.deliverableId,
      iso(t.createdAt), iso(t.updatedAt)
    );
    taskCount++;
  }
  console.log(`  ✓ ${taskCount} tasks`);

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
  let asgCount = 0;
  for (const a of store.assignments || []) {
    asgStmt.run(
      a.id, TENANT, a.projectId, a.date,
      resolveActor(a.owner), a.owner,
      a.taskId, a.taskTitle, a.status, a.notes,
      a.aiSuggested ? 1 : 0, iso(a.createdAt)
    );
    asgCount++;
  }
  console.log(`  ✓ ${asgCount} assignments`);

  // ── 7. standups ──────────────────────────────────────────
  console.log('\n[7/9] standups');
  const suStmt = db.prepare(`
    INSERT OR IGNORE INTO standups
      (id, tenant_id, project_id, date, actor_id, owner_legacy, yesterday, today, blockers, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let suCount = 0;
  for (const s of store.standups || []) {
    suStmt.run(
      s.id, TENANT, s.projectId, s.date,
      resolveActor(s.owner), s.owner,
      s.yesterday, s.today, s.blockers, s.status, iso(s.createdAt)
    );
    suCount++;
  }
  console.log(`  ✓ ${suCount} standups`);

  // ── 8. users ─────────────────────────────────────────────
  console.log('\n[8/9] users');
  const userStmt = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, tenant_id, actor_id, username, name, email, phone, role,
       project_ids_json, project_roles_json, active, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let userCount = 0;
  for (const u of store.users || []) {
    userStmt.run(
      u.id, TENANT, userActorMap[u.id] || null,
      u.username, u.name, u.email, u.phone, u.role,
      safeJson(u.projectIds), safeJson(u.projectRoles),
      u.active !== false ? 1 : 0, u.passwordHash,
      iso(u.createdAt), iso(u.updatedAt)
    );
    userCount++;
  }
  console.log(`  ✓ ${userCount} users`);

  // ── 9. 验证行数 ───────────────────────────────────────────
  console.log('\n[9/9] 验证行数');
  const tables = ['actors', 'tasks', 'reviews', 'activities', 'assignments', 'standups', 'projects', 'users'];
  for (const t of tables) {
    const { count } = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get();
    console.log(`  ${t}: ${count} rows`);
  }

  console.log('\n✅ Migration complete.');
  console.log('   db.json 原文件保持不变（双写期 7 天）。');
  console.log('   确认数据正确后运行 scripts/cutover.js 切单源。');
}

main().catch(err => { console.error('❌ Migration failed:', err); process.exit(1); });
