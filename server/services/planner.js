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

export function generatePlan(goal, existingMembers = []) {
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
