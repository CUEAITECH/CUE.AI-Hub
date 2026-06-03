import { callClaude, parseJsonOutput, isAvailable } from './claude.js';
import { buildStageChecklist } from './stageChecklist.js';
import { buildMetrics, scanRisks } from './riskEngine.js';
import { loadStore, updateStore } from '../store.js';

const LINK_SYSTEM_PROMPT = `你是 Cue.AI 项目的 AI 技术项目经理。你负责把任务、阶段节点、Git commit 语义关联起来。

只输出 JSON，不要输出解释文本。格式：
{
  "taskStageLinks": [
    { "taskId": "...", "stageId": "...", "confidence": 0.0, "reason": "..." }
  ],
  "commitStageLinks": [
    { "activityId": "...", "stageId": "...", "confidence": 0.0, "reason": "..." }
  ],
  "commitTaskLinks": [
    { "activityId": "...", "taskId": "...", "confidence": 0.0, "reason": "..." }
  ]
}

规则：
- 只关联输入中存在的 id。
- confidence 低于 0.55 的不要输出。
- reason 用一句中文说明，不超过 40 字。
- 不确定时少输出，不要硬凑。`;

const RISK_SYSTEM_PROMPT = `你是 Cue.AI 项目的 AI 风险分析助手。规则引擎已经生成风险候选，你负责判断真实严重度、原因和建议动作。

只输出 JSON，不要输出解释文本。格式：
{
  "riskAnalyses": [
    { "alertId": "...", "severity": "P1|P2|P3", "confidence": 0.0, "reason": "...", "action": "..." }
  ],
  "healthAnalysis": {
    "adjustment": -5,
    "reason": "...",
    "nextFocus": "..."
  }
}

规则：
- 只分析输入中存在的 alertId。
- adjustment 范围 -5 到 5。
- 不要降低安全类、阻断 review、延期未完成风险的严重度。
- reason 和 action 均用中文短句。`;

function compactTask(task) {
  return {
    id: task.id,
    title: task.title,
    owner: task.owner,
    status: task.status,
    risk: task.risk,
    progress: task.progress,
    due: task.due || task.dueDate || '',
    sourceDoc: task.sourceDoc || '',
    description: task.description || '',
    acceptance: task.acceptance || '',
    signal: task.signal || ''
  };
}

function compactStage(item) {
  return {
    id: item.id,
    title: item.title,
    owner: item.owner,
    acceptance: item.acceptance,
    keywords: item.keywords || []
  };
}

function compactActivity(activity) {
  return {
    id: activity.id,
    title: activity.title,
    owner: activity.owner || activity.actor,
    files: (activity.files || []).slice(0, 20),
    createdAt: activity.createdAt,
    shortSha: activity.shortSha
  };
}

function normalizeLinks(payload) {
  const normalize = (items, keys) => Array.isArray(items)
    ? items
      .filter((item) => keys.every((key) => item[key]) && Number(item.confidence) >= 0.55)
      .map((item) => ({
        ...Object.fromEntries(keys.map((key) => [key, String(item[key])])),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        reason: String(item.reason || '').slice(0, 120)
      }))
      .slice(0, 120)
    : [];

  return {
    taskStageLinks: normalize(payload?.taskStageLinks, ['taskId', 'stageId']),
    commitStageLinks: normalize(payload?.commitStageLinks, ['activityId', 'stageId']),
    commitTaskLinks: normalize(payload?.commitTaskLinks, ['activityId', 'taskId']),
    generatedAt: new Date().toISOString()
  };
}

function normalizeRiskPayload(payload) {
  const analyses = Array.isArray(payload?.riskAnalyses)
    ? payload.riskAnalyses
      .filter((item) => item.alertId)
      .map((item) => ({
        alertId: String(item.alertId),
        severity: ['P1', 'P2', 'P3'].includes(item.severity) ? item.severity : undefined,
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        reason: String(item.reason || '').slice(0, 180),
        action: String(item.action || '').slice(0, 180)
      }))
      .slice(0, 80)
    : [];
  const adjustment = Math.max(-5, Math.min(5, Number(payload?.healthAnalysis?.adjustment) || 0));
  return {
    riskAnalyses: analyses,
    healthAnalysis: {
      adjustment,
      reason: String(payload?.healthAnalysis?.reason || '').slice(0, 180),
      nextFocus: String(payload?.healthAnalysis?.nextFocus || '').slice(0, 180),
      generatedAt: new Date().toISOString()
    }
  };
}

export async function buildSemanticLinks(store) {
  if (!isAvailable()) return null;
  const stage = store.currentStage || {};
  const stages = Array.isArray(stage.checklist) && stage.checklist.length ? stage.checklist : [];
  if (!stages.length) return null;

  const tasks = (store.tasks || [])
    .filter((task) => task.status !== '已完成')
    .slice(0, 80)
    .map(compactTask);
  const activities = (store.activities || [])
    .filter((activity) => activity.type === 'commit')
    .slice(0, 40)
    .map(compactActivity);

  const userPrompt = JSON.stringify({
    project: (store.projects || [])[0]?.githubFullRepo || 'CUEAITECH/Cue.AI',
    stage: {
      id: stage.id,
      name: stage.name,
      targetDate: stage.targetDate
    },
    stages: stages.map(compactStage),
    tasks,
    commits: activities
  }, null, 2);

  const raw = await callClaude(LINK_SYSTEM_PROMPT, userPrompt);
  return normalizeLinks(parseJsonOutput(raw));
}

export async function buildRiskAndHealthAnalysis(store) {
  if (!isAvailable()) return null;
  const alerts = scanRisks({ ...store, riskAnalyses: [] }).slice(0, 60);
  const metrics = buildMetrics({ ...store, riskAnalyses: [], healthAnalysis: null }, alerts);
  const checklist = buildStageChecklist(store);
  const userPrompt = JSON.stringify({
    metrics,
    stage: checklist.stage,
    stageMetrics: checklist.metrics,
    alerts: alerts.map((alert) => ({
      id: alert.id,
      severity: alert.severity,
      target: alert.target,
      title: alert.title,
      detail: alert.detail,
      source: alert.source
    })),
    tasks: (store.tasks || []).filter((task) => task.status !== '已完成').slice(0, 40).map(compactTask)
  }, null, 2);

  const raw = await callClaude(RISK_SYSTEM_PROMPT, userPrompt);
  return normalizeRiskPayload(parseJsonOutput(raw));
}

export async function buildHybridAnalysis(store) {
  const [semanticLinks, riskPayload] = await Promise.all([
    buildSemanticLinks(store),
    buildRiskAndHealthAnalysis(store)
  ]);

  return {
    semanticLinks: semanticLinks || store.semanticLinks || {},
    riskAnalyses: riskPayload?.riskAnalyses || store.riskAnalyses || [],
    healthAnalysis: riskPayload?.healthAnalysis || store.healthAnalysis || null,
    generatedAt: new Date().toISOString(),
    llmEnabled: isAvailable()
  };
}

/**
 * 通用的"刷新并落库"封装：loadStore → buildHybridAnalysis → updateStore
 * 三个调用方共用：planningRoutes / scheduler / projectRoutes(daily-scan)
 * 返回 { semanticLinks, riskAnalyses, healthAnalysis, aiAnalysisUpdatedAt }
 */
/**
 * E1: 高置信度 commit-task 关联 → 把对应任务标记为 completed。
 * 只升级（pending/in_progress → completed），不降级已完成任务。
 * confidence ≥ 0.75 才触发（TraceLLM benchmark 对标，SPEC-E1 REQ-E1-NFR-001）。
 * @param {Array} commitTaskLinks - semanticLinks.commitTaskLinks
 * @returns {Promise<string[]>} 实际翻转的 task id 列表
 */
export async function applyCommitLinksToTasks(commitTaskLinks) {
  if (!Array.isArray(commitTaskLinks) || !commitTaskLinks.length) return [];

  const highConfidence = commitTaskLinks.filter(
    (link) => Number(link.confidence || 0) >= 0.75
  );
  if (!highConfidence.length) return [];

  const taskIds = new Set(highConfidence.map((l) => l.taskId).filter(Boolean));
  const flipped = [];

  await updateStore((draft) => {
    (draft.tasks || []).forEach((task) => {
      if (taskIds.has(task.id) && task.status !== 'completed') {
        task.status = 'completed';
        task.updatedAt = new Date().toISOString();
        flipped.push(task.id);
      }
    });
    return draft;
  });

  if (flipped.length) {
    const { default: logger } = await import('../logger.js');
    logger.info(`[E1] ${flipped.length} 个任务由 commit 覆盖自动标记 completed: ${flipped.join(', ')}`);
  }
  return flipped;
}

export async function refreshAnalysisIntoStore() {
  const snap = await loadStore();
  const analysis = await buildHybridAnalysis(snap);
  await updateStore((draft) => ({
    ...draft,
    semanticLinks: analysis.semanticLinks || {},
    riskAnalyses: analysis.riskAnalyses || [],
    healthAnalysis: analysis.healthAnalysis || null,
    aiAnalysisUpdatedAt: analysis.generatedAt
  }));

  // E1: 高置信度 commit 关联 → 自动翻转任务状态
  const commitTaskLinks = analysis.semanticLinks?.commitTaskLinks || [];
  await applyCommitLinksToTasks(commitTaskLinks);

  return analysis;
}
