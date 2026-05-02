import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(rootDir, 'server', 'data');
const seedPath = join(dataDir, 'seed.json');
const dbPath = join(dataDir, 'db.json');

const cueAiRepoPath = join(rootDir, '..', 'OmniNexus-Edu-copilot');

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
    currentStage: {
      id: 'stage_mvp',
      name: 'CUE 项目中枢 MVP',
      targetDate: '2026-05-15',
      progress: 0,
      status: '进行中',
      updatedAt: ''
    },
    ...store
  };

  if (!next.projects.some((project) => project.id === 'cue_ai_classroom')) {
    next.projects.unshift({
      id: 'cue_ai_classroom',
      name: 'Cue.AI Classroom',
      githubOwner: 'dirtortian',
      repository: 'OmniNexus-Edu-copilot',
      githubFullRepo: 'dirtortian/OmniNexus-Edu-copilot',
      localPath: cueAiRepoPath,
      branch: '',
      status: '待同步',
      lastSyncAt: '',
      summary: 'CUE 课堂产品主仓库，先作为项目中枢的内部试点项目接入。'
    });
  }

  // 迁移：为已有项目补充 githubOwner / githubFullRepo 字段
  next.projects = next.projects.map((p) => {
    if (p.id === 'cue_ai_classroom' && !p.githubOwner) {
      return { ...p, githubOwner: 'dirtortian', githubFullRepo: 'dirtortian/OmniNexus-Edu-copilot' };
    }
    // 如果有 githubOwner 但缺 githubFullRepo，自动补全
    if (p.githubOwner && p.repository && !p.githubFullRepo) {
      return { ...p, githubFullRepo: `${p.githubOwner}/${p.repository}` };
    }
    return p;
  });

  next.activities = (next.activities || []).map(({ diff, ...activity }) => activity);
  next.assignments = next.assignments || [];
  next.standups = next.standups || [];
  next.eveningReports = next.eveningReports || {};
  next.reports = next.reports || {};
  next.planAdjustments = next.planAdjustments || [];
  next.currentStage = {
    id: 'stage_mvp',
    name: 'CUE 项目中枢 MVP',
    targetDate: '2026-05-15',
    progress: 0,
    status: '进行中',
    updatedAt: '',
    ...(next.currentStage || {})
  };
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
