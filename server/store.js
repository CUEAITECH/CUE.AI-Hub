import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCurrentStage, defaultPhases, defaultStageChecklist, normalizeStageName, reassignChecklistPhaseIds } from './services/stageChecklist.js';

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

export function migrateStore(store) {
  const now = new Date().toISOString();
  const next = {
    tasks: [],
    members: [],
    reviews: [],
    activities: [],
    standups: [],
    assignments: [],
    alerts: [],
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
    currentStage: defaultCurrentStage,
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
      // 补充 humanDecision 字段（人工审阅决策）
      return Object.hasOwn(migrated, 'humanDecision') ? migrated : { ...migrated, humanDecision: null };
    });
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
  next.phases = Array.isArray(next.phases) && next.phases.length
    ? next.phases.map(normalizePhaseRecord)
    : sourcePhases.map(normalizePhaseRecord);
  next.deliverables = Array.isArray(next.deliverables) && next.deliverables.length
    ? next.deliverables.map((deliverable) => normalizeDeliverableRecord(deliverable, next.checklistOverrides || {}, now))
    : next.currentStage.checklist.map((node) => deliverableFromChecklistNode(node, next.checklistOverrides || {}, now));
  next.tasks = (next.tasks || []).map((task) => ({
    ...task,
    acceptance: task.acceptance === 'PR diff 可输出 Pass、Warning、Block、Escalate 四级结论。'
      ? 'PR diff 可输出通过、提醒、阻断、升级四级结论。'
      : task.acceptance
  }));

  return next;
}

export async function loadStore() {
  if (cache) return cache;

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

  return cache;
}

export async function saveStore(nextStore) {
  cache = nextStore;
  // 写入前先备份，保留上一个版本供紧急恢复
  try { await copyFile(dbPath, backupPath); } catch { /* db.json 不存在时跳过 */ }
  await writeJson(dbPath, cache);
  return cache;
}

export async function updateStore(mutator) {
  const current = await loadStore();
  const next = await mutator(structuredClone(current));
  return saveStore(next || current);
}

export function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
