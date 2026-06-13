import { textIncludesAny } from './bindingEngine.js';

export const defaultPhases = [
  { id: 'phase_backend', title: '后端基础', status: '进行中' },
  { id: 'phase_integration', title: '多端联调', status: '待开始' },
  { id: 'phase_acceptance', title: '验收上线', status: '待开始' }
];

export const defaultCurrentStage = {
  id: 'stage_cue_ai_trtc_mvp',
  name: 'Cue.AI 双设备课堂 MVP / TRTC 联调阶段',
  shortName: 'MVP / TRTC 联调',
  targetDate: '2026-05-15',
  progress: 0,
  status: '进行中',
  updatedAt: '',
  phases: defaultPhases
};

export function normalizeStageShortName(value, fallback = defaultCurrentStage.shortName) {
  const raw = String(value || fallback || '').replace(/\s+/g, ' ').trim();
  if (!raw) return defaultCurrentStage.shortName;
  const maxLength = /[\u3400-\u9fff]/.test(raw) ? 14 : 20;
  return Array.from(raw).slice(0, maxLength).join('').trim() || defaultCurrentStage.shortName;
}

export function normalizeStageName(stage = {}) {
  const name = String(stage.name || defaultCurrentStage.name).trim();
  const explicitShortName = String(stage.shortName || stage.displayName || '').trim();
  const derivedShortName = explicitShortName
    || name
      .replace(/^Cue\.AI\s*/, '')
      .replace(/^双设备课堂\s*/, '')
      .replace(/阶段$/, '')
      .trim()
    || defaultCurrentStage.shortName;
  return {
    ...stage,
    name,
    shortName: normalizeStageShortName(derivedShortName)
  };
}

export const defaultStageChecklist = [
  {
    id: 'stage_backend_realtime',
    phaseId: 'phase_backend',
    title: '后端实时课堂链路',
    owner: '后端/架构',
    taskIds: [],
    keywords: ['后端', 'session', 'usersig', 'asr', 'callback', '机器人', 'sop', 'sos', 'summary', '接口'],
    acceptance: '完成课堂 Session、UserSig、TRTC ASR 机器人、回调处理、SOP 推进、SOS 和课后总结的后端闭环。'
  },
  {
    id: 'stage_ipad_teacher',
    phaseId: 'phase_integration',
    title: 'iPad 老师端开课',
    owner: 'iOS',
    taskIds: [],
    keywords: ['ipad', 'ios', '老师', '教师', 'txliteavsdk', 'trtc ios', '开课', '音频', '设备绑定'],
    acceptance: 'iPad 老师端能登录、选择课程模块、创建课堂、进入 TRTC 房间并持续采集课堂音频。'
  },
  {
    id: 'stage_trtc_full_loop',
    phaseId: 'phase_integration',
    title: 'TRTC 全链路联调',
    owner: '全员',
    taskIds: [],
    keywords: ['trtc', '全链路', '联调', '课堂', 'session', 'summary', 'sos', 'asr'],
    acceptance: '跑通老师开课、学生加入、ASR 转写、SOP 推进、SOS 触发和 summary 生成的完整课堂链路。'
  },
  {
    id: 'stage_student_teacher_clients',
    phaseId: 'phase_integration',
    title: '学生/教师端加入与提示',
    owner: 'Web / iPhone',
    taskIds: [],
    keywords: ['web', 'join', '学生', 'iphone', '教师', '连接', '配对', 'sop节点', '下一环节', '课后总结'],
    acceptance: '学生 Web 端可用房间码加入课堂，教师移动端可查看连接状态、SOP 进度、SOS 结果和课后总结。'
  },
  {
    id: 'stage_content_demo_acceptance',
    phaseId: 'phase_acceptance',
    title: '内容 SOP 与 Demo 验收',
    owner: '产品/内容',
    taskIds: [],
    keywords: ['数学', '内容', 'sop', '关键词', '话术', '模板', '验收', 'demo', '八步', '闭环'],
    acceptance: '准备一门课的 SOP 内容包、关键词、SOS 话术和演示验收脚本，用于完整 Demo 验收。'
  }
];

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = item.id || item.sha || JSON.stringify(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function semanticLinksForStage(store, stageId) {
  const links = store.semanticLinks || {};
  return {
    taskIds: new Set((links.taskStageLinks || [])
      .filter((link) => link.stageId === stageId && Number(link.confidence) >= 0.55)
      .map((link) => link.taskId)),
    activityIds: new Set((links.commitStageLinks || [])
      .filter((link) => link.stageId === stageId && Number(link.confidence) >= 0.55)
      .map((link) => link.activityId)),
    commitTaskLinks: (links.commitTaskLinks || []).filter((link) => Number(link.confidence) >= 0.55)
  };
}

function linkReasonMap(links = []) {
  return Object.fromEntries((links || []).map((link) => [
    `${link.taskId || link.activityId}:${link.stageId || link.taskId}`,
    {
      confidence: link.confidence,
      reason: link.reason
    }
  ]));
}

function bindingSourceLabel(mode) {
  if (mode === 'pr') return 'PR / AC';
  if (mode === 'fk') return '显式 FK';
  if (mode === 'hybrid') return 'AI 语义';
  return '关键词兜底';
}

function bindingStrength(mode) {
  if (mode === 'pr') return 'strong';
  if (mode === 'fk') return 'strong';
  if (mode === 'hybrid') return 'medium';
  return 'weak';
}

function pullComplianceStats(pull) {
  const compliance = pull?.hubReview?.compliance || pull?.prAgentReview?.compliance || null;
  const done = Array.isArray(compliance?.done) ? compliance.done.length : 0;
  const notDone = Array.isArray(compliance?.notDone) ? compliance.notDone.length : 0;
  const needsHumanCheck = Array.isArray(compliance?.needsHumanCheck) ? compliance.needsHumanCheck.length : 0;
  return { done, notDone, needsHumanCheck, total: done + notDone + needsHumanCheck };
}

function pullMatchesDeliverable(pull, item, linkedTasks) {
  const linkedTaskIds = new Set(linkedTasks.map((task) => task.id));
  if ((pull.linkedTaskIds || []).some((taskId) => linkedTaskIds.has(taskId))) return true;
  const text = [
    pull.title,
    pull.body,
    pull.headBranch,
    pull.baseBranch,
    (pull.files || []).map((file) => file.filename || file).join(' '),
    (pull.hubReview?.compliance?.done || []).join(' '),
    (pull.hubReview?.compliance?.notDone || []).join(' '),
    (pull.hubReview?.compliance?.needsHumanCheck || []).join(' ')
  ].join(' ');
  return textIncludesAny(text, [item.id, item.title, item.acceptance, ...(item.keywords || [])]);
}

function pullEvidenceScore(pulls) {
  if (!pulls.length) return 0;
  const merged = pulls.filter((pull) => pull.state === 'merged');
  const reviewed = pulls.filter((pull) => pull.hubReview || pull.prAgentReview);
  const acCovered = pulls.filter((pull) => {
    const stats = pullComplianceStats(pull);
    return stats.done > 0 && stats.notDone === 0 && stats.needsHumanCheck <= 1;
  });
  const pass = pulls.filter((pull) => {
    const level = pull.hubReview?.level || pull.prAgentReview?.level;
    return level === 'Pass' || pull.humanDecision === 'Pass';
  });
  return Math.min(100, Math.max(
    merged.length ? 80 : 0,
    pass.length ? 75 : 0,
    acCovered.length ? 70 : 0,
    reviewed.length ? 45 : 0,
    pulls.length ? 30 : 0
  ));
}

function buildBindingExplanation({ mode, fkTasks, fkActivities, fkAssignments, linkedTasks, linkedActivities, linkedAssignments, semantic, item }) {
  const parts = [];
  if (mode === 'pr') parts.push('PR 已关联该交付项，优先按 AC 对账和合并状态判断进度');
  if (fkTasks.length) parts.push(`${fkTasks.length} 个任务通过 deliverableId 绑定`);
  if (fkActivities.length) parts.push(`${fkActivities.length} 条 commit 通过 taskId/deliverableId 绑定`);
  if (fkAssignments.length) parts.push(`${fkAssignments.length} 条认领通过 taskId/deliverableId 绑定`);
  if (!parts.length && (semantic.taskIds.size || semantic.activityIds.size)) {
    if (semantic.taskIds.size) parts.push(`${semantic.taskIds.size} 个任务来自 AI 语义关联`);
    if (semantic.activityIds.size) parts.push(`${semantic.activityIds.size} 条 commit 来自 AI 语义关联`);
  }
  if (!parts.length) {
    if (linkedTasks.length || linkedActivities.length || linkedAssignments.length) {
      parts.push(`使用关键词兜底：${(item.keywords || []).slice(0, 4).join(' / ') || item.title}`);
    } else {
      parts.push('暂无强绑定证据，等待任务、commit 或认领记录补齐 FK');
    }
  }
  return parts.join('；');
}

function scoreChecklistItem(item, tasks, activities, reviews, assignments, store) {
  const deliverableRecord = (store.deliverables || []).find((deliverable) => deliverable.id === item.id) || null;
  const semantic = semanticLinksForStage(store, item.id);
  const fkTasks = tasks.filter((task) => task.deliverableId === item.id);
  const linkedTasks = fkTasks.length
    ? fkTasks
    : tasks.filter((task) => (
        // 已经显式绑定到其他交付项的任务，不参与关键词兜底，避免跨节点污染
        (!task.deliverableId || task.deliverableId === item.id)
        && (
          semantic.taskIds.has(task.id)
          || (item.taskIds || []).includes(task.id)
          || textIncludesAny(`${task.title} ${task.acceptance} ${task.signal}`, item.keywords)
        )
      ));
  const evidenceText = [
    item.title,
    item.acceptance,
    linkedTasks.map((task) => `${task.id} ${task.title}`).join(' ')
  ].join(' ');
  const linkedTaskIds = new Set(linkedTasks.map((task) => task.id));
  const fkActivities = uniqueById(activities.filter((activity) => (
    activity.type === 'commit'
    && (
      activity.deliverableId === item.id
      || (activity.taskId && linkedTaskIds.has(activity.taskId))
    )
  )));
  const linkedActivities = fkActivities.length
    ? fkActivities
    : uniqueById(activities.filter((activity) => (
        activity.type === 'commit'
        && (
          semantic.activityIds.has(activity.id)
          || textIncludesAny(`${activity.title} ${(activity.files || []).join(' ')}`, item.keywords)
          || linkedTasks.some((task) => textIncludesAny(`${activity.title} ${(activity.files || []).join(' ')}`, [task.id, task.title]))
          || semantic.commitTaskLinks.some((link) => link.activityId === activity.id && linkedTasks.some((task) => task.id === link.taskId))
          || textIncludesAny(evidenceText, [activity.title])
        )
      )));
  const fkAssignments = assignments.filter((assignment) => (
    assignment.deliverableId === item.id
    || (assignment.taskId && linkedTaskIds.has(assignment.taskId))
  ));
  const linkedAssignments = fkAssignments.length
    ? fkAssignments
    : assignments.filter((assignment) => (
        linkedTasks.some((task) => task.id === assignment.taskId)
        || textIncludesAny(`${assignment.taskTitle} ${assignment.note}`, item.keywords)
      ));
  const linkedReviews = uniqueById(reviews.filter((review) => (
    linkedActivities.some((activity) => review.activityId === activity.id || review.id === `review_${activity.sha}`)
    || linkedTasks.some((task) => textIncludesAny(`${review.title} ${(review.findings || []).join(' ')}`, [task.id, task.title]))
  )));
  const linkedPulls = uniqueById((store.pulls || []).filter((pull) => pullMatchesDeliverable(pull, item, linkedTasks)));
  const taskProgress = linkedTasks.length
    ? Math.round(linkedTasks.reduce((sum, task) => sum + (Number(task.progress) || 0), 0) / linkedTasks.length)
    : 0;
  const hasBlockReview = linkedReviews.some((review) => review.level === 'Block' || review.level === 'Escalate')
    || linkedPulls.some((pull) => pull.hubReview?.level === 'Block' || pull.hubReview?.level === 'Escalate');
  // FK 绑定的证据才触发进度地板（避免关键词兜底虚增到 35%）
  const hasFkEvidence = fkActivities.length > 0 || fkAssignments.length > 0;
  const progress = Math.max(taskProgress, pullEvidenceScore(linkedPulls), hasFkEvidence ? 15 : 0);
  const status = hasBlockReview
    ? '阻塞'
    : linkedTasks.some((task) => task.status === '高风险' || task.risk === '高')
    ? '高风险'
    : progress >= 100
    ? '已完成'
    : progress >= 60 || linkedPulls.length || linkedActivities.length
    ? '推进中'
    : '待补证据';

  const gaps = [];
  if (!linkedTasks.length) gaps.push('缺少关联任务');
  if (!linkedPulls.length) gaps.push('缺少 PR 交付证据');
  if (linkedPulls.length && !linkedPulls.some((pull) => pull.state === 'merged')) gaps.push('PR 尚未合并验收');
  if (linkedPulls.some((pull) => pullComplianceStats(pull).notDone > 0)) gaps.push('PR AC 对账仍有缺口');
  if (!linkedAssignments.length) gaps.push('晚会未领取或未登记');
  if (hasBlockReview) gaps.push('存在阻断 Review');

  const taskReasons = linkReasonMap((store.semanticLinks || {}).taskStageLinks);
  const activityReasons = linkReasonMap((store.semanticLinks || {}).commitStageLinks);
  const linkMode = linkedPulls.length
    ? 'pr'
    : (fkTasks.length || fkActivities.length || fkAssignments.length)
    ? 'fk'
    : (semantic.taskIds.size || semantic.activityIds.size) ? 'hybrid' : 'rules';

  return {
    ...item,
    docSuggestComplete: Boolean(deliverableRecord?.docSuggestComplete),
    docStatus: deliverableRecord?.docStatus || null,
    sourceDocPath: deliverableRecord?.sourceDocPath || item.sourceDocPath || '',
    status,
    progress,
    linkedTasks: linkedTasks.map((task) => ({
      id: task.id,
      title: task.title,
      owner: task.owner,
      status: task.status,
      progress: task.progress,
      risk: task.risk,
      aiLink: taskReasons[`${task.id}:${item.id}`]
    })),
    evidence: {
      pulls: linkedPulls.slice(0, 5).map((pull) => {
        const stats = pullComplianceStats(pull);
        return {
          id: pull.id,
          number: pull.number,
          title: pull.title,
          state: pull.state,
          author: pull.author,
          level: pull.hubReview?.level || pull.prAgentReview?.level || '',
          completionRate: pull.hubReview?.completionRate ?? null,
          done: stats.done,
          notDone: stats.notDone,
          needsHumanCheck: stats.needsHumanCheck,
          humanDecision: pull.humanDecision || null
        };
      }),
      commits: linkedActivities.slice(0, 5).map((activity) => ({
        id: activity.id,
        title: activity.title,
        owner: activity.owner || activity.actor,
        shortSha: activity.shortSha,
        createdAt: activity.createdAt,
        aiLink: activityReasons[`${activity.id}:${item.id}`]
      })),
      reviews: linkedReviews.slice(0, 5).map((review) => ({
        id: review.id,
        title: review.title,
        owner: review.owner,
        level: review.level,
        score: review.score
      })),
      assignments: linkedAssignments.slice(0, 5).map((assignment) => ({
        id: assignment.id,
        owner: assignment.owner,
        taskTitle: assignment.taskTitle,
        status: assignment.status,
        date: assignment.date
      }))
    },
    gaps,
    linkMode,
    binding: {
      mode: linkMode,
      label: bindingSourceLabel(linkMode),
      strength: bindingStrength(linkMode),
      explanation: buildBindingExplanation({
        mode: linkMode,
        fkTasks,
        fkActivities,
        fkAssignments,
        linkedTasks,
        linkedActivities,
        linkedAssignments,
        linkedPulls,
        semantic,
        item
      }),
      counts: {
        tasks: linkedTasks.length,
        pulls: linkedPulls.length,
        commits: linkedActivities.length,
        reviews: linkedReviews.length,
        assignments: linkedAssignments.length,
        fkTasks: fkTasks.length,
        fkCommits: fkActivities.length,
        fkAssignments: fkAssignments.length,
        semanticTasks: semantic.taskIds.size,
        semanticCommits: semantic.activityIds.size
      }
    }
  };
}

function clampProgress(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

/**
 * 统一分配 checklist 节点的 phaseId，并做节点数 rebalance（每 phase 上限 5 个）。
 * @param {Array} checklist
 * @param {Array} phases
 * @param {Object} nodeAssignments — {nodeId: phaseId} 显式覆盖映射（来自 LLM）
 * @returns {Array} 新数组（不修改原数组）
 */
export function reassignChecklistPhaseIds(checklist, phases, nodeAssignments = {}) {
  if (!phases?.length) return checklist;
  const phaseIdSet = new Set(phases.map((p) => p.id));

  // 1. 为每个节点确定 phaseId
  const assigned = checklist.map((node, idx) => {
    const override = nodeAssignments[node.id];
    if (override && phaseIdSet.has(override)) return { ...node, phaseId: override };
    if (node.phaseId && phaseIdSet.has(node.phaseId)) return node;
    // 位置兜底：均匀分配
    const positional = phases[Math.min(
      Math.floor(idx / Math.ceil(checklist.length / phases.length)),
      phases.length - 1
    )].id;
    return { ...node, phaseId: positional };
  });

  // 不做 rebalance：信任 LLM 的语义分配，只补全缺失 phaseId，不移动已分配的节点
  return assigned;
}

export function buildStageChecklist(store) {
  const stage = normalizeStageName(store.currentStage || {});
  const checklistSource = Array.isArray(stage.checklist) && stage.checklist.length
    ? stage.checklist
    : defaultStageChecklist;
  const tasks = store.tasks || [];
  const activities = store.activities || [];
  const reviews = store.reviews || [];
  const assignments = store.assignments || [];
  const overrides = store.checklistOverrides || {};
  const checklist = checklistSource.map((item) => {
    const scored = scoreChecklistItem(item, tasks, activities, reviews, assignments, store);
    const ov = overrides[item.id];
    if (!ov) return scored;
    const ovProgress = ov.status === '已完成' ? 100 : scored.progress;
    return {
      ...scored,
      status: ov.status,
      progress: ovProgress,
      gaps: ov.status === '已完成' ? [] : scored.gaps,
      manualOverride: true,
      overriddenBy: ov.by,
      overriddenAt: ov.at
    };
  });
  const checklistProgress = checklist.length
    ? Math.round(checklist.reduce((sum, item) => sum + item.progress, 0) / checklist.length)
    : 0;
  const storedProgress = Number.isFinite(Number(stage.progress)) ? Math.round(Number(stage.progress)) : checklistProgress;
  const progress = Math.max(0, Math.min(100, Math.max(checklistProgress, storedProgress)));
  const blockedCount = checklist.filter((item) => item.status === '阻塞' || item.status === '高风险').length;
  const taskBlockedCount = tasks.filter((t) => t.blocked === true && t.status !== 'completed').length;
  const missingEvidenceCount = checklist.filter((item) => item.gaps.length > 0).length;

  const rawPhases = Array.isArray(stage.phases) && stage.phases.length ? stage.phases : defaultPhases;

  const phases = rawPhases.map((phase) => {
    const nodes = checklist.filter((item) => item.phaseId === phase.id);
    if (!nodes.length) return { ...phase };
    const allDone = nodes.every((n) => n.status === '已完成');
    const anyBlocked = nodes.some((n) => n.status === '阻塞');
    const anyRisk = nodes.some((n) => n.status === '高风险');
    const anyActive = nodes.some((n) => n.status === '推进中');
    const derivedStatus = allDone ? '已完成' : anyBlocked ? '阻塞' : anyRisk ? '高风险' : anyActive ? '进行中' : phase.status || '待开始';
    const phaseProgress = Math.round(nodes.reduce((s, n) => s + n.progress, 0) / nodes.length);
    return { ...phase, status: derivedStatus, progress: phaseProgress, nodeCount: nodes.length };
  });

  return {
    stage: {
      id: stage.id || defaultCurrentStage.id,
      name: stage.name || defaultCurrentStage.name,
      shortName: stage.shortName || defaultCurrentStage.shortName,
      targetDate: stage.targetDate || defaultCurrentStage.targetDate,
      status: stage.status || defaultCurrentStage.status,
      progress
    },
    phases,
    checklist,
    metrics: {
      total: checklist.length,
      done: checklist.filter((item) => item.status === '已完成').length,
      inProgress: checklist.filter((item) => item.status === '推进中').length,
      blocked: blockedCount,
      taskBlocked: taskBlockedCount,
      missingEvidence: missingEvidenceCount
    }
  };
}

export function aggregateDeliverableProgress(store) {
  const rawDeliverables = Array.isArray(store.deliverables) && store.deliverables.length
    ? store.deliverables
    : [];
  // 若 deliverables 为空（如 reset 后未 sync-docs），直接返回空——不再回退到默认 checklist，
  // 避免幽灵节点污染路径图（前端会展示"暂无交付项"空态）
  const deliverableSource = rawDeliverables;
  const tasks = store.tasks || [];
  const activities = store.activities || [];
  const reviews = store.reviews || [];
  const assignments = store.assignments || [];
  const overrides = store.checklistOverrides || {};

  const deliverables = deliverableSource.map((deliverable) => {
    const scored = scoreChecklistItem({
      id: deliverable.id,
      phaseId: deliverable.phaseId,
      title: deliverable.title,
      owner: deliverable.owner,
      taskIds: deliverable.taskIds || [],
      keywords: deliverable.keywords || [],
      acceptance: deliverable.acceptance || ''
    }, tasks, activities, reviews, assignments, store);
    const manual = deliverable.manualOverride || overrides[deliverable.id] || null;
    const status = manual?.status || scored.status || deliverable.status || '待补证据';
    const progress = manual?.status === '已完成'
      ? 100
      : Math.max(clampProgress(deliverable.progress), clampProgress(scored.progress));
    return {
      ...deliverable,
      status,
      progress,
      evidence: scored.evidence,
      gaps: manual?.status === '已完成' ? [] : scored.gaps,
      linkedTasks: scored.linkedTasks,
      linkMode: scored.linkMode,
      binding: scored.binding,
      manualOverride: manual
        ? { status: manual.status, by: manual.by, at: manual.at }
        : null
    };
  });

  const rawPhases = Array.isArray(store.phases) && store.phases.length
    ? store.phases
    : (store.currentStage?.phases?.length ? store.currentStage.phases : defaultPhases);
  const phases = rawPhases.map((phase) => {
    const nodes = deliverables.filter((item) => item.phaseId === phase.id);
    if (!nodes.length) return { ...phase, progress: clampProgress(phase.progress), deliverableCount: 0 };
    const allDone = nodes.every((item) => item.status === '已完成');
    const anyBlocked = nodes.some((item) => item.status === '阻塞');
    const anyRisk = nodes.some((item) => item.status === '高风险');
    const anyActive = nodes.some((item) => item.status === '推进中');
    return {
      ...phase,
      status: allDone ? '已完成' : anyBlocked ? '阻塞' : anyRisk ? '高风险' : anyActive ? '进行中' : phase.status || '待开始',
      progress: Math.round(nodes.reduce((sum, item) => sum + clampProgress(item.progress), 0) / nodes.length),
      deliverableCount: nodes.length
    };
  });

  const progress = deliverables.length
    ? Math.round(deliverables.reduce((sum, item) => sum + clampProgress(item.progress), 0) / deliverables.length)
    : 0;

  return {
    phases,
    deliverables,
    metrics: {
      total: deliverables.length,
      done: deliverables.filter((item) => item.status === '已完成').length,
      inProgress: deliverables.filter((item) => item.status === '推进中').length,
      blocked: deliverables.filter((item) => item.status === '阻塞' || item.status === '高风险').length,
      missingEvidence: deliverables.filter((item) => (item.gaps || []).length > 0).length,
      progress
    }
  };
}

/**
 * E1/E3 里程碑进度指标（SPEC-L2 data-models.md Milestone interface）。
 * 从 store.tasks 动态计算，不依赖 store.milestones 静态列表。
 * @returns {Object} milestoneId → { completionPct, e1CompletedCount, blockedCount, total, done }
 */
export function buildMilestoneMetrics(store) {
  const tasks = store.tasks || [];
  const byMilestone = {};

  for (const task of tasks) {
    const mid = task.milestoneId || '__none__';
    if (!byMilestone[mid]) {
      byMilestone[mid] = { total: 0, done: 0, blocked: 0 };
    }
    const bucket = byMilestone[mid];
    bucket.total++;
    if (task.status === 'completed') bucket.done++;
    if (task.blocked === true && task.status !== 'completed') bucket.blocked++;
  }

  const result = {};
  for (const [mid, counts] of Object.entries(byMilestone)) {
    if (mid === '__none__') continue;
    result[mid] = {
      completionPct: counts.total ? Math.round((counts.done / counts.total) * 100) : 0,
      e1CompletedCount: 0,  // populated when E1 sets task.completedBy = 'e1' in future
      blockedCount: counts.blocked,
      total: counts.total,
      done: counts.done,
    };
  }
  return result;
}
