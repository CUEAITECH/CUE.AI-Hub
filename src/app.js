const state = {
  tasks: [],
  members: [],
  reviews: [],
  alerts: [],
  projects: [],
  activities: [],
  metrics: {},
  plannedTasks: [],
  standups: [],
  standupSummary: '',
  report: '',
  eveningReport: '',
  compareReport: '',
  assignments: [],
  planAdjustments: [],
  config: { wecomEnabled: false, llmEnabled: false }
};

const fallbackRules = [
  '任务临近截止但 12 小时无 commit 或 PR，先私聊负责人提醒。',
  'PR 超过 12 小时无人 review，自动指派 reviewer 并提醒技术负责人。',
  '提交内容和任务描述不匹配，标记为"提醒"并要求补充说明。',
  '核心模块变更且测试缺失，AI Review 标记为"阻断"，禁止合并。',
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

// 简单 Markdown → HTML 转换（粗体、标题、列表）
function mdToHtml(text) {
  if (!text) return '';
  return escapeHtml(text)
    .replace(/^#{1,3} (.+)$/gm, (_, t) => `<strong>${t}</strong>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
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

// ── 渲染函数 ─────────────────────────────────────────────────

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
      <button class="icon-btn edit-btn" data-task-id="${escapeHtml(task.id)}" aria-label="编辑任务">✏️</button>
    </div>
  `).join('');

  // 绑定编辑按钮
  table.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openTaskModal(btn.dataset.taskId));
  });
}

function renderCueAiProject() {
  const panel = document.querySelector('#cueAiProject');
  const project = state.projects.find((item) => item.id === 'cue_ai_classroom');

  if (!project) {
    panel.innerHTML = '<div class="empty-state">尚未配置 Cue.AI 内部项目。</div>';
    return;
  }

  const githubUrl = project.githubFullRepo
    ? `https://github.com/${project.githubFullRepo}`
    : null;
  const sourceLabel = project.githubOwner ? '🔗 GitHub 远端' : '💾 本地 Git';

  panel.innerHTML = `
    <div class="project-card">
      <div>
        <strong>${escapeHtml(project.name)}</strong>
        <span>${escapeHtml(project.summary)}</span>
      </div>
      <dl>
        <div><dt>来源</dt><dd>${sourceLabel}</dd></div>
        <div><dt>仓库</dt><dd>${githubUrl
          ? `<a href="${escapeHtml(githubUrl)}" target="_blank" rel="noopener" class="repo-link">${escapeHtml(project.githubFullRepo)}</a>`
          : escapeHtml(project.repository)}</dd></div>
        <div><dt>分支</dt><dd>${escapeHtml(project.branch || '待同步')}</dd></div>
        <div><dt>状态</dt><dd>${escapeHtml(project.status || '待同步')}</dd></div>
        <div><dt>近期 commits</dt><dd>${Number(project.commitCount) || 0}</dd></div>
      </dl>
      <small>${project.lastSyncAt ? `上次同步 ${new Date(project.lastSyncAt).toLocaleString('zh-CN', { hour12: false })}` : '还没有同步过，点击"同步 Cue.AI Git"拉取远端数据'}</small>
    </div>
  `;
}

function renderActivities() {
  const list = document.querySelector('#activityList');
  const projectActivities = state.activities
    .filter((activity) => activity.projectId === 'cue_ai_classroom')
    .slice(0, 8);

  if (!projectActivities.length) {
    list.innerHTML = '<div class="empty-state">点击"同步 Cue.AI Git"后，这里会展示最近 commit 和工作区改动。</div>';
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
        ${review.suggestion ? `<p class="review-suggestion">${escapeHtml(review.suggestion)}</p>` : ''}
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
    grid.innerHTML = '<div class="empty-state">输入阶段目标后点击"生成任务"。</div>';
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

function renderStandup() {
  const today = new Date().toISOString().slice(0, 10);
  setText('#standupDate', today);
  setText('#standupCount', `${state.standups.length} 人`);

  // 填充成员下拉框
  const ownerSelect = document.querySelector('#standupOwner');
  const currentOwner = ownerSelect.value;
  ownerSelect.innerHTML = '<option value="">选择成员</option>' +
    state.members.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === currentOwner ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('');

  // 站会汇总
  const summaryEl = document.querySelector('#standupSummary');
  if (state.standupSummary) {
    summaryEl.innerHTML = mdToHtml(state.standupSummary);
  }

  // 站会记录列表
  const list = document.querySelector('#standupList');
  if (!state.standups.length) {
    list.innerHTML = '<div class="empty-state">今日暂无站会记录。</div>';
    return;
  }

  list.innerHTML = state.standups.map((s) => `
    <div class="standup-item${s.isLeave ? ' standup-leave' : ''}">
      <div class="standup-item-head">
        <strong>${escapeHtml(s.owner)}</strong>
        ${s.isLeave ? `<span class="leave-badge">请假 · 交接人：${escapeHtml(s.proxy || '未指定')}</span>` : ''}
        <small>${s.createdAt ? new Date(s.createdAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</small>
      </div>
      ${!s.isLeave ? `
      <div class="standup-item-body">
        <div><b>昨日</b>${escapeHtml(s.yesterday || '—')}</div>
        <div><b>今日</b>${escapeHtml(s.today || '—')}</div>
        ${s.blockers ? `<div class="standup-blockers"><b>阻塞</b>${escapeHtml(s.blockers)}</div>` : ''}
      </div>` : ''}
    </div>
  `).join('');
}

function renderReport() {
  const el = document.querySelector('#reportContent');
  if (state.report) {
    el.innerHTML = `<div class="report-body">${mdToHtml(state.report)}</div>`;
  }
}

function renderEveningReport() {
  const el = document.querySelector('#reportEveningContent');
  if (!el) return;
  if (state.eveningReport) {
    el.innerHTML = `<div class="report-body">${mdToHtml(state.eveningReport)}</div>`;
  }
}

function renderCompareReport() {
  const el = document.querySelector('#reportCompareContent');
  if (!el) return;
  if (state.compareReport) {
    el.innerHTML = `<div class="report-body">${mdToHtml(state.compareReport)}</div>`;
  }
}

// ── 分工渲染 ────────────────────────────────────────────────────

function renderAssignments() {
  const today = new Date().toISOString().slice(0, 10);
  const dateEl = document.querySelector('#assignmentDate');
  if (dateEl) dateEl.textContent = today;

  // 今日认领情况（按成员分组）
  const summaryEl = document.querySelector('#assignmentSummary');
  if (summaryEl) {
    if (!state.assignments.length) {
      summaryEl.innerHTML = '<div class="empty-state">今日暂无认领记录。</div>';
    } else {
      // 按 owner 分组
      const byOwner = {};
      for (const a of state.assignments) {
        if (!byOwner[a.owner]) byOwner[a.owner] = [];
        byOwner[a.owner].push(a);
      }
      summaryEl.innerHTML = Object.entries(byOwner).map(([owner, items]) => `
        <div class="assign-group">
          <strong class="assign-owner">${escapeHtml(owner)}</strong>
          ${items.map((a) => `
            <div class="assign-item assign-${escapeHtml(a.status || '进行中')}">
              <span class="assign-title">${escapeHtml(a.taskTitle || '未知任务')}</span>
              <span class="assign-status-badge">${escapeHtml(a.status || '进行中')}</span>
              ${a.note ? `<small class="assign-note">${escapeHtml(a.note)}</small>` : ''}
              <div class="assign-actions">
                ${a.status !== '已完成' ? `<button class="assign-done-btn" data-assign-id="${escapeHtml(a.id)}" title="标记完成">✓</button>` : ''}
                <button class="assign-cancel-btn" data-assign-id="${escapeHtml(a.id)}" title="取消认领">✕</button>
              </div>
            </div>
          `).join('')}
        </div>
      `).join('');

      // 绑定按钮
      summaryEl.querySelectorAll('.assign-done-btn').forEach((btn) => {
        btn.addEventListener('click', () => markAssignmentDone(btn.dataset.assignId).catch((e) => toast(e.message)));
      });
      summaryEl.querySelectorAll('.assign-cancel-btn').forEach((btn) => {
        btn.addEventListener('click', () => cancelAssignment(btn.dataset.assignId).catch((e) => toast(e.message)));
      });
    }
  }

  // 可认领任务列表
  const assignableEl = document.querySelector('#assignableList');
  if (assignableEl) {
    const activeTasks = state.tasks.filter((t) => t.status !== '已完成');
    if (!activeTasks.length) {
      assignableEl.innerHTML = '<div class="empty-state">暂无进行中的任务。</div>';
    } else {
      // 统计每个任务已有哪些人认领
      assignableEl.innerHTML = activeTasks.map((task) => {
        const claimants = state.assignments.filter((a) => a.taskId === task.id);
        return `
          <div class="assignable-task-row">
            <div class="assignable-task-info">
              <div class="assignable-task-title">
                <strong>${escapeHtml(task.title)}</strong>
                <span class="risk-badge risk-${escapeHtml(task.risk)}">${escapeHtml(task.risk)}</span>
              </div>
              <div class="assignable-task-meta">
                ${escapeHtml(task.owner)} · 进度 ${Number(task.progress) || 0}% · 截止 ${escapeHtml(task.due || '未设置')}
              </div>
              ${claimants.length ? `<div class="assignable-claimants">已认领：${claimants.map((a) => `<span>${escapeHtml(a.owner)}</span>`).join('')}</div>` : ''}
            </div>
            <button class="claim-btn" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">认领</button>
          </div>
        `;
      }).join('');

      assignableEl.querySelectorAll('.claim-btn').forEach((btn) => {
        btn.addEventListener('click', () =>
          claimTask(btn.dataset.taskId, btn.dataset.taskTitle).catch((e) => toast(e.message))
        );
      });
    }
  }
}

function renderPlanAdjustments() {
  const el = document.querySelector('#planAdjustList');
  if (!el) return;
  if (!state.planAdjustments.length) {
    el.innerHTML = '<div class="empty-state">暂无计划调整建议。GitHub 提交接入后将自动生成。</div>';
    return;
  }
  el.innerHTML = state.planAdjustments.slice(0, 5).map((adj) => `
    <div class="plan-adjust-item">
      <div class="plan-adjust-head">
        <small>${adj.date || ''} · 触发：${escapeHtml((adj.trigger || '').slice(0, 60))}${(adj.trigger || '').length > 60 ? '…' : ''}</small>
      </div>
      <div class="plan-adjust-body">${mdToHtml(adj.suggestion || '')}</div>
    </div>
  `).join('');
}

function renderConfig() {
  const wecomStatus = document.querySelector('#wecomStatus');
  const btnPushRisks = document.querySelector('#btnPushRisks');
  const btnPushReport = document.querySelector('#btnPushReport');
  if (state.config.wecomEnabled) {
    if (wecomStatus) wecomStatus.style.display = '';
    if (btnPushRisks) btnPushRisks.style.display = '';
    if (btnPushReport) btnPushReport.style.display = '';
  }
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
  renderStandup();
  renderReport();
  renderEveningReport();
  renderCompareReport();
  renderAssignments();
  renderPlanAdjustments();
}

// ── 业务逻辑 ─────────────────────────────────────────────────

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

  // 并行加载站会、配置、今日分工、计划调整建议
  const [standupPayload, config, assignPayload, adjustPayload, eveningPayload] = await Promise.all([
    api('/api/standups').catch(() => ({ standups: [] })),
    api('/api/config').catch(() => ({})),
    api('/api/assignments').catch(() => ({ assignments: [] })),
    api('/api/plan-adjustments').catch(() => ({ adjustments: [] })),
    api('/api/reports/evening').catch(() => ({ report: null }))
  ]);

  state.standups = standupPayload.standups || [];
  state.config = config;
  state.assignments = assignPayload.assignments || [];
  state.planAdjustments = adjustPayload.adjustments || [];
  if (eveningPayload.report) state.eveningReport = eveningPayload.report;

  renderAll();
  renderConfig();
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
      title, owner, due,
      status: '待确认', risk: '低', progress: 0,
      signal: '手动创建，等待 Git 信号',
      acceptance: '待补充验收标准'
    })
  });
  state.tasks = payload.tasks || [];
  await refreshRisks();
  renderAll();
  toast('任务已创建');
}

// ── 任务编辑 Modal ────────────────────────────────────────────

function openTaskModal(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  document.querySelector('#editTaskId').value = task.id;
  document.querySelector('#editTitle').value = task.title;
  document.querySelector('#editOwner').value = task.owner;
  document.querySelector('#editDue').value = task.due || '';
  document.querySelector('#editStatus').value = task.status || '待确认';
  document.querySelector('#editRisk').value = task.risk || '低';
  document.querySelector('#editProgress').value = task.progress ?? 0;
  document.querySelector('#editProgressLabel').textContent = task.progress ?? 0;
  document.querySelector('#editAcceptance').value = task.acceptance || '';
  document.querySelector('#editSignal').value = task.signal || '';
  document.querySelector('#taskModalBackdrop').style.display = 'flex';
  document.querySelector('#editTitle').focus();
}

function closeTaskModal() {
  document.querySelector('#taskModalBackdrop').style.display = 'none';
}

async function saveTaskEdit(event) {
  event.preventDefault();
  const id = document.querySelector('#editTaskId').value;
  const payload = await api(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      title: document.querySelector('#editTitle').value,
      owner: document.querySelector('#editOwner').value,
      due: document.querySelector('#editDue').value,
      status: document.querySelector('#editStatus').value,
      risk: document.querySelector('#editRisk').value,
      progress: Number(document.querySelector('#editProgress').value),
      acceptance: document.querySelector('#editAcceptance').value,
      signal: document.querySelector('#editSignal').value
    })
  });
  state.tasks = payload.tasks || [];
  closeTaskModal();
  await refreshRisks();
  renderAll();
  toast('任务已保存');
}

async function deleteTask() {
  const id = document.querySelector('#editTaskId').value;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  if (!window.confirm(`确认删除任务"${task.title}"？`)) return;
  const payload = await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.tasks = payload.tasks || [];
  closeTaskModal();
  await refreshRisks();
  renderAll();
  toast('任务已删除');
}

// ── 站会 ──────────────────────────────────────────────────────

async function submitStandup(event) {
  event.preventDefault();
  const owner = document.querySelector('#standupOwner').value;
  if (!owner) { toast('请选择成员'); return; }

  const isLeave = document.querySelector('#standupIsLeave').checked;
  const payload = await api('/api/standups', {
    method: 'POST',
    body: JSON.stringify({
      owner,
      isLeave,
      proxy: document.querySelector('#standupProxy').value,
      yesterday: document.querySelector('#standupYesterday').value,
      today: document.querySelector('#standupToday').value,
      blockers: document.querySelector('#standupBlockers').value
    })
  });

  // 刷新站会列表
  const listPayload = await api('/api/standups');
  state.standups = listPayload.standups || [];
  document.querySelector('#standupForm').reset();
  renderStandup();
  toast(`${owner} 的站会已提交（今日共 ${payload.count} 人）`);
}

async function summarizeStandup() {
  toast('AI 正在汇总站会...');
  const payload = await api('/api/standups/summarize', { method: 'POST', body: '{}' });
  state.standupSummary = payload.summary || '';
  state.standups = payload.standups || state.standups;
  renderStandup();
  toast('站会汇总完成' + (state.config.wecomEnabled ? '，已推送至企业微信' : ''));
}

// ── 分工认领 ────────────────────────────────────────────────────

async function claimTask(taskId, taskTitle) {
  const memberNames = state.members.map((m) => m.name);
  const ownerPrompt = memberNames.length
    ? `认领人（${memberNames.join(' / ')}）：`
    : '认领人姓名：';
  const owner = window.prompt(ownerPrompt, memberNames[0] || '');
  if (!owner) return;
  const note = window.prompt('今日具体计划说明（可留空）：', '') || '';

  const payload = await api('/api/assignments', {
    method: 'POST',
    body: JSON.stringify({ owner: owner.trim(), taskId, note })
  });
  state.assignments = payload.assignments || state.assignments;
  renderAssignments();
  toast(`${owner} 已认领「${taskTitle}」`);
}

async function markAssignmentDone(id) {
  const payload = await api(`/api/assignments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: '已完成' })
  });
  state.assignments = payload.assignments || state.assignments;
  renderAssignments();
  toast('已标记完成');
}

async function cancelAssignment(id) {
  if (!window.confirm('确认取消认领？')) return;
  const payload = await api(`/api/assignments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.assignments = (payload.assignments || []).filter((a) => a.date === new Date().toISOString().slice(0, 10));
  renderAssignments();
  toast('已取消认领');
}

async function refreshAssignments() {
  const [assignPayload, adjustPayload] = await Promise.all([
    api('/api/assignments'),
    api('/api/plan-adjustments').catch(() => ({ adjustments: [] }))
  ]);
  state.assignments = assignPayload.assignments || [];
  state.planAdjustments = adjustPayload.adjustments || [];
  renderAssignments();
  renderPlanAdjustments();
  toast('分工数据已刷新');
}

// ── 晚报 ─────────────────────────────────────────────────────────

async function generateEveningReport() {
  toast('AI 正在生成晚报（含 commit 汇总）...');
  const payload = await api('/api/reports/evening', { method: 'POST', body: '{}' });
  state.eveningReport = payload.report || '';
  renderEveningReport();
  // 切换到晚报 tab
  setReportTab('evening');
  toast('晚报生成完成' + (payload.wecomSent ? '，已推送至企业微信' : ''));
}

async function doCompareReport() {
  toast('AI 正在生成对照分析...');
  const today = new Date().toISOString().slice(0, 10);
  const payload = await api(`/api/reports/compare?date=${today}`);
  if (payload.error) {
    state.compareReport = `> ⚠️ ${payload.error}`;
  } else {
    state.compareReport = payload.comparison || '';
  }
  renderCompareReport();
  setReportTab('compare');
  toast('对照分析完成');
}

// ── 日报 ──────────────────────────────────────────────────────

async function generateReport() {
  toast('AI 正在生成日报...');
  const payload = await api('/api/reports/daily', { method: 'POST', body: '{}' });
  state.report = payload.report || '';
  renderReport();
  toast('日报生成完成' + (payload.wecomSent ? '，已推送至企业微信' : ''));
}

async function pushReportManual() {
  const payload = await api('/api/wecom/push', {
    method: 'POST',
    body: JSON.stringify({ content: `# 📊 研发日报\n\n${state.report}` })
  });
  toast(payload.sent ? '日报已推送至企业微信' : '推送失败，请检查 WECOM_WEBHOOK_URL');
}

async function pushRisksManual() {
  if (!state.alerts.length) { toast('当前无风险告警'); return; }
  const payload = await api('/api/wecom/push', {
    method: 'POST',
    body: JSON.stringify({
      content: '# 🚨 风险告警\n\n' +
        state.alerts.filter((a) => a.severity === 'P1')
          .map((a) => `**${a.severity}** ${a.title}\n> ${a.detail}`)
          .join('\n\n') || '当前无 P1 告警'
    })
  });
  toast(payload.sent ? '风险告警已推送至企业微信' : '推送失败');
}

// ── 通用 ──────────────────────────────────────────────────────

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
  const project = state.projects.find((p) => p.id === 'cue_ai_classroom');
  const useGitHub = project?.githubOwner;
  const endpoint = useGitHub
    ? '/api/projects/cue_ai_classroom/sync-github'
    : '/api/projects/cue_ai_classroom/sync-local-git';

  setText('#syncStatus', useGitHub ? '正在同步 GitHub 远端...' : '正在同步本地 Git...');
  const payload = await api(endpoint, { method: 'POST', body: '{}' });
  const nextState = await api('/api/state');
  state.tasks = nextState.tasks || [];
  state.members = nextState.members || [];
  state.reviews = nextState.reviews || [];
  state.alerts = payload.alerts || nextState.alerts || [];
  state.projects = nextState.projects || [];
  state.activities = nextState.activities || [];
  state.metrics = payload.metrics || nextState.metrics || {};
  renderAll();
  const srcLabel = payload.source === 'github-api' ? 'GitHub 远端' : '本地 Git';
  setText('#syncStatus', `已同步 (${srcLabel}) · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  toast(`同步完成（${srcLabel}）：${payload.addedActivities || 0} 条 commit，${payload.addedReviews || 0} 条 AI Review`);
}

function setRoute(route) {
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === route);
  });
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === route);
  });
}

function setReportTab(tab) {
  document.querySelectorAll('.report-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.reportTab === tab);
  });
  document.querySelectorAll('.report-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `report${tab.charAt(0).toUpperCase() + tab.slice(1)}Pane`);
  });
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), 2800);
}

// ── 事件绑定 ─────────────────────────────────────────────────

function bindEvents() {
  document.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => setRoute(button.dataset.route));
  });

  document.querySelector('[data-action="generate-plan"]').addEventListener('click', () => {
    generatePlan().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="apply-plan"]').addEventListener('click', () => {
    applyPlan().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="sync"]').addEventListener('click', () => {
    syncCueAiGit().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="sync-cue-ai"]').addEventListener('click', () => {
    syncCueAiGit().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="scan-risks"]').addEventListener('click', () => {
    syncSignals().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="run-review"]').addEventListener('click', () => {
    runReview().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="add-task"]').addEventListener('click', () => {
    createTaskFromPrompt().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="test-alert"]').addEventListener('click', () => {
    syncSignals().then(() => toast('已测试提醒规则，风险队列已刷新')).catch((e) => toast(e.message));
  });

  // 任务 modal
  document.querySelector('[data-action="close-task-modal"]').addEventListener('click', closeTaskModal);
  document.querySelector('#taskModalBackdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTaskModal();
  });
  document.querySelector('#taskEditForm').addEventListener('submit', (e) => {
    saveTaskEdit(e).catch((err) => toast(err.message));
  });
  document.querySelector('[data-action="delete-task"]').addEventListener('click', () => {
    deleteTask().catch((e) => toast(e.message));
  });
  document.querySelector('#editProgress').addEventListener('input', (e) => {
    document.querySelector('#editProgressLabel').textContent = e.target.value;
  });

  // 站会
  document.querySelector('#standupIsLeave').addEventListener('change', (e) => {
    document.querySelector('#standupProxyWrap').style.display = e.target.checked ? '' : 'none';
  });
  document.querySelector('#standupForm').addEventListener('submit', (e) => {
    submitStandup(e).catch((err) => toast(err.message));
  });
  document.querySelector('[data-action="summarize-standup"]').addEventListener('click', () => {
    summarizeStandup().catch((e) => toast(e.message));
  });

  // 日报
  document.querySelector('[data-action="gen-report"]').addEventListener('click', () => {
    generateReport().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="push-report"]').addEventListener('click', () => {
    pushReportManual().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="push-risks"]').addEventListener('click', () => {
    pushRisksManual().catch((e) => toast(e.message));
  });

  // 晚报 & 对照（日报页按钮）
  document.querySelector('[data-action="gen-evening-report2"]').addEventListener('click', () => {
    generateEveningReport().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="compare-report"]').addEventListener('click', () => {
    doCompareReport().catch((e) => toast(e.message));
  });

  // 报告 tab 切换
  document.querySelectorAll('.report-tab').forEach((btn) => {
    btn.addEventListener('click', () => setReportTab(btn.dataset.reportTab));
  });

  // 分工页
  document.querySelector('[data-action="refresh-assignments"]').addEventListener('click', () => {
    refreshAssignments().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="gen-evening-report"]').addEventListener('click', () => {
    generateEveningReport().then(() => setRoute('report')).catch((e) => toast(e.message));
  });

  // ESC 关闭 modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTaskModal();
  });
}

bindEvents();
renderRules();
loadState().catch((error) => {
  setText('#syncStatus', '本地 API 未启动');
  toast(`请先运行 npm run dev：${error.message}`);
});
