import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCurrentStage, defaultPhases, defaultStageChecklist, normalizeStageName } from './services/stageChecklist.js';

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

let cache = null;

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

function migrateStore(store) {
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
    semanticLinks: {},
    riskAnalyses: [],
    healthAnalysis: null,
    currentStage: defaultCurrentStage,
    ...store
  };

  if (!next.projects.some((project) => project.id === 'cue_ai_classroom')) {
    next.projects.unshift({
      id: 'cue_ai_classroom',
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
      p.id === 'cue_ai_classroom'
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

  next.activities = (next.activities || []).map(({ diff, ...activity }) => activity);
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
    linkedRefs: (task.linkedRefs || []).map((ref) => (
      String(ref).startsWith('cue-project-hub#') ? String(ref).replace('cue-project-hub#', `${cueAiRepo}#`) : ref
    ))
  }));
  next.assignments = next.assignments || [];
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
  // 若 phases 全是文档兜底生成的 phase_doc_N，重置为 defaultPhases（避免路径图显示文档名作为阶段）
  if (!Array.isArray(next.currentStage.phases) || !next.currentStage.phases.length) {
    next.currentStage.phases = defaultPhases;
  } else if (next.currentStage.phases.every((p) => /^phase_doc_/.test(p.id))) {
    next.currentStage.phases = defaultPhases;
  }
  // 补全节点缺失或失配的 phaseId
  const phaseIds = new Set(next.currentStage.phases.map((p) => p.id));
  next.currentStage.checklist = next.currentStage.checklist.map((node, i) => {
    if (node.phaseId && phaseIds.has(node.phaseId)) return node;
    // 先找 defaultStageChecklist 里同 id 的节点；phaseId 必须在当前 phases 中才可用
    const defaultNode = defaultStageChecklist.find((d) => d.id === node.id);
    const defaultPhaseId = defaultNode?.phaseId && phaseIds.has(defaultNode.phaseId) ? defaultNode.phaseId : null;
    // 否则按位置分配到 defaultPhases 中（每相邻阶段最多 5 个节点）
    const positional = next.currentStage.phases[Math.min(
      Math.floor(i / 5),
      next.currentStage.phases.length - 1
    )].id;
    return { ...node, phaseId: defaultPhaseId || positional };
  });
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
