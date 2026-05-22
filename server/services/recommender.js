// server/services/recommender.js
// W7: 推荐三阶段管道 — 为任务推荐最合适的 actor（人类或 AI agent）
//
// Phase 1 — 特征提取：从 DB 加载 actor profile + 任务上下文
// Phase 2 — 排名器：multi-objective scoring（skill × load × priority × affinity）
// Phase 3 — 解释器：LLM 生成自然语言推荐理由（降级到规则文本）
//
// 设计原则：
//   - actor-agnostic：人类/agent 用同一套评分逻辑，差异体现在特征值上
//   - always-on：LLM 不可用时规则排名 + 模板解释，不中断服务
//   - 可追溯：返回 scoreBreakdown，前端可展示评分维度

import { callClaude } from './claude.js';
import { getDb } from '../db/index.js';
import { getRankerWeights } from './weeklyLearning.js';
import { searchSimilarMemory } from './vectorStore.js';

// ── Phase 1: 特征提取 ────────────────────────────────────────

/**
 * 提取单个 actor 的推荐特征
 *
 * @param {object} actor - actors 表行
 * @param {object} task  - tasks 表行
 * @param {string} tenantId
 * @returns {object} ActorFeatures
 */
function extractActorFeatures(actor, task, tenantId) {
  const db = getDb();
  const capabilities = JSON.parse(actor.capabilities_json || '[]');

  // ── 当前负载：in_progress + claimed 任务数 ─────────────────
  const { load } = db.prepare(`
    SELECT COUNT(*) as load FROM tasks
    WHERE tenant_id = ? AND actor_id = ? AND state IN ('claimed', 'in_progress')
  `).get(tenantId, actor.id);

  // ── 历史成功率：近 30 天完成任务中 agent review Pass 比例 ─
  const recentReviews = db.prepare(`
    SELECT r.level FROM reviews r
    JOIN tasks t ON r.task_id = t.id
    WHERE r.tenant_id = ? AND t.actor_id = ?
      AND r.source = 'agent'
      AND r.created_at >= datetime('now', '-30 days')
    LIMIT 20
  `).all(tenantId, actor.id);
  const successRate = recentReviews.length > 0
    ? recentReviews.filter(r => r.level === 'Pass').length / recentReviews.length
    : 0.5; // 无历史数据时中立

  // ── 最近产出（最后活跃时间）──────────────────────────────
  const lastActive = actor.updated_at || actor.created_at;
  const daysSinceActive = (Date.now() - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);

  // ── 技能匹配：task title/acceptance 与 capabilities 关键词 ─
  const taskText = `${task.title} ${task.acceptance || ''} ${task.signal || ''}`.toLowerCase();
  const skillMatch = computeSkillMatch(capabilities, taskText);

  // ── autonomy_level（仅 agent 有意义）─────────────────────
  const autonomyLevel = actor.autonomy_level || 0;

  return {
    actorId: actor.id,
    type: actor.type,         // 'human' | 'ai-agent'
    displayName: actor.display_name,
    capabilities,
    load,                     // 当前任务数（越少越好）
    successRate,              // 近期成功率 0-1
    skillMatch,               // 技能匹配度 0-1
    autonomyLevel,            // 自主度 0-5
    daysSinceActive,          // 越小越活跃
    lastActive,
  };
}

/**
 * 技能关键词匹配（capabilities vs 任务文本）
 * 返回 0-1，支持语义近似（前缀匹配、同义词）
 */
const SKILL_SYNONYMS = {
  code:      ['code', 'coding', 'implement', 'develop', '开发', '实现', 'feature', 'feat'],
  review:    ['review', 'audit', '审阅', '审查', 'check', 'validate'],
  test:      ['test', 'testing', 'qa', '测试', 'spec', 'coverage'],
  research:  ['research', '调研', 'investigate', 'explore', 'analyze', 'analysis'],
  design:    ['design', 'ui', 'ux', '设计', 'prototype', 'layout'],
  devops:    ['devops', 'deploy', 'ci', 'cd', 'pipeline', 'docker', 'k8s', '部署'],
  security:  ['security', '安全', 'auth', 'permission', 'encrypt', 'vulnerability'],
  database:  ['database', 'db', 'sql', 'migration', '数据库', 'schema', 'query'],
  api:       ['api', 'endpoint', 'rest', 'graphql', 'interface', '接口'],
  payment:   ['payment', '支付', 'billing', 'order', '订单'],
};

function computeSkillMatch(capabilities, taskText) {
  if (capabilities.length === 0) return 0.3; // 无 capability 声明，低匹配

  let matchCount = 0;
  for (const cap of capabilities) {
    const synonyms = SKILL_SYNONYMS[cap.toLowerCase()] || [cap.toLowerCase()];
    if (synonyms.some(s => taskText.includes(s))) {
      matchCount++;
    }
  }
  // 至少匹配一个 capability 才有意义
  return Math.min(1, matchCount / Math.max(1, capabilities.length) + (matchCount > 0 ? 0.2 : 0));
}

// ── Phase 2: 排名器 ─────────────────────────────────────────

/**
 * 对 actor 特征打分（0-100）
 *
 * 基准权重（来自 weeklyLearning.ranker_weights，自动调整）：
 *   skill_match     × 35  — 能不能做
 *   load_balance    × 25  — 现在忙不忙（负数：越忙越低）
 *   success_history × 20  — 做得好不好（outcome ledger 驱动）
 *   recency         × 10  — 最近有没有活跃
 *   diversity       × 10  — autonomy bonus
 *
 * 每个维度基准分乘以 ranker_weights 里的动态系数（默认 1.0，由周度学习调整）
 */
function scoreActor(features, task, dynamicWeights = {}) {
  // 读取动态权重（缺失时用 1.0）
  const wSkill    = dynamicWeights.skill_match     ?? 1.0;
  const wLoad     = dynamicWeights.load_balance    ?? 1.0;
  const wSuccess  = dynamicWeights.success_history ?? 1.0;
  const wRecency  = dynamicWeights.recency         ?? 1.0;
  const wDiversity = dynamicWeights.diversity      ?? 1.0;

  // skill match: 0-1 → 0-35，乘动态权重
  const skillScore = features.skillMatch * 35 * wSkill;

  // load penalty: 0 task → 25, 5+ tasks → 0，乘动态权重
  const loadScore = Math.max(0, 25 - features.load * 5) * wLoad;

  // success rate: 0-1 → 0-20，乘 outcome ledger 权重
  const successScore = features.successRate * 20 * wSuccess;

  // freshness: 活跃天数 0 → 10, 30+ → 0，乘动态权重
  const freshnessScore = Math.max(0, 10 - features.daysSinceActive / 3) * wRecency;

  // autonomy: agent autonomy_level 0-5 → 0-10; 人类固定 5，乘 diversity 权重
  const autonomyScore = (features.type === 'ai-agent'
    ? (features.autonomyLevel / 5) * 10
    : 5) * wDiversity;

  // 任务优先级加成：P0/P1 任务对 agent autonomy 要求更高（不受动态权重影响）
  const priorityBonus = (task.priority === 'P0' || task.priority === 'P1')
    ? (features.type === 'ai-agent' ? features.autonomyLevel * 1.5 : 3)
    : 0;

  const total = skillScore + loadScore + successScore + freshnessScore + autonomyScore + priorityBonus;

  return {
    total: Math.min(100, Math.round(total)),
    breakdown: {
      skill:        Math.round(skillScore),
      load:         Math.round(loadScore),
      success:      Math.round(successScore),
      freshness:    Math.round(freshnessScore),
      autonomy:     Math.round(autonomyScore),
      priorityBonus: Math.round(priorityBonus),
    },
    weightsUsed: { wSkill, wLoad, wSuccess, wRecency, wDiversity },
  };
}

// ── Phase 3: 解释器 ──────────────────────────────────────────

const EXPLAIN_SYSTEM_PROMPT = `你是任务分配助手，为推荐结果生成简洁的中文解释。

对每个推荐的 actor，生成一句 25-40 字的推荐理由，要求：
- 具体引用技能/历史成绩/当前负载
- 不要说"非常适合"等空话
- 语气自然，像 tech lead 在 slack 上的简短建议

输出 JSON 数组（与输入顺序一致）：
[{ "actorId": "...", "reason": "..." }]`;

async function explainRecommendations(candidates, task, memory = []) {
  const memCtx = memory.filter(m => m.kind === 'convention' || m.kind === 'decision').slice(0, 3)
    .map(m => m.body).join('；') || '';

  const candidateList = candidates.slice(0, 5).map((c, i) =>
    `${i + 1}. ${c.displayName}（${c.type === 'ai-agent' ? 'AI agent' : '人类'}）` +
    `  能力:${c.capabilities.join('/')} | 负载:${c.load}个任务 | 技能匹配:${Math.round(c.skillMatch * 100)}% | 得分:${c.score}`
  ).join('\n');

  const userPrompt = `任务：${task.title}（优先级 ${task.priority || 'P2'}）
验收标准摘要：${(task.acceptance || '').slice(0, 200)}

候选推荐列表：
${candidateList}

${memCtx ? `团队约定参考：${memCtx}` : ''}

请为每个候选生成推荐理由。`;

  // 30s 超时
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const result = await callClaude(EXPLAIN_SYSTEM_PROMPT, userPrompt, { signal: controller.signal });
    clearTimeout(timer);
    if (!result) return ruleExplain(candidates, task);

    // 解析 JSON
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return ruleExplain(candidates, task);

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return ruleExplain(candidates, task);

    // merge 回 candidates
    const reasonMap = Object.fromEntries(parsed.map(p => [p.actorId, p.reason]));
    return candidates.map(c => ({
      ...c,
      reason: reasonMap[c.actorId] || ruleExplainOne(c, task),
      explainSource: 'llm',
    }));
  } catch {
    clearTimeout(timer);
    return ruleExplain(candidates, task);
  }
}

/** 规则降级解释（LLM 不可用时） */
function ruleExplain(candidates, task) {
  return candidates.map(c => ({
    ...c,
    reason: ruleExplainOne(c, task),
    explainSource: 'rule',
  }));
}

function ruleExplainOne(c, task) {
  const parts = [];

  if (c.skillMatch > 0.6) {
    parts.push(`技能（${c.capabilities.slice(0, 2).join('/')}）与任务高度匹配`);
  } else if (c.skillMatch > 0.3) {
    parts.push(`具备部分所需技能`);
  }

  if (c.load === 0) {
    parts.push('当前无任务可立即接手');
  } else if (c.load <= 2) {
    parts.push(`当前仅 ${c.load} 个任务，负载轻松`);
  } else {
    parts.push(`当前 ${c.load} 个任务，负载较重`);
  }

  if (c.successRate > 0.8) parts.push('近期完成率优秀');
  if (c.type === 'ai-agent' && c.autonomyLevel >= 3) parts.push('自主度足够，可无人值守执行');

  return parts.join('，') || `得分 ${c.score}，综合评估最优`;
}

// ── 主入口 ──────────────────────────────────────────────────

/**
 * 为任务推荐 actors
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.tenantId
 * @param {object} [params.options]
 * @param {number} [params.options.topK=5]              - 返回前 K 个
 * @param {'all'|'human'|'ai-agent'} [params.options.actorType='all'] - 过滤 actor 类型
 * @param {number} [params.options.minScore=20]          - 最低分线
 * @param {boolean} [params.options.explain=true]        - 是否生成解释
 * @returns {Promise<RecommendResult>}
 */
export async function recommendForTask({ taskId, tenantId, options = {} }) {
  const db = getDb();
  const topK      = options.topK ?? 5;
  const actorType = options.actorType ?? 'all';
  const minScore  = options.minScore ?? 20;
  const doExplain = options.explain !== false;

  // ── 读取任务 ────────────────────────────────────────────────
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId);
  if (!task) throw new Error(`task ${taskId} not found`);

  // ── 读取候选 actors（active only）──────────────────────────
  let actorQuery = 'SELECT * FROM actors WHERE tenant_id = ? AND active = 1';
  const actorParams = [tenantId];
  if (actorType !== 'all') {
    actorQuery += ' AND type = ?';
    actorParams.push(actorType);
  }
  const actors = db.prepare(actorQuery).all(...actorParams);

  if (actors.length === 0) {
    return { taskId, recommendations: [], stats: { totalCandidates: 0 } };
  }

  // ── 读取 project_memory（向量检索，给 Phase 3 用）──────────
  let memory = [];
  if (task.project_id) {
    const ragQuery = [task.title, task.priority].filter(Boolean).join(' ');
    const vecResults = searchSimilarMemory(db, {
      tenantId,
      query:     ragQuery,
      projectId: task.project_id,
      limit:     10,
    });
    if (vecResults !== null) {
      memory = vecResults;
    } else {
      // sqlite-vec 未就绪 → 回退 confidence 排序
      memory = db.prepare(`
        SELECT kind, body FROM project_memory
        WHERE tenant_id = ? AND (project_id = ? OR project_id IS NULL)
          AND superseded_by IS NULL
        ORDER BY confidence DESC LIMIT 10
      `).all(tenantId, task.project_id);
    }
  }

  // ── 读取动态权重（ranker_weights 表，由周度学习自动调整）──
  // 非阻塞：getRankerWeights 失败时退化到默认权重（全 1.0）
  let dynamicWeights = {};
  try {
    dynamicWeights = getRankerWeights(tenantId);
  } catch (err) {
    console.warn('[recommender] getRankerWeights failed, using defaults:', err.message);
  }

  // ── Phase 1 + 2：特征提取 + 评分 ───────────────────────────
  const scored = actors
    .map(actor => {
      const features = extractActorFeatures(actor, task, tenantId);
      const { total, breakdown, weightsUsed } = scoreActor(features, task, dynamicWeights);
      return { ...features, score: total, scoreBreakdown: breakdown, weightsUsed };
    })
    .filter(c => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (scored.length === 0) {
    return {
      taskId,
      recommendations: [],
      stats: { totalCandidates: actors.length, filtered: 0 },
    };
  }

  // ── Phase 3：解释器 ─────────────────────────────────────────
  let recommendations = scored;
  if (doExplain) {
    recommendations = await explainRecommendations(scored, task, memory);
  }

  // ── 格式化输出 ───────────────────────────────────────────────
  const formatted = recommendations.map(r => ({
    actorId:      r.actorId,
    displayName:  r.displayName,
    type:         r.type,
    score:        r.score,
    scoreBreakdown: r.scoreBreakdown,
    reason:       r.reason || '',
    explainSource: r.explainSource || 'none',
    capabilities: r.capabilities,
    currentLoad:  r.load,
    skillMatch:   Math.round(r.skillMatch * 100),
  }));

  return {
    taskId,
    taskTitle: task.title,
    recommendations: formatted,
    stats: {
      totalCandidates: actors.length,
      filtered: formatted.length,
      topScore: formatted[0]?.score,
    },
  };
}

/**
 * 批量推荐：为多个未分配任务同时推荐
 * 用于 dashboard 的"智能分配"视图
 */
export async function batchRecommend({ tenantId, projectId, options = {} }) {
  const db = getDb();

  let q = 'SELECT id FROM tasks WHERE tenant_id = ? AND state = ? AND actor_id IS NULL';
  const params = [tenantId, 'pending'];
  if (projectId) { q += ' AND project_id = ?'; params.push(projectId); }
  q += ' ORDER BY priority ASC, created_at ASC LIMIT 20';

  const tasks = db.prepare(q).all(...params);
  if (tasks.length === 0) return { results: [], stats: { tasksEvaluated: 0 } };

  // 串行执行（避免并发 LLM 调用爆量），options.explain=false 跳过解释加速
  const results = [];
  for (const { id } of tasks) {
    try {
      const r = await recommendForTask({ taskId: id, tenantId, options: { ...options, explain: false } });
      if (r.recommendations.length > 0) results.push(r);
    } catch (err) {
      console.warn(`[recommender] batch skip task ${id}: ${err.message}`);
    }
  }

  return { results, stats: { tasksEvaluated: tasks.length, withRecommendations: results.length } };
}
