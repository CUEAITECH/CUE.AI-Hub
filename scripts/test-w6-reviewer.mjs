/**
 * scripts/test-w6-reviewer.mjs
 * W6 集成测试 — Map-Reduce Reviewer
 *
 * 不依赖 GitHub API（用 rawDiff），全程离线可跑
 */

import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import '../server/state/reducer.js';
import { parseDiffText } from '../server/services/diffAnalyzer.js';
import { mapReduceReview } from '../server/services/mapReduceReviewer.js';

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;

let passed = 0, failed = 0;
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ${G('✓')} ${label}`); passed++; }
  else       { console.log(`  ${R('✗')} ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

initDb();
const db = getDb();
const tenantId = `test_w6_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

// ── 基础数据 ─────────────────────────────────────────────────
const projectId = `proj_w6_${Date.now()}`;
const pullId = `pull_w6_${Date.now()}`;
const taskId = `task_w6_${Date.now()}`;

db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W6 Test', ?, ?)`)
  .run(projectId, tenantId, now(), now());

await dbWrite('test:w6.setup', (db) => {
  db.prepare(`INSERT INTO pulls (id, tenant_id, project_id, number, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`)
    .run(pullId, tenantId, projectId, 101, '实现登录功能', now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, acceptance, state, priority, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_progress', 'P1', 50, ?, ?)`)
    .run(taskId, tenantId, projectId, '用户登录', '- 支持邮箱登录\n- 密码不能明文存储\n- 登录失败提示友好', now(), now());

  // 写入一些 project_memory
  const memories = [
    ['taboo', '严禁在代码中明文存储密码或 API key，必须用环境变量', 1.0],
    ['convention', 'console.log 仅用于调试，提交前必须删除', 0.9],
  ];
  for (const [kind, body, confidence] of memories) {
    db.prepare(`INSERT INTO project_memory (tenant_id, project_id, kind, body, confidence, source, created_at) VALUES (?, ?, ?, ?, ?, 'test', ?)`)
      .run(tenantId, projectId, kind, body, confidence, now());
  }
});

// ══════════════════════════════════════════════════════════════
// Step 1: parseDiffText — 解析 diff 文本
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] parseDiffText — 解析 diff'));

// 注意：unified diff hunk header 的行数必须准确，否则 parse-diff 会提前截断
// @@ -oldStart,oldLines +newStart,newLines @@
const SAMPLE_DIFF = `diff --git a/server/auth.js b/server/auth.js
index abc1234..def56789 100644
--- a/server/auth.js
+++ b/server/auth.js
@@ -1,3 +1,6 @@
 import express from 'express';
+const DB_PASSWORD = 'admin123';
+console.log('debug login');
 export function login(req, res) {
+  if (!req.body.password) return res.status(400).end();
   return res.status(401).end();
 }
diff --git a/package-lock.json b/package-lock.json
index aabbccdd..eeff0011 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,1 @@
-{"version":"1"}
+{"version":"2"}
diff --git a/src/utils.js b/src/utils.js
index 11223344..55667788 100644
--- a/src/utils.js
+++ b/src/utils.js
@@ -1,2 +1,4 @@
 export function formatDate(d) {
+  // helper util
+  return new Date(d).toISOString();
 }`;

const files = parseDiffText(SAMPLE_DIFF);

assert('解析出文件列表', files.length > 0);
assert('package-lock.json 被过滤', !files.some(f => f.path === 'package-lock.json'));
assert('auth.js 被保留', files.some(f => f.path.includes('auth.js')));
assert('utils.js 被保留', files.some(f => f.path.includes('utils.js')));

const authFile = files.find(f => f.path.includes('auth.js'));
assert('auth.js 有 additions', authFile?.additions > 0);
assert('auth.js changeType = modified', authFile?.changeType === 'modified');
assert('diffText 包含 + 行', authFile?.diffText.includes('+'));

// ══════════════════════════════════════════════════════════════
// Step 2: mapReduceReview — 规则引擎路径（无 ANTHROPIC_API_KEY 时）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] mapReduceReview — 完整审阅流程'));

const memory = db.prepare(`
  SELECT kind, body, confidence FROM project_memory WHERE tenant_id = ? AND superseded_by IS NULL
`).all(tenantId);

const result = await mapReduceReview({
  files,
  prTitle: '实现登录功能',
  acceptance: '- 支持邮箱登录\n- 密码不能明文存储\n- 登录失败提示友好',
  memory,
  tenantId,
  pullId,
  taskId,
});

assert('返回 level', ['Pass', 'Warning', 'Block', 'Escalate'].includes(result.level));
assert('level 不是 Pass（diff 中有安全问题）', result.level !== 'Pass',
  `实际 level = ${result.level}（含硬编码密码和 console.log）`);
assert('返回 issues 数组', Array.isArray(result.issues));
assert('issues 非空（diff 有安全问题）', result.issues.length > 0,
  `issues = ${JSON.stringify(result.issues.map(i => i.header))}`);
assert('返回 reviewId', typeof result.reviewId === 'string' && result.reviewId.length > 0);
assert('返回 stats', typeof result.stats === 'object');
assert('stats.filesReviewed ≥ 1', result.stats.filesReviewed >= 1);

console.log(`  level: ${result.level}, issues: ${result.issues.length}, files: ${result.stats.filesReviewed}`);
if (result.issues.length > 0) {
  console.log(`  top issue: [${result.issues[0]?.severity}] ${result.issues[0]?.header}`);
}

// ── 验证写入 reviews 表 ───────────────────────────────────────
const review = db.prepare('SELECT * FROM reviews WHERE id = ? AND tenant_id = ?').get(result.reviewId, tenantId);
assert('review 已写入 DB', !!review);
assert('review source = map-reduce', review?.source === 'map-reduce');
assert('review level 与返回值一致', review?.level === result.level);
assert('review pull_id 正确', review?.pull_id === pullId);
assert('review task_id 正确', review?.task_id === taskId);

const findings = JSON.parse(review?.findings_json || '[]');
assert('findings_json 写入 issues', findings.length === result.issues.length);

// ══════════════════════════════════════════════════════════════
// Step 3: 过滤文件（锁文件、dist 等）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] 过滤规则'));

const SKIP_DIFF = `diff --git a/dist/bundle.js b/dist/bundle.js
index 000..111 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1 @@
-var x=1;
+var x=2;
diff --git a/yarn.lock b/yarn.lock
index 000..111 100644
--- a/yarn.lock
+++ b/yarn.lock
@@ -1 +1 @@
-abc@1.0.0
+abc@1.0.1`;

const skipFiles = parseDiffText(SKIP_DIFF);
assert('dist/bundle.js 被跳过', !skipFiles.some(f => f.path.includes('dist')));
assert('yarn.lock 被跳过', !skipFiles.some(f => f.path.includes('yarn.lock')));
assert('过滤后无有效文件', skipFiles.length === 0);

// ══════════════════════════════════════════════════════════════
// Step 4: 截断超长 diff
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] 超长 diff 截断'));

const longLine = '+' + 'x'.repeat(100) + '\n';
const bigDiff = `diff --git a/big.js b/big.js
index 000..111 100644
--- a/big.js
+++ b/big.js
@@ -1,2 +1,60 @@
 // existing
${longLine.repeat(60)}`;

const bigFiles = parseDiffText(bigDiff, { maxFileDiffChars: 500 });
assert('超长文件被截断', bigFiles[0]?.truncated === true);
assert('截断后 diffText 含截断标记', bigFiles[0]?.diffText.includes('[diff truncated...]'));

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W6 Map-Reduce Reviewer 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
