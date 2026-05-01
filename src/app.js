const state = {
  tasks: [],
  members: [],
  reviews: [],
  alerts: [],
  projects: [],
  activities: [],
  metrics: {},
  plannedTasks: []
};

const fallbackRules = [
  '任务临近截止但 12 小时无 commit 或 PR，先私聊负责人提醒。',
  'PR 超过 12 小时无人 review，自动指派 reviewer 并提醒技术负责人。',
  '提交内容和任务描述不匹配，标记为“提醒”并要求补充说明。',
  '核心模块变更且测试缺失，AI Review 标记为“阻断”，禁止合并。',
  '阶段目标落后时，自动建议降级、拆分或转派任务。',
  '站会未回复、请假未交接时，先提醒本人，再升级到管理者日报。'
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function getReviewLevelLabel(level) {
  if (level === 'Pass') return '通过';
  if (level === 'Warning') return '提醒';
  if (level === 'Block') return '阻断';
  if (level === 'Escalate') return '升级';
  return level || '未知';
}

function renderMetrics() {
  const metrics = state.metrics || {};
  setText('#healthScore', metrics.healthScore ?? 0);
  setText('#healthSummary', `高风险任务 ${metrics.highRiskTasks ?? 0} 个 · 待审阅提交 ${metrics.pendingReviews ?? 0} 个 · 紧急提醒 ${metrics.urgentAlerts ?? 0} 个`);
  setText('#metricHighRisk', metrics.highRiskTasks ?? 0);
  setText('#metricUrgentAlerts', `${metrics.urgentAlerts ?? 0} 个需要管理者处理`);
  setText('#metricCommits', metrics.commitsToday ?? 0);
  setText('#metricReviews', metrics.pendingReviews ?? 0);
  setText('#metricStandup', metrics.standupResponseRate || '0%');
}

function renderTasks() {
  const table = document.querySelector('#taskTable');
  if (!state.tasks.length) {
    table.innerHTML = '<div class="empty-state">暂无任务。可以从 AI 排期生成任务，或手动新增。</div>';
    return;
  }

  table.innerHTML = state.tasks.map((task) => `
    <div class="task-row">
      <div>
        <strong>${escapeHtml(task.title)}</strong>
        <span>${escapeHtml(task.signal)}</span>
      </div>
      <span>${escapeHtml(task.owner)}</span>
      <span class="risk-badge risk-${escapeHtml(task.risk)}">${escapeHtml(task.risk)}</span>
      <span>${escapeHtml(task.due || '未设置')}</span>
      <div class="progress" aria-label="${escapeHtml(task.title)} 进度 ${Number(task.progress) || 0}%">
        <i style="width: ${Number(task.progress) || 0}%"></i>
      </div>
    </div>
  `).join('');
}

function renderCueAiProject() {
  const panel = document.querySelector('#cueAiProject');
  const project = state.projects.find((item) => item.id === 'cue_ai_classroom');

  if (!project) {
    panel.innerHTML = '<div class="empty-state">尚未配置 Cue.AI 内部项目。</div>';
    return;
  }

  panel.innerHTML = `
    <div class="project-card">
      <div>
        <strong>${escapeHtml(project.name)}</strong>
        <span>${escapeHtml(project.summary)}</span>
      </div>
      <dl>
        <div><dt>仓库</dt><dd>${escapeHtml(project.repository)}</dd></div>
        <div><dt>分支</dt><dd>${escapeHtml(project.branch || '待同步')}</dd></div>
        <div><dt>状态</dt><dd>${escapeHtml(project.status || '待同步')}</dd></div>
        <div><dt>未提交文件</dt><dd>${Number(project.dirtyFileCount) || 0}</dd></div>
      </dl>
      <small>${project.lastSyncAt ? `上次同步 ${new Date(project.lastSyncAt).toLocaleString('zh-CN', { hour12: false })}` : '还没有同步过本地 Git'}</small>
    </div>
  `;
}

function renderActivities() {
  const list = document.querySelector('#activityList');
  const projectActivities = state.activities
    .filter((activity) => activity.projectId === 'cue_ai_classroom')
    .slice(0, 8);

  if (!projectActivities.length) {
    list.innerHTML = '<div class="empty-state">点击“同步 Cue.AI Git”后，这里会展示最近 commit 和工作区改动。</div>';
    return;
  }

  list.innerHTML = projectActivities.map((activity) => `
    <div class="activity-item activity-${escapeHtml(activity.type)}">
      <b>${activity.type === 'commit' ? escapeHtml(activity.shortSha || 'commit') : '未提交'}</b>
      <div>
        <strong>${escapeHtml(activity.title)}</strong>
        <span>${escapeHtml(activity.owner || activity.actor)} · ${escapeHtml(activity.files?.slice(0, 3).join('、') || '无文件列表')}</span>
      </div>
      <small>${activity.createdAt ? new Date(activity.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''}</small>
    </div>
  `).join('');
}

function renderRisks() {
  const list = document.querySelector('#riskList');
  if (!state.alerts.length) {
    list.innerHTML = '<div class="empty-state">当前没有需要升级的风险。</div>';
    return;
  }

  list.innerHTML = state.alerts.map((alert) => `
    <div class="risk-item risk-${escapeHtml(alert.severity)}">
      <b>${escapeHtml(alert.severity)}</b>
      <div>
        <strong>${escapeHtml(alert.title)}</strong>
        <p>${escapeHtml(alert.detail)}</p>
        <small>提醒对象：${escapeHtml(alert.target)}</small>
      </div>
    </div>
  `).join('');
}

function renderMembers() {
  const list = document.querySelector('#memberList');
  list.innerHTML = state.members.map((member) => `
    <div class="member-item">
      <div>
        <strong>${escapeHtml(member.name)}</strong>
        <span>${escapeHtml(member.role)} · ${escapeHtml(member.focus)}</span>
      </div>
      <small>响应 ${escapeHtml(member.response)}</small>
      <div class="progress"><i style="width: ${Number(member.load) || 0}%"></i></div>
    </div>
  `).join('');
}

function renderReviews() {
  const list = document.querySelector('#reviewList');
  if (!state.reviews.length) {
    list.innerHTML = '<div class="empty-state">暂无 AI Review 记录。</div>';
    return;
  }

  list.innerHTML = state.reviews.map((review) => `
    <div class="review-item review-${escapeHtml(String(review.level).toLowerCase())}">
      <div>
        <strong>${escapeHtml(review.title)}</strong>
        <span>${escapeHtml(review.repo)} · ${escapeHtml(review.owner)} · ${escapeHtml((review.findings || []).join('；'))}</span>
      </div>
      <b>${Number(review.score) || 0}</b>
      <em>${escapeHtml(getReviewLevelLabel(review.level))}</em>
    </div>
  `).join('');
}

function renderRules() {
  const list = document.querySelector('#ruleList');
  list.innerHTML = fallbackRules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('');
}

function renderPlan() {
  const grid = document.querySelector('#planGrid');
  if (!state.plannedTasks.length) {
    grid.innerHTML = '<div class="empty-state">输入阶段目标后点击“生成任务”。</div>';
    return;
  }

  grid.innerHTML = state.plannedTasks.map((task, index) => `
    <article class="plan-card">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <h3>${escapeHtml(task.title)}</h3>
      <p>${escapeHtml(task.acceptance)}</p>
      <small>负责人 ${escapeHtml(task.owner)} · 截止 ${escapeHtml(task.due)} · ${escapeHtml(task.priority)}</small>
    </article>
  `).join('');
}

function renderAll() {
  renderMetrics();
  renderCueAiProject();
  renderActivities();
  renderTasks();
  renderRisks();
  renderMembers();
  renderReviews();
  renderRules();
  renderPlan();
}

async function loadState() {
  const payload = await api('/api/state');
  state.tasks = payload.tasks || [];
  state.members = payload.members || [];
  state.reviews = payload.reviews || [];
  state.alerts = payload.alerts || [];
  state.projects = payload.projects || [];
  state.activities = payload.activities || [];
  state.metrics = payload.metrics || {};
  setText('#syncStatus', '本地 API 已连接');
  renderAll();
}

async function generatePlan() {
  const goal = document.querySelector('#stageGoal').value;
  const payload = await api('/api/plans', {
    method: 'POST',
    body: JSON.stringify({ goal })
  });
  state.plannedTasks = payload.tasks || [];
  renderPlan();
  toast('已根据阶段目标生成任务草案');
}

async function applyPlan() {
  if (!state.plannedTasks.length) {
    await generatePlan();
  }

  const payload = await api('/api/plans/apply', {
    method: 'POST',
    body: JSON.stringify({ tasks: state.plannedTasks })
  });
  state.tasks = payload.tasks || [];
  state.plannedTasks = [];
  await refreshRisks();
  renderAll();
  setRoute('overview');
  toast(`已应用 ${payload.added || 0} 个 AI 任务到任务板`);
}

async function createTaskFromPrompt() {
  const title = window.prompt('任务标题');
  if (!title) return;
  const owner = window.prompt('负责人', '未分配') || '未分配';
  const due = window.prompt('截止日期，例如 2026-05-05', new Date().toISOString().slice(0, 10)) || '';

  const payload = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title,
      owner,
      due,
      status: '待确认',
      risk: '低',
      progress: 0,
      signal: '手动创建，等待 Git 信号',
      acceptance: '待补充验收标准'
    })
  });
  state.tasks = payload.tasks || [];
  await refreshRisks();
  renderAll();
  toast('任务已创建');
}

async function runReview() {
  const title = document.querySelector('#reviewTitle').value;
  const diff = document.querySelector('#reviewDiff').value;
  const payload = await api('/api/reviews', {
    method: 'POST',
    body: JSON.stringify({
      repo: 'cue-project-hub',
      title,
      owner: 'AI Reviewer',
      diff,
      files: ['server/index.js', 'src/app.js']
    })
  });
  state.reviews = payload.reviews || [];
  await refreshRisks();
  renderAll();
  toast(`AI Review 完成：${payload.review.level} · ${payload.review.score}`);
}

async function refreshRisks() {
  const payload = await api('/api/risks/scan', { method: 'POST', body: '{}' });
  state.alerts = payload.alerts || [];
  state.metrics = payload.metrics || state.metrics;
}

async function syncSignals() {
  await refreshRisks();
  renderAll();
  setText('#syncStatus', `已扫描风险 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  toast('已同步本地任务、审阅和风险信号');
}

async function syncCueAiGit() {
  setText('#syncStatus', '正在同步 Cue.AI Git...');
  const payload = await api('/api/projects/cue_ai_classroom/sync-local-git', {
    method: 'POST',
    body: '{}'
  });
  const nextState = await api('/api/state');
  state.tasks = nextState.tasks || [];
  state.members = nextState.members || [];
  state.reviews = nextState.reviews || [];
  state.alerts = payload.alerts || nextState.alerts || [];
  state.projects = nextState.projects || [];
  state.activities = nextState.activities || [];
  state.metrics = payload.metrics || nextState.metrics || {};
  renderAll();
  setText('#syncStatus', `Cue.AI 已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  toast(`Cue.AI 同步完成：${payload.addedActivities || 0} 条活动，${payload.addedReviews || 0} 条 AI Review`);
}

function setRoute(route) {
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === route);
  });
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === route);
  });
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), 2200);
}

function bindEvents() {
  document.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => setRoute(button.dataset.route));
  });

  document.querySelector('[data-action="generate-plan"]').addEventListener('click', () => {
    generatePlan().catch((error) => toast(error.message));
  });

  document.querySelector('[data-action="apply-plan"]').addEventListener('click', () => {
    applyPlan().catch((error) => toast(error.message));
  });

  document.querySelector('[data-action="sync"]').addEventListener('click', () => {
    syncCueAiGit().catch((error) => toast(error.message));
  });

  document.querySelector('[data-action="sync-cue-ai"]').addEventListener('click', () => {
    syncCueAiGit().catch((error) => toast(error.message));
  });

  document.querySelector('[data-action="scan-risks"]').addEventListener('click', () => {
    syncSignals().catch((error) => toast(error.message));
  });

  document.querySelector('[data-action="run-review"]').addEventListener('click', () => {
    runReview().catch((error) => toast(error.message));
  });

  document.querySelector('[data-action="add-task"]').addEventListener('click', () => {
    createTaskFromPrompt().catch((error) => toast(error.message));
  });

  document.querySelector('[data-action="test-alert"]').addEventListener('click', () => {
    syncSignals().then(() => toast('已测试提醒规则，风险队列已刷新')).catch((error) => toast(error.message));
  });
}

bindEvents();
renderRules();
loadState().catch((error) => {
  setText('#syncStatus', '本地 API 未启动');
  toast(`请先运行 npm run dev：${error.message}`);
});
