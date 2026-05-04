export const defaultCurrentStage = {
  id: 'stage_cue_ai_trtc_mvp',
  name: 'Cue.AI 双设备课堂 MVP / TRTC 联调阶段',
  targetDate: '2026-05-15',
  progress: 0,
  status: '进行中',
  updatedAt: ''
};

export const defaultStageChecklist = [
  {
    id: 'stage_trtc_full_loop',
    title: 'TRTC 全链路联调',
    owner: '全员',
    taskIds: [],
    keywords: ['trtc', '全链路', '联调', '课堂', 'session', 'summary', 'sos', 'asr'],
    acceptance: '跑通老师开课、学生加入、ASR 转写、SOP 推进、SOS 触发和 summary 生成的完整课堂链路。'
  },
  {
    id: 'stage_backend_realtime',
    title: '后端实时课堂链路',
    owner: '后端/架构',
    taskIds: [],
    keywords: ['后端', 'session', 'usersig', 'asr', 'callback', '机器人', 'sop', 'sos', 'summary', '接口'],
    acceptance: '完成课堂 Session、UserSig、TRTC ASR 机器人、回调处理、SOP 推进、SOS 和课后总结的后端闭环。'
  },
  {
    id: 'stage_ipad_teacher',
    title: 'iPad 老师端开课',
    owner: 'iOS',
    taskIds: [],
    keywords: ['ipad', 'ios', '老师', '教师', 'txliteavsdk', 'trtc ios', '开课', '音频', '设备绑定'],
    acceptance: 'iPad 老师端能登录、选择课程模块、创建课堂、进入 TRTC 房间并持续采集课堂音频。'
  },
  {
    id: 'stage_student_teacher_clients',
    title: '学生/教师端加入与提示',
    owner: 'Web / iPhone',
    taskIds: [],
    keywords: ['web', 'join', '学生', 'iphone', '教师', '连接', '配对', 'sop节点', '下一环节', '课后总结'],
    acceptance: '学生 Web 端可用房间码加入课堂，教师移动端可查看连接状态、SOP 进度、SOS 结果和课后总结。'
  },
  {
    id: 'stage_content_demo_acceptance',
    title: '内容 SOP 与 Demo 验收',
    owner: '产品/内容',
    taskIds: [],
    keywords: ['数学', '内容', 'sop', '关键词', '话术', '模板', '验收', 'demo', '八步', '闭环'],
    acceptance: '准备一门课的 SOP 内容包、关键词、SOS 话术和演示验收脚本，用于完整 Demo 验收。'
  }
];

function textIncludesAny(text, keywords = []) {
  const normalized = String(text || '').toLowerCase();
  return keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

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

function scoreChecklistItem(item, tasks, activities, reviews, assignments, store) {
  const semantic = semanticLinksForStage(store, item.id);
  const linkedTasks = tasks.filter((task) => (
    semantic.taskIds.has(task.id)
    || (item.taskIds || []).includes(task.id)
    || textIncludesAny(`${task.title} ${task.acceptance} ${task.signal}`, item.keywords)
  ));
  const evidenceText = [
    item.title,
    item.acceptance,
    linkedTasks.map((task) => `${task.id} ${task.title}`).join(' ')
  ].join(' ');
  const linkedActivities = uniqueById(activities.filter((activity) => (
    activity.type === 'commit'
    && (
      semantic.activityIds.has(activity.id)
      || textIncludesAny(`${activity.title} ${(activity.files || []).join(' ')}`, item.keywords)
      || linkedTasks.some((task) => textIncludesAny(`${activity.title} ${(activity.files || []).join(' ')}`, [task.id, task.title]))
      || semantic.commitTaskLinks.some((link) => link.activityId === activity.id && linkedTasks.some((task) => task.id === link.taskId))
      || textIncludesAny(evidenceText, [activity.title])
    )
  )));
  const linkedReviews = uniqueById(reviews.filter((review) => (
    linkedActivities.some((activity) => review.activityId === activity.id || review.id === `review_${activity.sha}`)
    || linkedTasks.some((task) => textIncludesAny(`${review.title} ${(review.findings || []).join(' ')}`, [task.id, task.title]))
  )));
  const linkedAssignments = assignments.filter((assignment) => (
    linkedTasks.some((task) => task.id === assignment.taskId)
    || textIncludesAny(`${assignment.taskTitle} ${assignment.note}`, item.keywords)
  ));

  const taskProgress = linkedTasks.length
    ? Math.round(linkedTasks.reduce((sum, task) => sum + (Number(task.progress) || 0), 0) / linkedTasks.length)
    : 0;
  const hasBlockReview = linkedReviews.some((review) => review.level === 'Block' || review.level === 'Escalate');
  const hasEvidence = linkedActivities.length > 0 || linkedAssignments.length > 0 || linkedReviews.length > 0;
  const progress = Math.max(taskProgress, hasEvidence ? 35 : 0);
  const status = hasBlockReview
    ? '阻塞'
    : linkedTasks.some((task) => task.status === '高风险' || task.risk === '高')
    ? '高风险'
    : progress >= 100
    ? '已完成'
    : progress >= 60 || linkedActivities.length
    ? '推进中'
    : '待补证据';

  const gaps = [];
  if (!linkedTasks.length) gaps.push('缺少关联任务');
  if (!linkedActivities.length) gaps.push('缺少 Git 提交证据');
  if (!linkedAssignments.length) gaps.push('晚会未领取或未登记');
  if (hasBlockReview) gaps.push('存在阻断 Review');

  const taskReasons = linkReasonMap((store.semanticLinks || {}).taskStageLinks);
  const activityReasons = linkReasonMap((store.semanticLinks || {}).commitStageLinks);

  return {
    ...item,
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
    linkMode: (semantic.taskIds.size || semantic.activityIds.size) ? 'hybrid' : 'rules'
  };
}

export function buildStageChecklist(store) {
  const stage = store.currentStage || {};
  const checklistSource = Array.isArray(stage.checklist) && stage.checklist.length
    ? stage.checklist
    : defaultStageChecklist;
  const tasks = store.tasks || [];
  const activities = store.activities || [];
  const reviews = store.reviews || [];
  const assignments = store.assignments || [];
  const checklist = checklistSource.map((item) => scoreChecklistItem(item, tasks, activities, reviews, assignments, store));
  const progress = checklist.length
    ? Math.round(checklist.reduce((sum, item) => sum + item.progress, 0) / checklist.length)
    : 0;
  const blockedCount = checklist.filter((item) => item.status === '阻塞' || item.status === '高风险').length;
  const missingEvidenceCount = checklist.filter((item) => item.gaps.length > 0).length;

  return {
    stage: {
      id: stage.id || defaultCurrentStage.id,
      name: stage.name || defaultCurrentStage.name,
      targetDate: stage.targetDate || defaultCurrentStage.targetDate,
      status: stage.status || defaultCurrentStage.status,
      progress
    },
    checklist,
    metrics: {
      total: checklist.length,
      done: checklist.filter((item) => item.status === '已完成').length,
      inProgress: checklist.filter((item) => item.status === '推进中').length,
      blocked: blockedCount,
      missingEvidence: missingEvidenceCount
    }
  };
}
