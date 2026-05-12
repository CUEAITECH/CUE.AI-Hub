import { callClaude, parseJsonOutput } from './claude.js';

export const ASSIGNMENT_BRIEF_TEMPLATE = {
  objective: '一句话说明这次认领要交付什么结果。',
  context: '说明它属于哪个阶段、为什么现在要做、依赖哪些上下游。',
  scope: ['本次必须完成的范围', '明确不在本次处理的范围'],
  steps: ['可在一天内推进的步骤 1', '步骤 2', '步骤 3'],
  acceptanceCriteria: ['可验证的验收标准 1', '验收标准 2', '验收标准 3'],
  deliverables: ['需要提交或沉淀的产物，例如 PR、文档、接口、截图、测试记录'],
  gitEvidence: 'commit / PR 标题需要如何关联任务，哪些文件或分支可以作为证据。',
  riskCheck: ['需要提前确认的风险', '遇到阻塞时升级给谁'],
  communication: '晚会或企业微信里应该同步的最小信息。',
  estimate: '建议工作量，例如 0.5 天 / 1 天。',
  nextCheck: '下一次检查时间和检查口径。'
};

function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return fallback;
}

function normalizeBrief(raw, fallback) {
  const source = raw?.taskBrief || raw || {};
  const acceptanceCriteria = asArray(source.acceptanceCriteria, fallback.acceptanceCriteria)
    .filter((item) => !isPlaceholderAcceptance(item));
  return {
    objective: String(source.objective || fallback.objective),
    context: String(source.context || fallback.context),
    scope: asArray(source.scope, fallback.scope),
    steps: asArray(source.steps, fallback.steps),
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : fallback.acceptanceCriteria,
    deliverables: asArray(source.deliverables, fallback.deliverables),
    gitEvidence: String(source.gitEvidence || fallback.gitEvidence),
    riskCheck: asArray(source.riskCheck, fallback.riskCheck),
    communication: String(source.communication || fallback.communication),
    estimate: String(source.estimate || fallback.estimate),
    nextCheck: String(source.nextCheck || fallback.nextCheck),
    templateVersion: 'assignment-brief-v1'
  };
}

function isPlaceholderAcceptance(value) {
  return !String(value || '').trim() || /待补充|未定|todo/i.test(String(value || ''));
}

function resolveTaskAcceptance(task, store) {
  if (!isPlaceholderAcceptance(task?.acceptance)) return String(task.acceptance).trim();
  const deliverable = (store?.deliverables || []).find((item) => item.id && item.id === task?.deliverableId);
  if (!isPlaceholderAcceptance(deliverable?.acceptance)) return String(deliverable.acceptance).trim();
  if (!isPlaceholderAcceptance(task?.description)) return String(task.description).trim();
  return '完成后需要能被负责人验收。';
}

function buildFallbackBrief({ task, owner, note, stage, project, store }) {
  const title = task?.title || '未命名任务';
  const acceptance = resolveTaskAcceptance(task, store);
  const due = task?.due || task?.dueDate || '今日晚会前';
  const projectName = project?.name || project?.githubFullRepo || 'Cue.AI';
  const context = `${projectName} 当前阶段：${stage?.name || 'Cue.AI 双设备课堂 MVP / TRTC 联调阶段'}。${task?.sourceDoc ? `任务来自 ${task.sourceDoc}。` : ''}`;

  return normalizeBrief(null, {
    objective: `${owner} 在 ${due} 前推进「${title}」，交付可验证的阶段结果。`,
    context,
    scope: [
      note || task?.description || `围绕「${title}」完成最小可验收实现。`,
      '不扩展无关重构，不把非必要体验优化混入本次认领。'
    ],
    steps: [
      '确认当前代码、文档和接口状态，列出缺口。',
      '完成最小实现或文档产物，并保持任务标题、commit、PR 关联。',
      '自测关键路径，记录结果和仍然阻塞的问题。',
      '晚会前回写进度、风险和下一步建议。'
    ],
    acceptanceCriteria: [
      acceptance,
      '有 commit、PR、截图、接口返回或文档链接中的至少一种证据。',
      '能说明已完成、未完成和阻塞项，便于晚会重新分配。'
    ],
    deliverables: ['关联任务的 commit / PR', '必要的测试或联调记录', '晚会可复盘的进度说明'],
    gitEvidence: `commit 或 PR 标题建议包含任务关键词「${title}」，说明变更文件和验收方式。`,
    riskCheck: ['如果超过半天没有可验证进展，拆成更小任务或转派。', '涉及密钥、权限、支付、登录或生产配置时必须进入 AI Review。'],
    communication: '企业微信同步：已做什么、还差什么、是否需要他人配合。',
    estimate: Number(task?.progress) < 30 ? '1 天，建议拆成上午/下午两个检查点。' : '0.5-1 天。',
    nextCheck: '今日 18:00 晚会前检查 Git 证据和验收标准。'
  });
}

export async function generateAssignmentBrief({ task, owner, note, store }) {
  const projectId = task?.projectId || (store.projects || [])[0]?.id || 'cue_ai_classroom';
  const project = (store.projects || []).find((item) => item.id === projectId)
    || (store.projects || [])[0]
    || null;
  const stage = store.currentStage || {};
  const acceptance = resolveTaskAcceptance(task, store);
  const fallback = buildFallbackBrief({ task, owner, note, stage, project, store });

  const systemPrompt = [
    '你是 CUE 项目中枢的 AI 项目经理。',
    '你的任务是在成员领取任务时，按模板生成一天内可执行、可验收、可对账的任务细则。',
    '必须输出严格 JSON，不要输出 Markdown，不要添加解释。',
    '任务必须足够具体，避免一次性塞入过大的范围。'
  ].join('\n');

  const userPrompt = JSON.stringify({
    outputSchema: { taskBrief: ASSIGNMENT_BRIEF_TEMPLATE },
    project: {
      id: project?.id || projectId,
      name: project?.name || 'Cue.AI',
      repo: project?.githubFullRepo || project?.repository || ''
    },
    stage: {
      name: stage?.name || 'Cue.AI 双设备课堂 MVP / TRTC 联调阶段',
      progress: stage?.progress ?? 0,
      summary: stage?.summary || ''
    },
    assignment: { owner, note },
    task: {
      id: task?.id || '',
      title: task?.title || '',
      owner: task?.owner || '',
      status: task?.status || '',
      risk: task?.risk || '',
      progress: task?.progress ?? 0,
      due: task?.due || task?.dueDate || '',
      description: task?.description || '',
      acceptance,
      sourceDoc: task?.sourceDoc || '',
      linkedRefs: task?.linkedRefs || []
    }
  }, null, 2);

  const text = await callClaude(systemPrompt, userPrompt);
  const parsed = parseJsonOutput(text);
  const brief = normalizeBrief(parsed, fallback);
  return {
    ...brief,
    generatedBy: parsed ? 'claude' : 'rule-fallback'
  };
}
