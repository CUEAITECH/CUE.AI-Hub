import { callClaude, parseJsonOutput, isAvailable } from './claude.js';
import { createId, updateStore } from '../store.js';
import {
  normalizeStageName,
  normalizeStageShortName,
  defaultPhases,
  reassignChecklistPhaseIds
} from './stageChecklist.js';
import { todayText } from './dailyBrief.js';
import logger from '../logger.js';


const ownerProfiles = [
  { name: '胡佳涛', keywords: ['后端', 'api', 'webhook', 'github', '数据库', '架构', '安全', '签名'] },
  { name: '罗子宽', keywords: ['前端', '界面', 'dashboard', 'review', '审阅', '联调', '样式'] },
  { name: '林世棋', keywords: ['站会', '请假', '提醒', '推进', '验收', '排期', '协调'] },
  { name: '田家铭', keywords: ['目标', '产品', '需求', '客户', 'mvp', '周报', '复盘'] }
];

const capabilityTemplates = [
  {
    title: '项目与任务管理',
    keywords: ['任务', '项目', '分工', '负责人'],
    owner: '田家铭',
    acceptance: '可以创建任务，设置 owner、截止时间、验收标准、状态、优先级和依赖关系。'
  },
  {
    title: 'Git 活动追踪',
    keywords: ['git', 'commit', 'push', 'github', 'pr'],
    owner: '胡佳涛',
    acceptance: '能够接收 commit、push、PR、review 事件，并自动关联到任务和负责人。'
  },
  {
    title: 'AI 代码审阅',
    keywords: ['review', '审阅', '代码', '提交'],
    owner: '罗子宽',
    acceptance: '每次 PR 更新后输出风险等级、关键问题、修改建议和是否阻断合并。'
  },
  {
    title: '异步站会',
    keywords: ['站会', '请假', '日报'],
    owner: '林世棋',
    acceptance: '每天自动收集昨日完成、今日计划、阻塞项、请假和交接人。'
  },
  {
    title: '风险扫描与提醒',
    keywords: ['风险', '延期', '提醒', '拖延'],
    owner: '林世棋',
    acceptance: '自动识别延期、无进展、PR 卡住、无人负责和站会未回复，并生成升级提醒。'
  },
  {
    title: '管理者驾驶舱',
    keywords: ['看板', 'dashboard', '周报', '健康度'],
    owner: '田家铭',
    acceptance: '管理者可以看到团队健康度、今日风险、成员负载、PR 卡点和周报摘要。'
  }
];

const PLANNER_SYSTEM_PROMPT = `你是 CUE Project Hub 的 AI 项目规划师。根据用户提供的阶段目标，生成结构化的研发任务列表。

团队成员与专长：
- 胡佳涛（技术架构）：后端开发、API 设计、GitHub 集成、数据库、安全、Webhook
- 罗子宽（工程实现）：前端开发、UI 界面、组件联调、样式设计
- 林世棋（项目推进）：任务排期、验收标准、异步站会、协调跟进
- 田家铭（产品负责人）：产品目标、需求分析、客户沟通、周报复盘

输出规则：
1. 生成 3-6 个任务，覆盖目标中的主要工作项
2. 每个任务分配最合适的负责人
3. 截止日期从今天开始合理分配，不超过 14 天
4. 任务之间可以有依赖关系
5. 仅输出 JSON 数组，不包含任何其他文字、注释或 markdown 标题

每个任务的 JSON 结构：
{
  "title": "任务名称（10字以内）",
  "owner": "负责人姓名",
  "due": "YYYY-MM-DD",
  "priority": "P1或P2",
  "acceptance": "验收标准（一句话）",
  "dependencies": ["依赖的任务标题"]
}`;

function normalizeGoal(goal) {
  return String(goal || '').trim().toLowerCase();
}

function pickOwner(text) {
  const lowerText = normalizeGoal(text);
  const scored = ownerProfiles
    .map((profile) => ({
      name: profile.name,
      score: profile.keywords.reduce((sum, keyword) => sum + (lowerText.includes(keyword) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.score > 0 ? scored[0].name : '田家铭';
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function normalizeGeneratedTask(task, index) {
  const now = new Date();
  return {
    title: String(task.title || '未命名任务').trim(),
    owner: task.owner || '田家铭',
    due: task.due || addDays(now, index + 2),
    priority: task.priority === 'P1' ? 'P1' : 'P2',
    status: '待确认',
    progress: 0,
    risk: index === 0 ? '中' : '低',
    signal: 'AI 根据阶段目标生成（LLM），等待负责人确认',
    acceptance: String(task.acceptance || '待补充验收标准').trim(),
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    estimatedDays: 3
  };
}

function generatePlanWithRules(goal, existingMembers = []) {
  const text = normalizeGoal(goal);
  const now = new Date();
  const selected = capabilityTemplates.filter((template) => {
    return template.keywords.some((keyword) => text.includes(keyword));
  });

  const templates = selected.length ? selected : capabilityTemplates.slice(0, 4);
  const memberNames = existingMembers.map((member) => member.name);

  return templates.map((template, index) => {
    const owner = template.owner || pickOwner(template.title);
    return {
      title: template.title,
      owner: memberNames.includes(owner) ? owner : memberNames[index % Math.max(memberNames.length, 1)] || owner,
      due: addDays(now, index + 2),
      priority: index < 2 ? 'P1' : 'P2',
      status: '待确认',
      progress: 0,
      risk: index === 0 ? '中' : '低',
      signal: 'AI 根据阶段目标生成，等待负责人确认',
      acceptance: template.acceptance,
      dependencies: index === 0 ? [] : [templates[index - 1].title],
      estimatedDays: index < 2 ? 2 : 3
    };
  });
}

export async function generatePlan(goal, existingMembers = []) {
  if (isAvailable()) {
    const today = new Date().toISOString().slice(0, 10);
    const userPrompt = `今天是 ${today}。\n阶段目标：${goal}\n\n请生成 3-6 个任务的 JSON 数组。`;
    const raw = await callClaude(PLANNER_SYSTEM_PROMPT, userPrompt);
    const tasks = parseJsonOutput(raw);
    if (Array.isArray(tasks) && tasks.length > 0) {
      return tasks.map((task, index) => normalizeGeneratedTask(task, index));
    }
    logger.warn('[Planner] LLM 输出解析失败，降级到规则引擎');
  }
  return generatePlanWithRules(goal, existingMembers);
}

// ─── AI 任务进度扫描 ──────────────────────────────────────────────────────────

export const AI_PROGRESS_SYSTEM = `你是任务进度评估助手。根据每个任务的验收标准和关联 Git 提交，评估完成度（0-100 整数）。

评分标准：
- 提交完整覆盖验收标准所有功能点 → 85-100
- 核心功能已实现，边缘情况或测试待处理 → 65-84
- 部分功能实现，主干仍未完成 → 30-64
- 少量相关提交，主体未开始 → 10-29

输出格式：JSON 数组，每项：{"taskId":"task_xxx","progress":75,"reason":"理由（20字内）","hint":"要提高进度还需要补充的内容（30字内）","suggestComplete":false}
suggestComplete 为 true 当且仅当 progress >= 80。hint 说明提高进度需要哪些具体证据或操作（如：补充测试提交、PR合并、验收截图等）。只返回 JSON 数组，不要其他文字。`;

export async function estimateTasksProgress(store) {
  const activeTasks = (store.tasks || []).filter((t) => t.status !== '已完成' && t.status !== '已取消');
  if (!activeTasks.length) return [];
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentCommits = (store.activities || []).filter((a) => a.type === 'commit' && a.createdAt >= cutoff);

  const taskOwners = new Map();
  for (const a of (store.assignments || [])) {
    if (!a.taskId || a.status === '已取消') continue;
    if (!taskOwners.has(a.taskId)) taskOwners.set(a.taskId, new Set());
    taskOwners.get(a.taskId).add(a.owner);
  }

  const semanticTaskIds = new Map();
  for (const link of ((store.semanticLinks || {}).commitTaskLinks || [])) {
    if (Number(link.confidence) >= 0.4) {
      if (!semanticTaskIds.has(link.taskId)) semanticTaskIds.set(link.taskId, new Set());
      semanticTaskIds.get(link.taskId).add(link.activityId);
    }
  }

  const taskEntries = activeTasks.map((task) => {
    const owners = taskOwners.get(task.id) || new Set();
    const semanticIds = semanticTaskIds.get(task.id) || new Set();
    const titleWords = task.title.toLowerCase().replace(/[^一-龥a-z0-9]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
    const linked = recentCommits.filter((c) => {
      const text = `${c.title || ''} ${(c.files || []).join(' ')}`.toLowerCase();
      return semanticIds.has(c.id)
        || (owners.size > 0 && owners.has(c.owner || c.actor || ''))
        || text.includes(task.id.toLowerCase())
        || titleWords.some((w) => text.includes(w));
    });
    return { task, commits: linked.slice(0, 8) };
  }).filter((e) => e.commits.length > 0);

  if (!taskEntries.length) return [];

  const userPrompt = taskEntries.map(({ task, commits }) => [
    `任务 ${task.id}：${task.title}`,
    `验收：${task.acceptance || '未定'}`,
    `当前进度：${task.progress || 0}%`,
    `认领人：${[...(taskOwners.get(task.id) || [])].join('、') || task.owner || '未知'}`,
    `关联提交：\n${commits.map((c) => `  - [${c.owner || c.actor || '?'}] ${c.title || c.id}`).join('\n')}`
  ].join('\n')).join('\n---\n');

  const raw = await callClaude(AI_PROGRESS_SYSTEM, userPrompt);
  const parsed = raw ? parseJsonOutput(raw) : null;
  return Array.isArray(parsed) ? parsed : [];
}

// ─── PR / AC / commit 触发计划调整建议 ─────────────────────────────────────────

function getComplianceCounts(trigger) {
  const compliance = trigger?.hubReview?.compliance || trigger?.prAgentReview?.compliance || trigger?.compliance || {};
  return {
    done: Array.isArray(compliance.done) ? compliance.done.length : 0,
    notDone: Array.isArray(compliance.notDone) ? compliance.notDone.length : 0,
    needsHumanCheck: Array.isArray(compliance.needsHumanCheck) ? compliance.needsHumanCheck.length : 0
  };
}

function isPullTrigger(trigger) {
  return trigger?.type === 'pull'
    || trigger?.pullId
    || trigger?.number
    || trigger?.hubReview
    || trigger?.prAgentReview;
}

function summarizePlanTrigger(trigger) {
  if (isPullTrigger(trigger)) {
    const counts = getComplianceCounts(trigger);
    const level = trigger?.hubReview?.level || trigger?.prAgentReview?.level || trigger?.level || '未审阅';
    return `- PR #${trigger.number || trigger.id} [${trigger.state || 'unknown'}] ${trigger.title || ''}; Hub ${level}; AC done=${counts.done}, notDone=${counts.notDone}, humanCheck=${counts.needsHumanCheck}`;
  }
  return `- ${trigger.owner || trigger.actor || 'unknown'}: ${trigger.title || trigger.message || trigger.id} (${trigger.repo || ''})`;
}

function getPlanTriggerKind(activities = []) {
  return activities.some(isPullTrigger) ? 'PR / AC' : 'commit';
}

export async function generatePlanAdjustment(activities, store) {
  const triggerKind = getPlanTriggerKind(activities);
  const SYSTEM = `你是 CUE Project Hub 的 AI PM。根据最新 GitHub PR / AC / commit 信号和当前任务状态，判断是否需要调整开发计划。
必须输出 JSON，不要输出 Markdown。格式：
{
  "needed": true,
  "scope": "minor|major|progress",
  "summary": "一句话说明",
  "suggestion": "不超过 200 字的具体计划调整",
  "impact": "影响范围",
  "requiresApprovalReason": "如为 major，说明为什么需要人工审批",
  "stageUpdate": {
    "shortName": "总览短名，中文最多14字或英文最多20字符，只写阶段简称，不写项目全名",
    "status": "进行中|高风险|阻塞|已完成",
    "progressDelta": 0,
    "checklist": [
      { "id": "已有或新阶段节点 id", "title": "阶段节点短标题", "owner": "负责人", "keywords": ["commit 关键词"], "acceptance": "验收口径", "phaseId": "所属阶段id（必填，从当前阶段划分中选，不能新建）" }
    ]
  }
}
分类规则：
- progress：只同步进度、补充证据、确认任务推进，可自动执行。
- minor：小范围拆分、补充验收标准、调整当天跟进项，可自动执行。
- major：改变阶段目标、延期、转派关键负责人、调整里程碑或影响多人排期，必须人工审批。
- 如果建议影响阶段展示或路径图，必须给出 stageUpdate；总览只能使用后端生成的 shortName，不能让前端临时裁剪长阶段名。
- stageUpdate.checklist 每个节点必须有 phaseId，从当前阶段划分中选 id，不能新建 phaseId。
- 不需要调整时输出 {"needed": false}。`;
  const activeTasks = (store.tasks || []).filter((t) => t.status !== '已完成').slice(0, 10);
  const stage = normalizeStageName(store.currentStage || {});
  const commitSummary = activities.map(summarizePlanTrigger).join('\n');
  const taskSummary = activeTasks.map((t) => `- [${t.status}] ${t.title}（${t.owner}）进度${t.progress}%`).join('\n');
  const stageSummary = `当前阶段：${stage.name}；总览短名：${stage.shortName}；目标日期：${stage.targetDate || '待确认'}；状态：${stage.status || '进行中'}；进度：${Number(stage.progress) || 0}%`;
  const phases = store.currentStage?.phases || [];
  const phaseLine = phases.length ? `当前阶段划分：${phases.map((p) => `${p.id}（${p.title}）`).join('、')}` : '';
  const text = await callClaude(SYSTEM, `${stageSummary}${phaseLine ? '\n' + phaseLine : ''}\n\n最新${triggerKind}信号：\n${commitSummary}\n\n当前任务：\n${taskSummary}`);
  const parsed = parseJsonOutput(text);
  if (parsed && parsed.needed === false) return null;
  const scope = ['major', 'minor', 'progress'].includes(parsed?.scope) ? parsed.scope : inferAdjustmentScope(text, activities);
  const stageUpdate = normalizePlanStageUpdate(parsed?.stageUpdate, scope, activities);
  return {
    scope,
    mode: scope === 'major' ? 'approval' : 'auto',
    status: scope === 'major' ? 'pending_approval' : 'auto_applied',
    summary: parsed?.summary || (scope === 'progress' ? `同步 ${triggerKind} 进度信号` : `根据 ${triggerKind} 调整开发计划`),
    suggestion: parsed?.suggestion || text || '',
    impact: parsed?.impact || summarizeAdjustmentImpact(scope, activities),
    requiresApprovalReason: parsed?.requiresApprovalReason || (scope === 'major' ? '涉及阶段目标、负责人或排期变化，需要人工确认。' : ''),
    stageUpdate,
    costReason: `本轮 ${activities.length} 条 ${triggerKind} 信号触发一次 AI PM 判断，避免无新证据重复调用。`
  };
}

export async function generatePlanAlternatives(item) {
  if (!isAvailable()) return [];
  const SYSTEM = `你是 CUE Project Hub 的 AI PM，负责为需要人工审批的大计划调整提供备选方案。
根据已提出的主方案，生成 2 个方向不同的备选方案（保守 / 激进）。
输出 JSON 数组，不输出其他文字：
[
  {
    "title": "方案标题（10字以内）",
    "approach": "具体调整思路（100字以内）",
    "impact": "影响范围（50字以内）",
    "risk": "高|中|低",
    "stageUpdate": {
      "shortName": "中文最多14字",
      "status": "进行中|高风险|阻塞",
      "progressDelta": 0,
      "checklist": [
        { "id": "节点id", "title": "短标题", "owner": "负责人", "keywords": [], "acceptance": "验收口径", "phaseId": "所属阶段id（必填，从当前阶段划分中选）" }
      ]
    }
  }
]`;
  const currentPhases = (item.stageUpdate?.phases || []);
  const phaseLine = currentPhases.length ? `当前阶段划分：${currentPhases.map((p) => `${p.id}（${p.title}）`).join('、')}\n` : '';
  const userPrompt = `${phaseLine}主方案：${item.suggestion || ''}\n原因：${item.requiresApprovalReason || ''}\n影响：${item.impact || ''}`;
  const text = await callClaude(SYSTEM, userPrompt);
  const parsed = parseJsonOutput(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 2).map((opt, i) => ({
    id: i + 2,
    title: String(opt.title || `备选方案${i + 2}`).slice(0, 20),
    approach: String(opt.approach || '').slice(0, 200),
    impact: String(opt.impact || '').slice(0, 100),
    risk: ['高', '中', '低'].includes(opt.risk) ? opt.risk : '中',
    stageUpdate: opt.stageUpdate || null
  }));
}

export function normalizePlanStageUpdate(stageUpdate, scope, activities = []) {
  const input = stageUpdate && typeof stageUpdate === 'object' ? stageUpdate : {};
  const fallbackShortName = inferStageShortNameFromActivities(activities);
  const normalized = {};
  const shortName = String(input.shortName || input.displayName || fallbackShortName || '').trim();
  if (shortName) normalized.shortName = normalizeStageShortName(shortName);
  if (['进行中', '高风险', '阻塞', '已完成'].includes(input.status)) normalized.status = input.status;
  if (Number.isFinite(Number(input.progressDelta))) {
    normalized.progressDelta = Math.max(-30, Math.min(30, Number(input.progressDelta)));
  } else if (scope === 'progress') {
    normalized.progressDelta = activities.length ? Math.min(8, activities.length * 2) : 1;
  }
  if (Array.isArray(input.checklist)) {
    normalized.checklist = input.checklist
      .filter((item) => item && item.title)
      .slice(0, 8)
      .map((item) => ({
        id: String(item.id || createId('stage_node')).replace(/[^\w-]/g, '_').slice(0, 64),
        title: String(item.title || '').trim().slice(0, 32),
        owner: String(item.owner || '未指定').trim().slice(0, 32),
        keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 10).map((keyword) => String(keyword).trim()).filter(Boolean) : [],
        acceptance: String(item.acceptance || item.title || '').trim().slice(0, 160),
        ...(item.phaseId ? { phaseId: String(item.phaseId).replace(/[^\w-]/g, '_').slice(0, 64) } : {})
      }));
  }
  return Object.keys(normalized).length ? normalized : null;
}

export function inferStageShortNameFromActivities(activities = []) {
  const text = activities.map((activity) => `${activity.title || ''} ${(activity.files || []).join(' ')}`).join(' ').toLowerCase();
  if (/pr|pull|acceptance|ac|验收|合并|merge/.test(text)) return 'PR 验收闭环';
  if (/trtc|asr|session|usersig|课堂/.test(text)) return 'MVP / TRTC 联调';
  if (/review|block|escalate|审阅/.test(text)) return 'AI Review 闭环';
  if (/standup|meeting|晚会|分工/.test(text)) return '晚会分工闭环';
  return '';
}

export function applyPlanAdjustmentToStage(store, adjustment) {
  const stageUpdate = adjustment?.stageUpdate;
  if (!stageUpdate) return store;
  const currentStage = normalizeStageName(store.currentStage || {});
  const nextStage = {
    ...currentStage,
    shortName: stageUpdate.shortName || currentStage.shortName,
    status: stageUpdate.status || currentStage.status,
    progress: Math.max(0, Math.min(100, Number(currentStage.progress) + (Number(stageUpdate.progressDelta) || 0))),
    updatedAt: new Date().toISOString()
  };
  if (Array.isArray(stageUpdate.checklist) && stageUpdate.checklist.length) {
    const existing = Array.isArray(currentStage.checklist) ? currentStage.checklist : [];
    const byId = new Map(existing.map((item) => [item.id, item]));
    stageUpdate.checklist.forEach((item) => {
      byId.set(item.id, { ...(byId.get(item.id) || {}), ...item });
    });
    nextStage.checklist = [...byId.values()];
  }
  if (Array.isArray(stageUpdate.phases) && stageUpdate.phases.length) {
    nextStage.phases = stageUpdate.phases;
  }
  const effectivePhases = nextStage.phases?.length ? nextStage.phases : defaultPhases;
  if (Array.isArray(nextStage.checklist)) {
    nextStage.checklist = reassignChecklistPhaseIds(nextStage.checklist, effectivePhases, {});
  }
  return {
    ...store,
    currentStage: normalizeStageName(nextStage)
  };
}

export function buildPlanAdjustmentRecord(adjustment, activities, source) {
  return {
    id: createId('adjust'),
    date: todayText(),
    trigger: activities.map((activity) => isPullTrigger(activity) ? `PR #${activity.number || activity.id} ${activity.title || ''}` : activity.title).join('; '),
    triggerCount: activities.length,
    source,
    ...adjustment,
    appliedAt: adjustment.status === 'auto_applied' && adjustment.stageUpdate ? new Date().toISOString() : undefined,
    createdAt: new Date().toISOString()
  };
}

export async function persistPlanAdjustment(adjustment, activities, source) {
  if (!adjustment) return null;
  const record = buildPlanAdjustmentRecord(adjustment, activities, source);
  await updateStore((draft) => {
    let nextDraft = draft;
    if (record.status === 'auto_applied') {
      nextDraft = applyPlanAdjustmentToStage(draft, record);
    }
    nextDraft.planAdjustments = nextDraft.planAdjustments || [];
    nextDraft.planAdjustments.unshift(record);
    nextDraft.planAdjustments = nextDraft.planAdjustments.slice(0, 50);
    return nextDraft;
  });
  return record;
}

export function inferAdjustmentScope(text, activities = []) {
  const raw = `${text || ''} ${activities.map((a) => a.title || '').join(' ')}`;
  if (/延期|里程碑|阶段目标|转派|负责人|排期|范围|降级|上线|发布|阻塞/i.test(raw)) return 'major';
  if (/进度|完成|提交|同步|证据|验收|合并|AC|PR/i.test(raw)) return 'progress';
  if (/进度|完成|提交|同步|证据/i.test(raw)) return 'progress';
  return 'minor';
}

export function summarizeAdjustmentImpact(scope, activities = []) {
  const triggerKind = getPlanTriggerKind(activities);
  if (scope === 'major') return '可能影响阶段目标、负责人或排期。';
  if (scope === 'progress') return `只更新任务进度信号和 ${triggerKind} 证据。`;
  return `影响 ${activities.length || 1} 条 ${triggerKind} 对应的当天跟进项。`;
}
