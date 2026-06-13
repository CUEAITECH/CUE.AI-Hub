import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCurrentStage, defaultPhases, defaultStageChecklist, normalizeStageName, reassignChecklistPhaseIds } from './services/stageChecklist.js';
import { rebindStoreExplicitRefs } from './services/bindingEngine.js';
import { normalizeUserRecord, verifyPassword } from './services/auth.js';
import { scheduleSyncJsonToSqlite } from './services/jsonToSqliteSync.js';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(rootDir, 'server', 'data');
const seedPath = join(dataDir, 'seed.json');
const dbPath = join(dataDir, 'db.json');
const backupPath = join(dataDir, 'db.backup.json');
const cueAiRepo = 'CUEAITECH/Cue.AI';
const legacyCueAiRepoAliases = new Set([
  'OmniNexus-Edu-copilot',
  'OmniNexusEdu/OmniNexus-Edu-copilot',
  'dirtortian/OmniNexus-Edu-copilot',
  'CUEAITECH/OmniNexus-Edu-copilot'
]);
const legacyHubReviewRepos = new Set(['cue-project-hub', 'cue-project-hub-api', 'CUEAITECH/CUE-Project-Hub', 'CUEAITECH/CUE.AI-Hub']);
const seedDemoReviewIds = new Set(['review_001', 'review_002', 'review_003']);
const defaultProjectId = 'cue_ai_classroom';
// 默认组织 id 固定为 'default'：与历史数据 tenant_id='default' 对齐，实现零数据迁移拆分。
// Organization = 租户边界（tenant_id），Project = 其下的 GitHub 仓库（project_id）。
const defaultOrgId = 'default';

let cache = null;

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

function normalizePhaseRecord(phase) {
  return {
    ...phase,
    projectId: phase.projectId || defaultProjectId
  };
}

function deliverableFromChecklistNode(node, overrides, now) {
  const override = overrides[node.id] || null;
  return {
    id: node.id,
    projectId: defaultProjectId,
    phaseId: node.phaseId || null,
    title: node.title || '',
    owner: node.owner || '',
    acceptance: node.acceptance || '',
    keywords: Array.isArray(node.keywords) ? node.keywords : [],
    status: '待补证据',
    progress: 0,
    sourceDocPath: node.sourceDocPath || '',
    docSuggestComplete: false,
    manualOverride: override
      ? { status: override.status, by: override.by, at: override.at }
      : null,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeDeliverableRecord(deliverable, overrides, now) {
  const override = overrides[deliverable.id] || deliverable.manualOverride || null;
  return {
    ...deliverable,
    projectId: deliverable.projectId || defaultProjectId,
    phaseId: deliverable.phaseId || null,
    title: deliverable.title || '',
    owner: deliverable.owner || '',
    acceptance: deliverable.acceptance || '',
    keywords: Array.isArray(deliverable.keywords) ? deliverable.keywords : [],
    status: deliverable.status || '待补证据',
    progress: Number.isFinite(Number(deliverable.progress))
      ? Math.max(0, Math.min(100, Number(deliverable.progress)))
      : 0,
    sourceDocPath: deliverable.sourceDocPath || '',
    docSuggestComplete: Boolean(deliverable.docSuggestComplete),
    manualOverride: override
      ? { status: override.status, by: override.by, at: override.at }
      : null,
    createdAt: deliverable.createdAt || now,
    updatedAt: deliverable.updatedAt || now
  };
}

function defaultAdminCredentials() {
  const username = process.env.HUB_ADMIN_USER || process.env.HUB_LOGIN_USER || 'admin';
  const password = process.env.HUB_ADMIN_PASSWORD || process.env.HUB_LOGIN_PASSWORD || '123456';
  return { username, password };
}

function defaultAdminUser(now) {
  const { username, password } = defaultAdminCredentials();
  return normalizeUserRecord({
    id: 'user_project_admin',
    username,
    name: '系统管理员',
    role: 'admin',
    projectIds: ['*'],
    projectRoles: { '*': 'admin' },
    password
  }, now);
}

function defaultTeamUsers(now) {
  const password = process.env.HUB_LOGIN_PASSWORD || '123456';
  return [
    { id: 'user_tian_jiaming', username: '田家铭', name: '田家铭', role: 'developer', projectIds: ['*'], projectRoles: { '*': 'developer' }, password },
    { id: 'user_lin_shiqi', username: '林世棋', name: '林世棋', role: 'hr_manager', projectIds: ['*'], projectRoles: { '*': 'hr_manager' }, password },
    { id: 'user_hu_jiatao', username: '胡佳涛', name: '胡佳涛', role: 'developer', projectIds: ['*'], projectRoles: { '*': 'developer' }, password },
    { id: 'user_luo_zikuan', username: '罗子宽', name: '罗子宽', role: 'developer', projectIds: ['*'], projectRoles: { '*': 'developer' }, password }
  ].map((user) => normalizeUserRecord(user, now));
}

function syncBootstrapAdmin(users, now) {
  const admin = defaultAdminUser(now);
  const hasExplicitAdminConfig = Boolean(
    process.env.HUB_ADMIN_USER
    || process.env.HUB_ADMIN_PASSWORD
    || process.env.HUB_LOGIN_USER
    || process.env.HUB_LOGIN_PASSWORD
  );
  const byIdIndex = users.findIndex((user) => user.id === admin.id);
  if (byIdIndex === -1) {
    return users.some((user) => user.username === admin.username) ? users : [admin, ...users];
  }
  const current = users[byIdIndex];
  const { password } = defaultAdminCredentials();
  const shouldReplaceLegacyDefault = !hasExplicitAdminConfig && verifyPassword('cueai', current.passwordHash);
  users[byIdIndex] = {
    ...current,
    username: admin.username,
    name: admin.name,
    role: 'admin',
    projectIds: ['*'],
    projectRoles: { '*': 'admin' },
    active: true,
    passwordHash: shouldReplaceLegacyDefault || (hasExplicitAdminConfig && !verifyPassword(password, current.passwordHash))
      ? admin.passwordHash
      : current.passwordHash,
    updatedAt: now
  };
  return users;
}

function syncDefaultTeamUsers(users, now) {
  for (const teamUser of defaultTeamUsers(now)) {
    const index = users.findIndex((user) => user.id === teamUser.id || user.username === teamUser.username);
    if (index === -1) {
      users.push(teamUser);
      continue;
    }
    users[index] = {
      ...users[index],
      username: teamUser.username,
      name: teamUser.name,
      role: teamUser.role,
      projectIds: Array.isArray(users[index].projectIds) && users[index].projectIds.length ? users[index].projectIds : teamUser.projectIds,
      projectRoles: { ...(users[index].projectRoles || {}), '*': teamUser.role },
      active: users[index].active !== false,
      updatedAt: now
    };
  }
  return users;
}

export function migrateStore(store) {
  const now = new Date().toISOString();
  // 关键：判断输入 store 中是否原本就有 deliverables/phases 字段
  // 用于区分"首次迁移（legacy）"与"已迁移但被显式清空（reset 后）"
  const hadDeliverables = Array.isArray(store?.deliverables);
  const hadPhases = Array.isArray(store?.phases);
  const next = {
    tasks: [],
    members: [],
    reviews: [],
    activities: [],
    standups: [],
    assignments: [],
    attendanceRecords: [],
    alerts: [],
    organizations: [],
    projects: [],
    eveningReports: {},
    reports: {},
    planAdjustments: [],
    roadmapReviews: [],
    docTasks: {},
    deliverables: [],
    phases: [],
    checklistOverrides: {},
    semanticLinks: {},
    riskAnalyses: [],
    healthAnalysis: null,
    users: [],
    dailyTaskSuggestions: {},
    aiPromptTraces: [],
    pulls: [],
    bypasses: [],
    currentStage: defaultCurrentStage,
    // Task v2 / Agentic SDLC Phase 1/2 新增集合
    milestones: [],
    prds: [],
    clarifications: {},
    testRuns: [],
    gapAnalysis: {},
    manualTestQueue: [],
    ...store
  };

  if (!next.projects.some((project) => project.id === defaultProjectId)) {
    next.projects.unshift({
      id: defaultProjectId,
      name: 'Cue.AI',
      githubOwner: 'CUEAITECH',
      repository: 'Cue.AI',
      githubFullRepo: 'CUEAITECH/Cue.AI',
      localPath: '',
      branch: '',
      status: '待同步',
      lastSyncAt: '',
      summary: 'Cue.AI 主仓库，作为项目中枢的真实研发交付试点项目。'
    });
  }

  // 迁移：为已有项目补充 githubOwner / githubFullRepo 字段
  next.projects = next.projects.map((p) => {
    if (
      p.id === defaultProjectId
      && (
        !p.githubOwner
        || p.githubFullRepo === 'dirtortian/OmniNexus-Edu-copilot'
        || p.githubFullRepo === 'OmniNexusEdu/OmniNexus-Edu-copilot'
        || p.githubFullRepo === 'CUEAITECH/CUE-Project-Hub'
        || p.localPath?.includes('OmniNexus-Edu-copilot')
      )
    ) {
      return {
        ...p,
        name: 'Cue.AI',
        githubOwner: 'CUEAITECH',
        repository: 'Cue.AI',
        githubFullRepo: 'CUEAITECH/Cue.AI',
        localPath: p.localPath === rootDir ? '' : p.localPath,
        summary: 'Cue.AI 主仓库，作为项目中枢的真实研发交付试点项目。'
      };
    }
    // 如果有 githubOwner 但缺 githubFullRepo，自动补全
    if (p.githubOwner && p.repository && !p.githubFullRepo) {
      return { ...p, githubFullRepo: `${p.githubOwner}/${p.repository}` };
    }
    return p;
  });

  // 迁移：为已有成员补充 githubLogin 字段（默认空字符串，可由管理员在设置中填写）
  next.members = (next.members || []).map((m) => ({
    githubLogin: '',
    ...m
  }));

  next.activities = (next.activities || []).map(({ diff, ...activity }) => ({
    ...activity,
    deliverableId: activity.deliverableId || null,
    taskId: activity.taskId || null
  }));
  next.reviews = (next.reviews || [])
    .filter((review) => !(seedDemoReviewIds.has(review.id) && legacyHubReviewRepos.has(review.repo)))
    .map((review) => {
      const migrated = legacyCueAiRepoAliases.has(review.repo) || legacyHubReviewRepos.has(review.repo)
        ? { ...review, repo: cueAiRepo }
        : review;
      // humanDecision：旧格式为 string（'acknowledged'|'needs-fix'|'exempted'），迁移为对象结构
      const legacyDecisionMap = { acknowledged: 'approved', 'needs-fix': 'requested_changes', exempted: 'approved' };
      let humanDecision = migrated.humanDecision;
      if (typeof humanDecision === 'string' && humanDecision) {
        humanDecision = {
          status: legacyDecisionMap[humanDecision] || 'approved',
          reviewer: '',
          reason: migrated.humanNote || '',
          overrideBlock: humanDecision === 'exempted',
          overrideReason: humanDecision === 'exempted' ? (migrated.humanNote || '') : '',
          timestamp: migrated.humanAt || now
        };
      } else if (!humanDecision || typeof humanDecision !== 'object') {
        humanDecision = null;
      }
      const withDecision = { ...migrated, humanDecision };
      // 补充 completionRate（AI 评估完成度，默认 null 表示未计算）
      const withRate = Object.hasOwn(withDecision, 'completionRate') ? withDecision : { ...withDecision, completionRate: null };
      // 补充 blocks（Block 级问题列表，用于 override 流程）
      const withBlocks = Object.hasOwn(withRate, 'blocks') ? withRate : {
        ...withRate,
        blocks: (withRate.issues || [])
          .filter((i) => i.severity === 'critical' || i.severity === 'security')
          .map((i) => ({ issue: i.header || i.description || '', severity: i.severity, isOverridden: false }))
      };
      // 补充 compliance / issues 字段
      const withCompliance = Object.hasOwn(withBlocks, 'compliance') ? withBlocks : { ...withBlocks, compliance: null };
      const withIssues = Object.hasOwn(withCompliance, 'issues') ? withCompliance : { ...withCompliance, issues: [] };
      return Object.hasOwn(withIssues, 'pullId') ? withIssues : { ...withIssues, pullId: null };
    });
  // 为已有 pull 补全必需字段
  next.pulls = (next.pulls || []).map((pull) => ({
    prAgentReview: null,
    hubReview: null,
    linkedTaskIds: [],
    commits: [],
    mergedAt: null,
    ...pull
  }));
  // 为已有 bypass 补全必需字段
  next.bypasses = (next.bypasses || []).map((bypass) => ({
    prLinked: false,
    alertSent: false,
    ...bypass
  }));
  next.tasks = (next.tasks || []).map((task) => ({
    ...task,
    id: String(task.id || '').startsWith('undefined_')
      ? String(task.id).replace(/^undefined_/, 'task_')
      : task.id,
    deliverableId: task.deliverableId || null,
    projectId: task.projectId || defaultProjectId,
    linkedRefs: (task.linkedRefs || []).map((ref) => (
      String(ref).startsWith('cue-project-hub#') ? String(ref).replace('cue-project-hub#', `${cueAiRepo}#`) : ref
    ))
  }));
  next.assignments = (next.assignments || []).map((assignment) => ({
    ...assignment,
    deliverableId: assignment.deliverableId || null
  }));
  next.standups = next.standups || [];
  next.eveningReports = next.eveningReports || {};
  next.reports = next.reports || {};
  next.planAdjustments = next.planAdjustments || [];
  next.semanticLinks = next.semanticLinks || {};
  next.riskAnalyses = next.riskAnalyses || [];
  next.healthAnalysis = next.healthAnalysis || null;
  if (!Array.isArray(next.users) || !next.users.length) {
    next.users = [defaultAdminUser(now), ...defaultTeamUsers(now)];
  } else {
    next.users = syncBootstrapAdmin(next.users.map((user) => normalizeUserRecord(user, now)), now);
    next.users = syncDefaultTeamUsers(next.users, now);
  }

  // 为存量项目补 founderId（项目创始人）。注意必须在 users bootstrap 之后跑：
  // 已有项目无 founderId 时，挑当前在该项目里 role=project_admin 的第一个非系统管理员；
  // 没有就 fallback 到系统管理员，确保每个项目都有一个不可降级的"创始人"
  next.projects = next.projects.map((project) => {
    if (project.founderId) return project;
    const candidate = (next.users || []).find((user) => {
      const roles = user.projectRoles && typeof user.projectRoles === 'object' ? user.projectRoles : {};
      return user.role !== 'admin' && (roles[project.id] === 'project_admin' || roles['*'] === 'project_admin');
    }) || (next.users || []).find((user) => user.role === 'admin');
    return candidate ? { ...project, founderId: candidate.id } : project;
  });

  // 确保每个项目的创始人在该项目里拥有 project_admin 角色。
  // syncDefaultTeamUsers 会把通配角色重置为 developer，必须在此补回项目级权限，
  // 否则创始人每次重启后都会丢失账号管理权限（403 Forbidden）。
  next.projects.forEach((project) => {
    if (!project.founderId) return;
    const founder = (next.users || []).find((u) => u.id === project.founderId);
    if (!founder) return;
    const projectRole = (founder.projectRoles || {})[project.id];
    if (projectRole !== 'project_admin' && projectRole !== 'admin') {
      founder.projectRoles = { ...(founder.projectRoles || {}), [project.id]: 'project_admin' };
    }
  });

  const currentStage = next.currentStage || {};
  const isLegacyHubStage = currentStage.id === 'stage_mvp'
    || currentStage.name === 'CUE 项目中枢 MVP'
    || (currentStage.checklist || []).some((item) => item.id === 'stage_repo_signal');
  next.currentStage = isLegacyHubStage
    ? {
        ...defaultCurrentStage,
        progress: Number(currentStage.progress) || 0,
        status: currentStage.status || defaultCurrentStage.status,
        updatedAt: currentStage.updatedAt || '',
        checklist: defaultStageChecklist
      }
    : {
        ...defaultCurrentStage,
        checklist: defaultStageChecklist,
        ...currentStage
      };
  next.currentStage = normalizeStageName(next.currentStage);
  next.currentStage.checklist = Array.isArray(next.currentStage.checklist) && next.currentStage.checklist.length
    ? next.currentStage.checklist
    : defaultStageChecklist;
  // 补全 phases：旧数据没有时补默认值
  if (!Array.isArray(next.currentStage.phases) || !next.currentStage.phases.length) {
    next.currentStage.phases = defaultPhases;
  }
  // 补全节点缺失或失配的 phaseId（统一用 reassignChecklistPhaseIds 处理，含位置兜底和 rebalance）
  next.currentStage.checklist = reassignChecklistPhaseIds(
    next.currentStage.checklist,
    next.currentStage.phases,
    {}
  );
  const sourcePhases = Array.isArray(next.currentStage.phases) && next.currentStage.phases.length
    ? next.currentStage.phases
    : defaultPhases;
  // phases：已迁移过的 store 即使为空也保持空（reset 后语义），未迁移过的 legacy store 才补默认
  if (Array.isArray(next.phases) && next.phases.length) {
    next.phases = next.phases.map(normalizePhaseRecord);
  } else if (hadPhases) {
    next.phases = [];
  } else {
    next.phases = sourcePhases.map(normalizePhaseRecord);
  }
  // deliverables 同理：legacy 首次迁移才从 checklist 生成；已迁移过的保持空，等 sync-docs 重新填
  if (Array.isArray(next.deliverables) && next.deliverables.length) {
    next.deliverables = next.deliverables.map((deliverable) => normalizeDeliverableRecord(deliverable, next.checklistOverrides || {}, now));
  } else if (hadDeliverables) {
    next.deliverables = [];
  } else {
    next.deliverables = next.currentStage.checklist.map((node) => deliverableFromChecklistNode(node, next.checklistOverrides || {}, now));
  }
  next.tasks = (next.tasks || []).map((task) => ({
    ...task,
    acceptance: task.acceptance === 'PR diff 可输出 Pass、Warning、Block、Escalate 四级结论。'
      ? 'PR diff 可输出通过、提醒、阻断、升级四级结论。'
      : task.acceptance
  }));

  // ── Org/Project 正交拆分迁移 ──────────────────────────────────
  // Organization（租户）与 Project（GitHub 仓库）分层。默认组织 id='default'，
  // 与历史 tenant_id 对齐，无需迁移任何 tenant_id 数据。
  if (!Array.isArray(next.organizations)) next.organizations = [];
  if (!next.organizations.some((o) => o.id === defaultOrgId)) {
    // 默认组织的创始人：优先系统管理员，其次第一个用户
    const founder = (next.users || []).find((u) => u.role === 'admin')
      || (next.users || [])[0]
      || null;
    next.organizations.unshift({
      id: defaultOrgId,
      name: 'Cue.AI',
      summary: 'Cue.AI 团队默认组织，包含全部研发交付项目。',
      founderId: founder?.id || '',
      createdAt: now,
      updatedAt: now,
    });
  }
  // 每个 project 归属到一个组织（存量项目默认挂到 'default' 组织）
  next.projects = (next.projects || []).map((p) => (
    p.orgId ? p : { ...p, orgId: defaultOrgId }
  ));
  // 每个用户补全组织成员关系：orgIds + orgRoles（由 projectRoles 推导最高权限）
  const ROLE_RANK = { admin: 3, project_admin: 2, hr_manager: 1, developer: 0 };
  next.users = (next.users || []).map((u) => {
    if (Array.isArray(u.orgIds) && u.orgRoles && typeof u.orgRoles === 'object') return u;
    // 系统管理员（projectIds 含 '*'）→ 默认组织 admin
    const isGlobal = (u.projectIds || []).includes('*');
    const projectRoleValues = Object.values(u.projectRoles || {});
    const highestRole = isGlobal
      ? (u.role || 'admin')
      : projectRoleValues.reduce(
          (best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best),
          u.role || 'developer'
        );
    return {
      ...u,
      orgIds: Array.isArray(u.orgIds) && u.orgIds.length ? u.orgIds : [defaultOrgId],
      orgRoles: u.orgRoles && typeof u.orgRoles === 'object' ? u.orgRoles : { [defaultOrgId]: highestRole },
    };
  });

  // 多租户迁移：对所有数组集合补全 tenantId: 'default'
  const TENANT_STAMP_ARRAYS = [
    'tasks', 'members', 'reviews', 'activities', 'standups', 'assignments',
    'attendanceRecords', 'alerts', 'projects', 'planAdjustments', 'roadmapReviews',
    'riskAnalyses', 'deliverables', 'phases', 'users', 'aiPromptTraces', 'pulls', 'bypasses',
  ];
  for (const key of TENANT_STAMP_ARRAYS) {
    if (Array.isArray(next[key])) {
      next[key] = next[key].map((rec) =>
        rec && typeof rec === 'object' && !rec.tenantId
          ? { ...rec, tenantId: 'default' }
          : rec
      );
    }
  }

  // Task v2 字段回填：补全新字段默认值，修复 acceptance===description 历史数据
  next.tasks = (next.tasks || []).map((task) => {
    const patched = { ...task };
    if (!patched.businessNote)                    patched.businessNote = '';
    if (!Array.isArray(patched.dependencies))     patched.dependencies = [];
    if (!Array.isArray(patched.requirementRefs))  patched.requirementRefs = [];
    if (!Array.isArray(patched.evidenceRefs))     patched.evidenceRefs = [];
    if (!patched.milestoneId)                     patched.milestoneId = null;
    if (!patched.e2Status)                        patched.e2Status = 'not-tested';
    // acceptance === description → 清空（无效占位）
    if (patched.acceptance && patched.acceptance === patched.description) {
      patched.acceptance = '';
    }
    return patched;
  });

  return rebindStoreExplicitRefs(next);
}

// 'users' 故意不在此列表中：用户记录通过 orgIds/orgRoles 做权限隔离，
// 按 tenantId 过滤会导致跨组织切换时 auth/me 找不到 session user。
const FILTERABLE_KEYS = [
  'tasks', 'members', 'reviews', 'activities', 'standups', 'assignments',
  'attendanceRecords', 'alerts', 'projects', 'planAdjustments', 'roadmapReviews',
  'riskAnalyses', 'deliverables', 'phases', 'aiPromptTraces', 'pulls', 'bypasses',
];

function filterStoreByTenant(store, tenantId) {
  const FILTERABLE = FILTERABLE_KEYS;
  const filtered = { ...store };
  for (const key of FILTERABLE) {
    if (Array.isArray(filtered[key])) {
      filtered[key] = filtered[key].filter(
        (r) => !r.tenantId || r.tenantId === tenantId
      );
    }
  }
  return filtered;
}

export async function loadStore(tenantId) {
  if (cache) return tenantId && tenantId !== 'default' ? filterStoreByTenant(cache, tenantId) : cache;

  let shouldWrite = false;
  try {
    cache = await readJson(dbPath);
  } catch {
    cache = await readJson(seedPath);
    shouldWrite = true;
  }

  const migrated = migrateStore(cache);
  shouldWrite = shouldWrite || JSON.stringify(migrated) !== JSON.stringify(cache);
  cache = migrated;

  if (shouldWrite) {
    await writeJson(dbPath, cache);
  }

  return tenantId && tenantId !== 'default' ? filterStoreByTenant(cache, tenantId) : cache;
}

export async function saveStore(nextStore) {
  cache = nextStore;
  // 写入前先备份，保留上一个版本供紧急恢复
  try { await copyFile(dbPath, backupPath); } catch { /* db.json 不存在时跳过 */ }
  await writeJson(dbPath, cache);
  // 同步进 SQLite（防抖 2s，让 v2 接口读到最新数据）
  try { scheduleSyncJsonToSqlite(cache); } catch { /* DB 未初始化时静默跳过 */ }
  return cache;
}

export async function updateStore(mutator, tenantId = 'default') {
  const current = await loadStore();   // always full cache for writes
  const next = await mutator(structuredClone(current));
  if (next && tenantId) {
    // Snapshot cross-tenant records BEFORE mutation so we can restore them.
    const crossTenant = {};
    for (const key of FILTERABLE_KEYS) {
      if (!Array.isArray(current[key])) continue;
      crossTenant[key] = new Map(
        current[key]
          .filter((r) => r && r.tenantId && r.tenantId !== tenantId)
          .map((r) => [r.id, r])
      );
    }

    for (const key of FILTERABLE_KEYS) {
      if (!Array.isArray(next[key])) continue;
      // Stamp new records; restore any cross-tenant record that was modified.
      next[key] = next[key].map((r) => {
        if (!r || typeof r !== 'object') return r;
        if (!r.tenantId) return { ...r, tenantId };          // new → stamp
        if (r.tenantId !== tenantId) {
          return crossTenant[key]?.get(r.id) || r;           // restore original
        }
        return r;
      });
      // Restore cross-tenant records that the mutator deleted.
      const nextIds = new Set(next[key].map((r) => r?.id).filter(Boolean));
      for (const [id, original] of (crossTenant[key] || new Map())) {
        if (!nextIds.has(id)) next[key].push(original);
      }
    }
  }
  const saved = await saveStore(next || current);
  // 返回调用方时按 tenant 过滤，避免 POST 响应把其他租户数据暴露给调用方
  return tenantId && tenantId !== 'default' ? filterStoreByTenant(saved, tenantId) : saved;
}

export function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
