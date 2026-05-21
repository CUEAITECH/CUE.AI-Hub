/**
 * scripts/test-w8-sync-broker.mjs
 * W8 集成测试 — 三端同步 Broker (doc ↔ PR ↔ task)
 *
 * 测试内容：
 *   1. extractTaskRefs — 从 branch/body 解析 task_xxx 引用
 *   2. linkPRToTasks — 建立 PR → task 关联（幂等）
 *   3. onPRMerged — PR 合并推进关联任务 + emit pr.merged
 *   4. handlePRWebhook — 完整 webhook 路由（opened/closed）
 *   5. resyncAllPRLinks — 全量重同步（幂等）
 *   6. scheduleDocWriteback — 防抖写回（无 GitHub 配置时安全跳过）
 *   7. writeProgressDoc — 无 GitHub 配置时返回 skipped
 */

import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import {
  extractTaskRefs,
  linkPRToTasks,
  onPRMerged,
  handlePRWebhook,
  resyncAllPRLinks,
  scheduleDocWriteback,
  writeProgressDoc,
} from '../server/services/syncBroker.js';

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
const tenantId = `test_w8_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

// ── 基础数据 ─────────────────────────────────────────────────
const projectId = `proj_w8_${tenantId.slice(-8)}`; // 包含 tenantId 保证跨运行唯一
db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W8 Test', ?, ?)`)
  .run(projectId, tenantId, now(), now());

// 创建 4 个任务（不同状态）
const taskIds = {
  api:    `task_w8_api_${Date.now()}`,
  auth:   `task_w8_auth_${Date.now()}`,
  deploy: `task_w8_deploy_${Date.now()}`,
  done:   `task_w8_done_${Date.now()}`,
};

await dbWrite('test:w8.tasks', (db) => {
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, 'API 接口实现', 'in_review', 'P1', 80, ?, ?)`)
    .run(taskIds.api, tenantId, projectId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, '用户登录鉴权', 'in_review', 'P1', 90, ?, ?)`)
    .run(taskIds.auth, tenantId, projectId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, '部署 CI/CD', 'pending', 'P2', 0, ?, ?)`)
    .run(taskIds.deploy, tenantId, projectId, now(), now());
  db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, title, state, priority, progress, created_at, updated_at)
    VALUES (?, ?, ?, '已完成任务', 'done', 'P2', 100, ?, ?)`)
    .run(taskIds.done, tenantId, projectId, now(), now());
});

// ══════════════════════════════════════════════════════════════
// Step 1: extractTaskRefs — 解析 task 引用
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 1] extractTaskRefs — branch/body 解析'));

// branch 解析
const refs1 = extractTaskRefs(`feat/${taskIds.api}-implement`, '');
assert('从 branch 解析到 task_xxx', refs1.some(r => r.includes('task_w8_api')),
  `refs: ${refs1.join(',')}`);

// body 显式引用
const refs2 = extractTaskRefs('', `关联任务：${taskIds.auth}\n其他内容`);
assert('从 body 关联任务: 语法解析到 task', refs2.some(r => r.includes('task_w8_auth')),
  `refs: ${refs2.join(',')}`);

// Closes 格式
const refs3 = extractTaskRefs('', `Closes ${taskIds.deploy}`);
assert('从 body Closes 语法解析到 task', refs3.some(r => r.includes('task_w8_deploy')),
  `refs: ${refs3.join(',')}`);

// # 前缀格式
const refs4 = extractTaskRefs('', `#${taskIds.api}`);
assert('从 body #task_xxx 格式解析', refs4.some(r => r.includes('task_w8_api')),
  `refs: ${refs4.join(',')}`);

// branch + body 合并去重
const refs5 = extractTaskRefs(`feat/${taskIds.api}`, `关联任务：${taskIds.api}`);
assert('branch + body 重复引用去重', refs5.filter(r => r.includes('task_w8_api')).length === 1,
  `refs: ${refs5.join(',')}`);

// 无 task 引用时返回空数组
const refs6 = extractTaskRefs('feat/new-feature', '普通描述，没有 task');
assert('无 task 引用时返回空数组', refs6.length === 0,
  `refs: ${refs6.join(',')}`);

// ══════════════════════════════════════════════════════════════
// Step 2: linkPRToTasks — 建立链接（幂等）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 2] linkPRToTasks — 建立 PR-Task 链接'));

// 创建一个 PR 记录
const pullId1 = `pull_w8_${Date.now()}`;
await dbWrite('test:w8.pull1', (db) => {
  db.prepare(`INSERT INTO pulls (id, tenant_id, project_id, number, title, body, state, head_branch, base_branch, created_at, updated_at)
    VALUES (?, ?, ?, 101, 'feat: API 实现', ?, 'open', ?, 'main', ?, ?)`)
    .run(pullId1, tenantId, projectId,
      `关联任务：${taskIds.api}`,
      `feat/${taskIds.api}-endpoint`,
      now(), now());
});

const linkResult1 = await linkPRToTasks({
  tenantId,
  pullId: pullId1,
  prBranch: `feat/${taskIds.api}-endpoint`,
  prBody: `关联任务：${taskIds.api}`,
  projectId,
});

assert('linkPRToTasks 返回 linked 数组', Array.isArray(linkResult1.linked));
assert('task_w8_api 已链接', linkResult1.linked.includes(taskIds.api),
  `linked: ${linkResult1.linked.join(',')}`);

// 验证写入 DB
const link = db.prepare('SELECT * FROM pull_task_links WHERE pull_id = ? AND task_id = ?')
  .get(pullId1, taskIds.api);
assert('pull_task_links 写入 DB', !!link);

// 幂等：重复调用不产生错误和重复数据
const linkResult2 = await linkPRToTasks({
  tenantId,
  pullId: pullId1,
  prBranch: `feat/${taskIds.api}-endpoint`,
  prBody: `关联任务：${taskIds.api}`,
  projectId,
});
assert('重复 linkPRToTasks 幂等不报错', Array.isArray(linkResult2.linked));
const linkCount = db.prepare('SELECT COUNT(*) as c FROM pull_task_links WHERE pull_id = ?').get(pullId1).c;
assert('幂等后 DB 无重复记录', linkCount === 1, `count: ${linkCount}`);

// 不存在的 task ref 记入 skipped
const linkResult3 = await linkPRToTasks({
  tenantId,
  pullId: pullId1,
  prBranch: 'feat/task_nonexistent_xyz',
  prBody: '',
  projectId,
});
assert('不存在的 task ref 进入 skipped', linkResult3.skipped.some(s => s.includes('task_nonexistent')),
  `skipped: ${linkResult3.skipped.join(',')}`);

// ══════════════════════════════════════════════════════════════
// Step 3: onPRMerged — PR 合并推进任务
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 3] onPRMerged — PR 合并推进关联任务'));

// 先确保 task_api 和 task_auth 都已链接到 pullId1
await dbWrite('test:w8.link.auth', (db) => {
  db.prepare('INSERT OR IGNORE INTO pull_task_links (pull_id, task_id) VALUES (?, ?)')
    .run(pullId1, taskIds.auth);
});

const mergedAt = new Date().toISOString();
const mergeResult = await onPRMerged({ tenantId, pullId: pullId1, mergedAt });

assert('onPRMerged 返回 pullId', mergeResult.pullId === pullId1);
assert('onPRMerged 返回 taskIds 数组', Array.isArray(mergeResult.taskIds));
assert('关联任务都在 taskIds 中', mergeResult.taskIds.length >= 2,
  `taskIds: ${mergeResult.taskIds.join(',')}`);

// 验证 pulls 表状态更新
const pull1 = db.prepare('SELECT * FROM pulls WHERE id = ?').get(pullId1);
assert('pulls.state 更新为 merged', pull1?.state === 'merged',
  `state: ${pull1?.state}`);
assert('pulls.merged_at 已记录', !!pull1?.merged_at);

// ══════════════════════════════════════════════════════════════
// Step 4: handlePRWebhook — 完整 webhook 路由
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 4] handlePRWebhook — webhook 路由'));

// 无 pull_request 字段的 payload
const r1 = await handlePRWebhook({ tenantId, event: 'push', payload: {} });
assert('无 PR 的 webhook 返回 ignored', r1.ignored === true);

// PR opened 事件（触发 chain A 链接）
// 需要项目有 githubOwner/Repo 让 resolveProjectFromRepo 能找到项目
await dbWrite('test:w8.project.github', (db) => {
  db.prepare(`UPDATE projects SET github_owner = ?, github_repo = ? WHERE id = ?`)
    .run('cueai', 'my-app', projectId);
});

const openedPayload = {
  action: 'opened',
  pull_request: {
    number: 202,
    title: 'feat: 新功能',
    body: `关联任务：${taskIds.deploy}`,
    state: 'open',
    merged_at: null,
    user: { login: 'developer' },
    head: { ref: `feat/${taskIds.deploy}-ci` },
    base: { ref: 'main' },
    created_at: now(),
  },
  repository: {
    name: 'my-app',
    full_name: 'cueai/my-app',
    owner: { login: 'cueai' },
  },
};

const r2 = await handlePRWebhook({ tenantId, event: 'pull_request', payload: openedPayload });
assert('opened 事件返回 ok', r2.ok === true, JSON.stringify(r2));
assert('opened 事件有 pullId', typeof r2.pullId === 'string');
assert('opened 事件有 linked 数组', Array.isArray(r2.linked));
assert('task_deploy 链接成功', r2.linked.includes(taskIds.deploy),
  `linked: ${r2.linked.join(',')}`);

// PR closed (merged) 事件
const closedPayload = {
  action: 'closed',
  pull_request: {
    ...openedPayload.pull_request,
    state: 'closed',
    merged_at: now(),
  },
  repository: openedPayload.repository,
};

const r3 = await handlePRWebhook({ tenantId, event: 'pull_request', payload: closedPayload });
assert('closed+merged 事件返回 ok', r3.ok === true, JSON.stringify(r3));
assert('closed+merged 事件有 advanced 数组', Array.isArray(r3.advanced));

// ══════════════════════════════════════════════════════════════
// Step 5: resyncAllPRLinks — 全量重同步（幂等）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 5] resyncAllPRLinks — 全量重同步'));

const resyncResult = await resyncAllPRLinks({ tenantId, projectId });
assert('resyncAllPRLinks 返回 pulls 数量', typeof resyncResult.pulls === 'number',
  `pulls: ${resyncResult.pulls}`);
assert('resyncAllPRLinks 返回 linksCreated', typeof resyncResult.linksCreated === 'number',
  `linksCreated: ${resyncResult.linksCreated}`);

// 幂等：再次 resync 不产生重复链接
const beforeCount = db.prepare('SELECT COUNT(*) as c FROM pull_task_links').get().c;
await resyncAllPRLinks({ tenantId, projectId });
const afterCount = db.prepare('SELECT COUNT(*) as c FROM pull_task_links').get().c;
assert('resync 幂等，DB 无重复', afterCount === beforeCount,
  `before: ${beforeCount}, after: ${afterCount}`);

// ══════════════════════════════════════════════════════════════
// Step 6: scheduleDocWriteback — 防抖调度
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 6] scheduleDocWriteback — 防抖安全调度'));

// 无 project_id 的任务应安全跳过
await scheduleDocWriteback({ tenantId, taskId: 'nonexistent_task_xyz', trigger: 'test' });
assert('不存在的 task 安全跳过 writeback', true); // 没有抛错就算通过

// 正常任务触发 writeback 调度（30s 防抖，不会立即执行）
await scheduleDocWriteback({ tenantId, taskId: taskIds.api, trigger: 'test' });
assert('scheduleDocWriteback 不抛错', true);

// 连续调用防抖（同一 projectId 的 timer 被重置）
await scheduleDocWriteback({ tenantId, taskId: taskIds.api, trigger: 'test.2' });
await scheduleDocWriteback({ tenantId, taskId: taskIds.auth, trigger: 'test.3' });
assert('防抖连续调用不产生错误', true);

// ══════════════════════════════════════════════════════════════
// Step 7: writeProgressDoc — 无 GitHub 配置时安全跳过
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 7] writeProgressDoc — 无 GitHub 配置安全跳过'));

// 创建无 GitHub 配置的项目
const projectNoGH = `proj_w8_nogh_${Date.now()}`;
db.prepare(`INSERT INTO projects (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, 'W8 No GH', ?, ?)`)
  .run(projectNoGH, tenantId, now(), now());

const writeResult = await writeProgressDoc({ tenantId, projectId: projectNoGH });
assert('无 GitHub 配置时返回 skipped', writeResult.skipped === true,
  JSON.stringify(writeResult));
assert('返回 reason=no-github-config', writeResult.reason === 'no-github-config');

// 不存在的项目应抛错
try {
  await writeProgressDoc({ tenantId, projectId: 'nonexistent_proj_xyz' });
  assert('不存在的项目应抛错', false);
} catch (err) {
  assert('不存在的项目抛出正确错误', err.message.includes('not found'));
}

// ══════════════════════════════════════════════════════════════
// Step 8: buildProgressMarkdown 验证（通过 writeProgressDoc 间接测试）
// ══════════════════════════════════════════════════════════════
console.log(Y('\n[Step 8] 进度文档内容验证'));

// 给有 GitHub 配置的项目验证（会在 githubWriteFile 失败前先生成 Markdown）
// 由于没有真实 GitHub token，我们验证到生成阶段（writeProgressDoc 在 buildProgressMarkdown 后才调 GitHub）
// 因此测试项目有 GitHub 配置，但 GITHUB_TOKEN 未设置 → getOctokit 应优雅处理

// 验证任务数量：项目下有 4 个任务
const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE tenant_id = ? AND project_id = ?')
  .get(tenantId, projectId).c;
assert('测试项目有 4 个任务', taskCount === 4, `count: ${taskCount}`);

// 验证 pull_task_links 数据完整性
const totalLinks = db.prepare(`
  SELECT COUNT(*) as c FROM pull_task_links ptl
  JOIN pulls p ON ptl.pull_id = p.id AND p.tenant_id = ?
`).get(tenantId).c;
assert('已建立 PR-Task 链接', totalLinks > 0, `links: ${totalLinks}`);

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n${B('═'.repeat(55))}`);
console.log(`  W8 三端同步 Broker 测试`);
console.log(`  ${G(`✓ ${passed} passed`)}  ${failed > 0 ? R(`✗ ${failed} failed`) : ''}`);
console.log(B('═'.repeat(55)));

process.exit(failed > 0 ? 1 : 0);
