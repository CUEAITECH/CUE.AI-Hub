import { createHash } from 'node:crypto';
import { callClaude, isAvailable } from './claude.js';
import { loadStore, updateStore } from '../store.js';

// 输出格式：JSON 数组，每项 {taskId, score, reason, hint}
const SYSTEM_PROMPT = `你是研发任务匹配助手。基于成员的最近工作 + 任务的技术栈，从候选池里给出 top 3 推荐。

输入：
- 候选任务列表（id / title / acceptance / sourceDoc / deliverable.title）
- 当前成员 profile（姓名 / 最近 commits / 当前在进行任务 / 历史擅长模块）

输出 JSON 数组：[{ "taskId": "...", "score": 0-100, "reason": "一句话(<40字)", "hint": "实施提示(<60字)" }]
按 score 降序，至多 5 项（前端取 top 3）

规则：
- score ≥ 70 = 强匹配（技术栈匹配 + 上下文延续）
- 50-69 = 中匹配
- < 50 不输出
- reason 必须具体引用 commit 文件或任务关键词，禁止"非常合适"等空话
- 仅返回 JSON 数组，不要 markdown 包裹、不要解释`;

const SYSTEM_PROMPT_HASH = createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 8);

const LLM_TIMEOUT_MS = 12_000;
const TRACE_KEEP = 200;

export class LLMUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LLMUnavailableError';
    this.cause = cause;
  }
}

/**
 * 为单个 user 在 forDate 生成推荐
 * @param {string} forDate YYYY-MM-DD
 * @param {string} userId
 * @param {object} store - 调用方传入的 store snapshot
 * @param {object} options - { triggeredBy: 'scheduler' | 'manual' }
 * @returns {Promise<{candidates, pool}>}
 * @throws LLMUnavailableError 如果 LLM 不可用或失败
 */
export async function generateDailyTaskSuggestions(forDate, userId, store, options = {}) {
  const triggeredBy = options.triggeredBy || 'manual';

  // 1. 召回候选池
  const excludedTaskIds = collectSupersededTaskIds(forDate, userId, store);
  const takenTaskIds = collectOwnedTaskIds(store);
  const eligible = (store.tasks || []).filter((t) => (
    t.status === 'pending'
    && (t.owner === '待认领' || !t.owner)
    && !excludedTaskIds.has(t.id)
    && !takenTaskIds.has(t.id)
  ));

  if (!eligible.length) {
    return { candidates: [], pool: { eligibleCount: 0, totalEvaluated: 0 } };
  }

  // 2. 收集 user context
  const userContext = buildUserContext(userId, store);

  // 3. LLM 排序
  if (!isAvailable()) {
    throw new LLMUnavailableError('ANTHROPIC_API_KEY 未配置');
  }

  const deliverableTitleById = new Map(
    (store.deliverables || []).map((d) => [d.id, d.title])
  );
  const userPromptSnapshot = buildUserPrompt(eligible, userContext, deliverableTitleById);
  const startedAt = Date.now();
  let rawOutput = null;
  let parseError = null;
  let parsedCandidates = [];

  // AbortController：超时时取消底层 HTTP，避免 zombie socket（之前 Promise.race 只 reject，不取消）
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
  try {
    rawOutput = await Promise.race([
      callClaude(SYSTEM_PROMPT, userPromptSnapshot, { signal: abortController.signal }),
      timeoutAfter(LLM_TIMEOUT_MS)
    ]);
    if (!rawOutput) {
      throw new LLMUnavailableError('callClaude 返回 null');
    }
    parsedCandidates = parseRanking(rawOutput, eligible);
    if (!parsedCandidates.length) {
      throw new LLMUnavailableError('LLM 输出无有效推荐');
    }
  } catch (err) {
    parseError = err.message || String(err);
    // 写失败 trace，再抛
    await appendTrace({
      userId, forDate, triggeredBy,
      userPromptSnapshot, rawOutput,
      parsedCandidates: [], parseError,
      durationMs: Date.now() - startedAt
    });
    throw err instanceof LLMUnavailableError ? err : new LLMUnavailableError(parseError, err);
  } finally {
    clearTimeout(timeoutHandle);
  }

  // 4. 写成功 trace
  const traceId = await appendTrace({
    userId, forDate, triggeredBy,
    userPromptSnapshot, rawOutput,
    parsedCandidates, parseError: null,
    durationMs: Date.now() - startedAt
  });

  // 5. 取 top 3，挂 traceId
  return {
    candidates: parsedCandidates.slice(0, 3).map((r) => ({
      taskId: r.taskId,
      score: r.score,
      reason: r.reason,
      hint: r.hint,
      status: 'pending',
      actedAt: null,
      acceptedAssignmentId: null,
      traceId
    })),
    pool: { eligibleCount: eligible.length, totalEvaluated: parsedCandidates.length }
  };
}

function collectSupersededTaskIds(forDate, userId, store) {
  const set = new Set();
  const dayMap = store.dailyTaskSuggestions?.[forDate];
  const userEntry = dayMap?.[userId];
  if (!userEntry) return set;
  for (const c of userEntry.candidates || []) {
    if (c.status === 'superseded') set.add(c.taskId);
  }
  return set;
}

function collectOwnedTaskIds(store) {
  // 已被任何人领走的任务（owner != '待认领'），不再进入推荐池
  const set = new Set();
  for (const t of store.tasks || []) {
    if (t.owner && t.owner !== '待认领') set.add(t.id);
  }
  return set;
}

function buildUserContext(userId, store) {
  const user = (store.users || []).find((u) => u.id === userId) || {};
  const userName = user.name || user.username || userId;

  // 最近 14 天 commits
  const fortnightAgo = Date.now() - 14 * 24 * 3600 * 1000;
  const recentActivities = (store.activities || []).filter((a) => {
    if (a.actor !== userName && !String(a.actor || '').includes(userName)) return false;
    const ts = new Date(a.createdAt || a.committedAt || 0).getTime();
    return ts >= fortnightAgo;
  }).slice(0, 20);

  const recentCommitMsgs = recentActivities.map((a) => a.title || a.message || '').filter(Boolean).slice(0, 10);
  const recentCommitFiles = Array.from(new Set(
    recentActivities.flatMap((a) => a.files || []).slice(0, 25)
  ));

  // 当前进行中的任务
  const currentTasks = (store.tasks || [])
    .filter((t) => t.owner === userName && t.status !== '已完成' && t.status !== 'done')
    .map((t) => t.title)
    .slice(0, 5);

  return { name: userName, recentCommitMsgs, recentCommitFiles, currentTasks };
}

function buildUserPrompt(eligible, userContext, deliverableTitleById) {
  const tasksBlock = eligible.map((t) => ({
    id: t.id,
    title: t.title,
    acceptance: (t.acceptance || '').slice(0, 120),
    sourceDoc: t.sourceDoc || '',
    deliverableTitle: t.deliverableId ? (deliverableTitleById.get(t.deliverableId) || null) : null,
    priority: t.priority || ''
  }));
  return [
    '## 候选任务',
    JSON.stringify(tasksBlock, null, 2),
    '',
    '## 当前成员',
    JSON.stringify(userContext, null, 2),
    '',
    '请按规则输出 JSON 数组。'
  ].join('\n');
}

function parseRanking(raw, eligible) {
  const eligibleIds = new Set(eligible.map((t) => t.id));
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r === 'object' && eligibleIds.has(r.taskId) && Number(r.score) >= 50)
      .map((r) => ({
        taskId: r.taskId,
        score: Math.max(0, Math.min(100, Number(r.score) || 0)),
        reason: String(r.reason || '').slice(0, 80),
        hint: String(r.hint || '').slice(0, 100)
      }))
      .sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

async function appendTrace(payload) {
  const traceId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await updateStore((draft) => {
    draft.aiPromptTraces = draft.aiPromptTraces || [];
    draft.aiPromptTraces.unshift({
      traceId,
      feature: 'daily-task-suggestion',
      systemPromptHash: SYSTEM_PROMPT_HASH,
      timestamp: new Date().toISOString(),
      ...payload
    });
    draft.aiPromptTraces = draft.aiPromptTraces.slice(0, TRACE_KEEP);
    return draft;
  });
  return traceId;
}

function timeoutAfter(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new LLMUnavailableError(`LLM 调用超时（${ms}ms）`)), ms)
  );
}
