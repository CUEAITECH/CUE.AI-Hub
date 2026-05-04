const state = {
  tasks: [],
  members: [],
  reviews: [],
  alerts: [],
  projects: [],
  activities: [],
  assignments: [],
  standups: [],
  eveningReports: {},
  currentStage: {},
  metrics: {},
  plannedTasks: [],
  standups: [],
  standupSummary: '',
  report: '',
  eveningReport: '',
  compareReport: '',
  assignments: [],
  planAdjustments: [],
  docTasks: {},
  semanticLinks: {},
  riskAnalyses: [],
  healthAnalysis: null,
  stageChecklist: null,
  config: { githubEnabled: false, apiKeyRequiredForWrites: false, wecomEnabled: false, llmEnabled: false }
};

let selectedTaskId = '';

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
  const method = String(options.method || 'GET').toUpperCase();
  const needsApiKey = state.config?.apiKeyRequiredForWrites
    && ['POST', 'PATCH', 'DELETE'].includes(method);
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };

  if (needsApiKey && !headers['X-CUE-API-Key']) {
    const storedKey = localStorage.getItem('cueApiKey') || '';
    const apiKey = storedKey || window.prompt('请输入 CUE API Key，用于执行写入或触发动作。') || '';
    if (apiKey) {
      localStorage.setItem('cueApiKey', apiKey);
      headers['X-CUE-API-Key'] = apiKey;
    }
  }

  const response = await fetch(path, {
    headers,
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.error === 'invalid api key' && needsApiKey) {
    localStorage.removeItem('cueApiKey');
  }
  if (!response.ok) {
    const message = payload.details
      ? `${payload.error || `Request failed: ${response.status}`}：${payload.details}`
      : payload.error || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function getTodayText() {
  const local = new Date();
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function getMeetingDate() {
  return document.querySelector('#meetingDate')?.value || getTodayText();
}

function setOptions(selector, options, getValue, getLabel) {
  const element = document.querySelector(selector);
  if (!element) return;
  const current = element.value;
  element.innerHTML = options.map((option) => (
    `<option value="${escapeHtml(getValue(option))}">${escapeHtml(getLabel(option))}</option>`
  )).join('');
  if (options.some((option) => getValue(option) === current)) {
    element.value = current;
  }
}

function getReviewLevelLabel(level) {
  if (level === 'Pass') return '通过';
  if (level === 'Warning') return '提醒';
  if (level === 'Block') return '阻断';
  if (level === 'Escalate') return '升级';
  return level || '未知';
}

function getTodayAssignments() {
  const today = getTodayText();
  return (state.assignments || []).filter((assignment) => assignment.date === today);
}

function getTaskAssignments(taskId) {
  return getTodayAssignments().filter((assignment) => assignment.taskId === taskId);
}

function getAllTaskAssignments(taskId) {
  return (state.assignments || []).filter((assignment) => assignment.taskId === taskId);
}

function getTaskEvidence(task) {
  const text = `${task?.id || ''} ${task?.title || ''}`.toLowerCase();
  const linkedRefs = new Set((task?.linkedRefs || []).map((item) => String(item).toLowerCase()));
  const matches = (item) => {
    const raw = `${item.id || ''} ${item.title || ''} ${item.message || ''} ${item.repo || ''} ${item.activityId || ''}`.toLowerCase();
    return raw.includes(String(task?.id || '').toLowerCase())
      || raw.includes(String(task?.title || '').toLowerCase())
      || [...linkedRefs].some((ref) => raw.includes(ref))
      || text.split(/\s+|\/|:|，|、/).filter((word) => word.length >= 4).some((word) => raw.includes(word));
  };
  return {
    commits: (state.activities || []).filter(matches).slice(0, 8),
    reviews: (state.reviews || []).filter(matches).slice(0, 8),
    assignments: getAllTaskAssignments(task?.id).slice(0, 8)
  };
}

function isCueAiTask(task) {
  return task?.projectId === 'cue_ai_classroom'
    || task?.repo === 'CUEAITECH/Cue.AI'
    || task?.githubFullRepo === 'CUEAITECH/Cue.AI'
    || String(task?.sourceDoc || '').startsWith('docs/');
}

function getAssignableTaskPool() {
  const activeTasks = (state.tasks || []).filter((task) => task.status !== '已完成');
  const cueAiTasks = activeTasks.filter(isCueAiTask);
  return cueAiTasks.length ? cueAiTasks : activeTasks;
}

function getFocusedAssignmentTasks(limit = 8) {
  const todayAssignments = getTodayAssignments();
  const stageTaskIds = new Set((state.stageChecklist?.checklist || [])
    .filter((item) => ['阻塞', '高风险', '待补证据', '推进中'].includes(item.status))
    .flatMap((item) => item.linkedTasks || [])
    .map((task) => task.id));

  return getAssignableTaskPool()
    .map((task) => {
      const claimed = todayAssignments.some((assignment) => assignment.taskId === task.id);
      const score = [
        claimed ? 80 : 0,
        isCueAiTask(task) ? 70 : 0,
        stageTaskIds.has(task.id) ? 60 : 0,
        task.status === '高风险' || task.risk === '高' ? 50 : 0,
        task.risk === '中' ? 20 : 0,
        Number(task.progress) < 60 ? 10 : 0
      ].reduce((sum, item) => sum + item, 0);
      return { ...task, assignmentFocusScore: score };
    })
    .sort((a, b) => {
      const score = b.assignmentFocusScore - a.assignmentFocusScore;
      if (score !== 0) return score;
      return (a.due || '9999-12-31').localeCompare(b.due || '9999-12-31');
    })
    .slice(0, limit);
}

// ── 渲染函数 ─────────────────────────────────────────────────

function renderMetrics() {
  const metrics = state.metrics || {};
  setText('#healthScore', metrics.healthScore ?? 0);
  setText('#healthSummary', `高风险任务 ${metrics.highRiskTasks ?? 0} 个 · Block/Escalate Review ${metrics.pendingReviews ?? 0} 条 · 紧急提醒 ${metrics.urgentAlerts ?? 0} 个`);
  setText('#metricHighRisk', metrics.highRiskTasks ?? 0);
  setText('#metricUrgentAlerts', `${metrics.urgentAlerts ?? 0} 个需要管理者处理`);
  setText('#metricCommits', metrics.commitsToday ?? 0);
  setText('#metricReviews', metrics.pendingReviews ?? 0);
  setText('#metricStandup', metrics.standupResponseRate || '0%');
}

function renderStage() {
  const stage = state.currentStage || {};
  const checklistStage = state.stageChecklist?.stage || {};
  const progress = Math.max(0, Math.min(100, Number(checklistStage.progress ?? stage.progress) || 0));
  setText('#stageName', stage.name || 'Cue.AI 双设备课堂 MVP / TRTC 联调阶段');
  setText('#stageProgressText', `${progress}%`);
  setText('#meetingStageProgress', `阶段进度 ${progress}%`);
  setText('#stageSummary', `${stage.status || '进行中'} · 目标日期 ${stage.targetDate || '待确认'} · ${stage.updatedAt ? `更新于 ${new Date(stage.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '等待晚会报告更新'}`);
  const bar = document.querySelector('#stageProgressBar');
  if (bar) bar.style.width = `${progress}%`;

  const checklistEl = document.querySelector('#stageChecklist');
  if (!checklistEl) return;
  const checklist = state.stageChecklist?.checklist || [];
  const metrics = state.stageChecklist?.metrics || {};
  if (!checklist.length) {
    checklistEl.innerHTML = '<div class="empty-state">暂无阶段对照清单。</div>';
    return;
  }
  checklistEl.innerHTML = `
    <div class="stage-checklist-head">
      <strong>开发阶段对照清单</strong>
      <span>${metrics.done || 0}/${metrics.total || checklist.length} 完成 · ${metrics.missingEvidence || 0} 项缺证据</span>
    </div>
    <div class="stage-checklist-grid">
      ${checklist.map((item) => `
        <article class="stage-check-item stage-check-${escapeHtml(item.status)}">
          <div class="stage-check-top">
            <b>${escapeHtml(item.title)}</b>
            <span>${escapeHtml(item.status)}</span>
          </div>
          <p>${escapeHtml(item.acceptance)}</p>
          <div class="stage-check-progress"><i style="width:${Number(item.progress) || 0}%"></i></div>
          <small>负责人：${escapeHtml(item.owner || '未指定')} · 任务 ${item.linkedTasks?.length || 0} · 提交 ${item.evidence?.commits?.length || 0} · Review ${item.evidence?.reviews?.length || 0}</small>
          ${item.gaps?.length ? `<em>${item.gaps.map(escapeHtml).join(' / ')}</em>` : '<em>证据链完整</em>'}
        </article>
      `).join('')}
    </div>
  `;
}

function roadmapStatusIcon(status) {
  if (status === '已完成') return '✓';
  if (status === '推进中') return '▶';
  if (status === '阻塞') return '!';
  if (status === '高风险') return '!';
  return '•';
}

function roadmapStatusClass(status) {
  if (status === '已完成') return 'done';
  if (status === '推进中') return 'active';
  if (status === '阻塞') return 'blocked';
  if (status === '高风险') return 'risk';
  return 'waiting';
}

function renderRoadmap() {
  const summaryEl = document.querySelector('#roadmapSummary');
  const laneEl = document.querySelector('#roadmapLane');
  const detailEl = document.querySelector('#roadmapDetails');
  if (!summaryEl || !laneEl || !detailEl) return;

  const stage = state.stageChecklist?.stage || state.currentStage || {};
  const metrics = state.stageChecklist?.metrics || {};
  const checklist = state.stageChecklist?.checklist || [];
  const activeTasks = (state.tasks || []).filter((task) => task.status !== '已完成');
  const todayClaims = getTodayAssignments();

  if (!checklist.length) {
    summaryEl.innerHTML = '<div class="empty-state">暂无阶段路线。</div>';
    laneEl.innerHTML = '';
    detailEl.innerHTML = '';
    return;
  }

  summaryEl.innerHTML = `
    <article>
      <span>当前副本</span>
      <strong>${escapeHtml(stage.name || 'Cue.AI 双设备课堂 MVP / TRTC 联调阶段')}</strong>
      <small>${escapeHtml(stage.status || '进行中')} · 目标 ${escapeHtml(stage.targetDate || '待确认')}</small>
    </article>
    <article>
      <span>路线进度</span>
      <strong>${Number(stage.progress) || 0}%</strong>
      <small>${metrics.done || 0}/${metrics.total || checklist.length} 节点完成</small>
    </article>
    <article>
      <span>今日领取</span>
      <strong>${todayClaims.length}</strong>
      <small>${activeTasks.length} 个任务仍在推进</small>
    </article>
    <article>
      <span>卡点</span>
      <strong>${metrics.blocked || 0}</strong>
      <small>${metrics.missingEvidence || 0} 个节点缺证据</small>
    </article>
  `;

  laneEl.innerHTML = checklist.map((item, index) => {
    const statusClass = roadmapStatusClass(item.status);
    const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
    return `
      <article class="roadmap-node roadmap-${statusClass}">
        <div class="roadmap-node-index">${index + 1}</div>
        <div class="roadmap-node-body">
          <div class="roadmap-node-top">
            <b>${escapeHtml(item.title)}</b>
            <span>${roadmapStatusIcon(item.status)}</span>
          </div>
          <p>${escapeHtml(item.acceptance || '')}</p>
          <div class="roadmap-node-progress"><i style="width:${progress}%"></i></div>
          <small>${escapeHtml(item.owner || '未指定')} · ${progress}% · ${escapeHtml(item.status)}</small>
        </div>
      </article>
    `;
  }).join('');

  detailEl.innerHTML = checklist.map((item) => {
    const statusClass = roadmapStatusClass(item.status);
    const tasks = item.linkedTasks || [];
    const commits = item.evidence?.commits || [];
    const reviews = item.evidence?.reviews || [];
    const assignments = item.evidence?.assignments || [];
    return `
      <article class="roadmap-detail roadmap-${statusClass}">
        <div class="roadmap-detail-head">
          <div>
            <span>${escapeHtml(item.status)}</span>
            <h3>${escapeHtml(item.title)}</h3>
          </div>
          <b>${Number(item.progress) || 0}%</b>
        </div>
        <div class="roadmap-detail-section">
          <strong>任务</strong>
          ${tasks.length ? tasks.map((task) => `
            <p>${escapeHtml(task.title)} <em>${escapeHtml(task.owner || '未指定')} · ${escapeHtml(task.status || '待确认')} · ${Number(task.progress) || 0}%${task.aiLink?.reason ? ` · AI ${Math.round(Number(task.aiLink.confidence || 0) * 100)}%：${escapeHtml(task.aiLink.reason)}` : ''}</em></p>
          `).join('') : '<p class="muted-line">暂无关联任务</p>'}
        </div>
        <div class="roadmap-detail-section">
          <strong>证据</strong>
          <p>Commit ${commits.length} · Review ${reviews.length} · 领取 ${assignments.length}</p>
        </div>
        <div class="roadmap-detail-section">
          <strong>下一步</strong>
          ${item.gaps?.length
            ? item.gaps.map((gap) => `<p>${escapeHtml(gap)}</p>`).join('')
            : '<p>证据链完整，继续推进验收。</p>'}
        </div>
      </article>
    `;
  }).join('');
}

function renderTasks() {
  const table = document.querySelector('#taskTable');
  if (!state.tasks.length) {
    table.innerHTML = '<div class="empty-state">暂无任务。可以从 AI 排期生成任务，或手动新增。</div>';
    return;
  }

  table.innerHTML = `
    <div class="task-row task-row-head" aria-hidden="true">
      <span>任务</span>
      <span>负责人</span>
      <span>今日领取</span>
      <span>风险</span>
      <span>截止</span>
      <span>进度</span>
      <span>操作</span>
    </div>
    ${state.tasks.map((task) => {
      const claimants = getTaskAssignments(task.id);
      const isDone = task.status === '已完成';
      return `
        <div class="task-row">
          <div>
            <strong>${escapeHtml(task.title)}</strong>
            <span>${escapeHtml(task.signal)}</span>
          </div>
          <span>${escapeHtml(task.owner)}</span>
          <div class="task-claim-cell">
            ${claimants.length
              ? `<div class="task-claimants">${claimants.map((item) => `<span>${escapeHtml(item.owner)} · ${escapeHtml(item.status || '进行中')}</span>`).join('')}</div>`
              : '<small>未领取</small>'}
            ${!isDone ? `<button class="claim-inline-btn" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">领取</button>` : ''}
          </div>
          <span class="risk-badge risk-${escapeHtml(task.risk)}">${escapeHtml(task.risk)}</span>
          <span>${escapeHtml(task.due || '未设置')}</span>
          <div class="progress" aria-label="${escapeHtml(task.title)} 进度 ${Number(task.progress) || 0}%">
            <i style="width: ${Number(task.progress) || 0}%"></i>
          </div>
          <div class="task-row-actions">
            <button class="icon-btn detail-btn" data-task-id="${escapeHtml(task.id)}" aria-label="查看任务详情">↗</button>
            <button class="icon-btn edit-btn" data-task-id="${escapeHtml(task.id)}" aria-label="编辑任务">✏️</button>
          </div>
        </div>
      `;
    }).join('')}
  `;

  table.querySelectorAll('.detail-btn').forEach((btn) => {
    btn.addEventListener('click', () => openTaskDetail(btn.dataset.taskId));
  });
  // 绑定编辑按钮
  table.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openTaskModal(btn.dataset.taskId));
  });
  table.querySelectorAll('.claim-inline-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      claimTask(btn.dataset.taskId, btn.dataset.taskTitle).catch((e) => toast(e.message))
    );
  });
}

function renderCueAiProject() {
  const panel = document.querySelector('#cueAiProject');
  const project = state.projects.find((item) => item.id === 'cue_ai_classroom');

  if (!project) {
    panel.innerHTML = '<div class="empty-state">尚未配置 Cue.AI 仓库。</div>';
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
      <small>${project.lastSyncAt ? `上次同步 ${new Date(project.lastSyncAt).toLocaleString('zh-CN', { hour12: false })}` : '还没有同步过，点击"同步 GitHub 远端"拉取远端数据'}</small>
    </div>
  `;
}

function renderActivities() {
  const list = document.querySelector('#activityList');
  const projectActivities = state.activities
    .filter((activity) => activity.projectId === 'cue_ai_classroom')
    .slice(0, 8);

  if (!projectActivities.length) {
    list.innerHTML = '<div class="empty-state">点击"同步 GitHub 远端"后，这里会展示最近 commit 和工作区改动。</div>';
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
        ${alert.aiAnalysis?.reason ? `<p class="ai-analysis-line">AI：${escapeHtml(alert.aiAnalysis.reason)} · ${escapeHtml(alert.aiAnalysis.action || '待确认动作')}</p>` : ''}
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

function renderReviewQueue(queue) {
  const container = document.querySelector('#reviewQueue');
  if (!container) return;
  if (!queue || !queue.length) {
    container.innerHTML = '<div class="empty-state">暂无需要人工确认的审阅项 ✅</div>';
    return;
  }
  const decisionLabel = { acknowledged: '已确认', 'needs-fix': '需修复', exempted: '已豁免' };
  container.innerHTML = queue.map((review) => {
    const levelClass = `review-${String(review.level || '').toLowerCase()}`;
    const decided = review.humanDecision;
    return `
    <div class="review-queue-item ${levelClass}" data-review-id="${escapeHtml(review.id)}">
      <div class="review-queue-info">
        <strong>${escapeHtml(review.title)}</strong>
        <span>${escapeHtml(review.owner || '未知')} · ${escapeHtml(getReviewLevelLabel(review.level))} · 分数 ${Number(review.score) || 0}</span>
        ${(review.findings || []).length ? `<p class="review-suggestion">${escapeHtml(review.findings.join('；'))}</p>` : ''}
      </div>
      <div class="review-queue-actions">
        ${decided
          ? `<span class="review-decided">${escapeHtml(decisionLabel[decided] || decided)}</span>`
          : `
          <button class="btn-sm btn-ok" data-action="review-ack" data-id="${escapeHtml(review.id)}">已确认</button>
          <button class="btn-sm btn-warn" data-action="review-fix" data-id="${escapeHtml(review.id)}">需修复</button>
          <button class="btn-sm" data-action="review-exempt" data-id="${escapeHtml(review.id)}">豁免</button>
          `}
      </div>
    </div>`;
  }).join('');
}

async function loadReviewQueue() {
  const container = document.querySelector('#reviewQueue');
  if (container) container.innerHTML = '<div class="empty-state">加载中...</div>';
  const data = await api('/api/reviews/queue');
  renderReviewQueue(data.queue || []);
  if (data.pendingCount) toast(`待处理 Block/Escalate：${data.pendingCount} 条`);
}

async function submitHumanReview(id, decision) {
  await api(`/api/reviews/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ humanDecision: decision })
  });
  await loadReviewQueue();
  toast(`已标记：${{ acknowledged: '已确认', 'needs-fix': '需修复', exempted: '已豁免' }[decision]}`);
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

// 晚会闭环：填充领取/站会表单的下拉选项（来自 main）
function renderMeetingForms() {
  const meetingDate = document.querySelector('#meetingDate');
  if (meetingDate && !meetingDate.value) meetingDate.value = getTodayText();
  setOptions('#assignmentOwner', state.members, (member) => member.name, (member) => `${member.name} · ${member.role}`);
  setOptions('#standupOwner', state.members, (member) => member.name, (member) => `${member.name} · ${member.role}`);
  setOptions('#assignmentTask', state.tasks, (task) => task.id, (task) => `${task.title} · ${task.owner} · ${task.progress}%`);
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

function renderAssignmentBrief(brief) {
  if (!brief) return '';
  const steps = (brief.steps || []).slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const criteria = (brief.acceptanceCriteria || []).slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const deliverables = (brief.deliverables || []).slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `
    <details class="assignment-brief">
      <summary>任务细则 · ${escapeHtml(brief.generatedBy === 'claude' ? 'LLM' : '规则降级')}</summary>
      <p>${escapeHtml(brief.objective || '')}</p>
      <div class="assignment-brief-grid">
        <div>
          <strong>执行步骤</strong>
          <ol>${steps}</ol>
        </div>
        <div>
          <strong>验收标准</strong>
          <ul>${criteria}</ul>
        </div>
        <div>
          <strong>交付物</strong>
          <ul>${deliverables}</ul>
        </div>
      </div>
      <small>${escapeHtml(brief.gitEvidence || '')}</small>
    </details>
  `;
}

function renderBriefBlock(brief) {
  if (!brief) {
    return '<div class="empty-state">这个任务还没有认领细则。先在“分工领取”里认领一次，系统会自动生成。</div>';
  }
  const list = (items, ordered = false) => {
    const tag = ordered ? 'ol' : 'ul';
    const rows = (items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    return `<${tag}>${rows || '<li>待补充</li>'}</${tag}>`;
  };
  return `
    <div class="task-brief-full">
      <section>
        <span>目标</span>
        <p>${escapeHtml(brief.objective || '待补充')}</p>
      </section>
      <section>
        <span>执行步骤</span>
        ${list(brief.steps, true)}
      </section>
      <section>
        <span>验收指标</span>
        ${list(brief.acceptanceCriteria)}
      </section>
      <section>
        <span>交付物</span>
        ${list(brief.deliverables)}
      </section>
      <section>
        <span>Git 证据</span>
        <p>${escapeHtml(brief.gitEvidence || '待补充')}</p>
      </section>
      <section>
        <span>AI 下一步操作指示</span>
        <p>${escapeHtml(brief.nextCheck || '晚会前检查完成证据、阻塞项和下一步拆分。')}</p>
        <p>${escapeHtml(brief.communication || '')}</p>
      </section>
    </div>
  `;
}

function renderTaskDetail() {
  const title = document.querySelector('#taskDetailTitle');
  const subtitle = document.querySelector('#taskDetailSubtitle');
  const content = document.querySelector('#taskDetailContent');
  if (!content) return;

  const task = state.tasks.find((item) => item.id === selectedTaskId) || null;
  if (!task) {
    if (title) title.textContent = '选择一个任务';
    if (subtitle) subtitle.textContent = '从任务看板或分工领取进入，查看任务细则、完成证据、验收指标和 AI 下一步操作。';
    content.innerHTML = '<div class="empty-state">还没有选择任务。</div>';
    return;
  }

  const evidence = getTaskEvidence(task);
  const latestAssignment = evidence.assignments[0] || null;
  const brief = latestAssignment?.brief || null;
  const progress = Number(task.progress) || 0;
  if (title) title.textContent = task.title;
  if (subtitle) {
    subtitle.textContent = `${task.owner || '未指定'} · ${task.status || '未知状态'} · 风险 ${task.risk || '未设置'} · 截止 ${task.due || task.dueDate || '未设置'}`;
  }

  content.innerHTML = `
    <article class="task-detail-card task-detail-overview">
      <span>任务状态</span>
      <div class="task-detail-status">
        <strong>${progress}%</strong>
        <div class="progress"><i style="width:${progress}%"></i></div>
      </div>
      <p>${escapeHtml(task.description || task.signal || '暂无任务描述。')}</p>
      <dl>
        <div><dt>负责人</dt><dd>${escapeHtml(task.owner || '未指定')}</dd></div>
        <div><dt>来源</dt><dd>${escapeHtml(task.sourceDoc || task.repo || '任务看板')}</dd></div>
        <div><dt>验收</dt><dd>${escapeHtml(task.acceptance || '待补充')}</dd></div>
      </dl>
    </article>

    <article class="task-detail-card task-detail-main">
      <span>结构化任务规则</span>
      ${renderBriefBlock(brief)}
    </article>

    <article class="task-detail-card">
      <span>完成证据</span>
      <div class="evidence-list">
        <strong>认领记录 ${evidence.assignments.length}</strong>
        ${evidence.assignments.length ? evidence.assignments.map((item) => `<p>${escapeHtml(item.owner)} · ${escapeHtml(item.status || '进行中')} · ${escapeHtml(item.note || '无说明')}</p>`).join('') : '<p>暂无认领记录。</p>'}
        <strong>Commit ${evidence.commits.length}</strong>
        ${evidence.commits.length ? evidence.commits.map((item) => `<p>${escapeHtml(item.author || item.owner || '未知')} · ${escapeHtml(item.message || item.title || item.id)}</p>`).join('') : '<p>暂无关联提交。</p>'}
        <strong>AI Review ${evidence.reviews.length}</strong>
        ${evidence.reviews.length ? evidence.reviews.map((item) => `<p>${escapeHtml(getReviewLevelLabel(item.level))} · ${escapeHtml(item.title)}</p>`).join('') : '<p>暂无关联审阅。</p>'}
      </div>
    </article>
  `;
}

function renderAssignments() {
  const today = getTodayText();
  const todayAssignments = getTodayAssignments();
  const dateEl = document.querySelector('#assignmentDate');
  if (dateEl) dateEl.textContent = today;
  const activeTasks = getAssignableTaskPool();
  const focusedTasks = getFocusedAssignmentTasks(8);
  setOptions('#assignmentOwner', state.members, (member) => member.name, (member) => `${member.name} · ${member.role}`);
  setOptions('#assignmentTask', focusedTasks.length ? focusedTasks : activeTasks, (task) => task.id, (task) => `${task.title} · ${task.owner} · ${task.progress}%`);

  // 今日认领情况（按成员分组）
  const summaryEl = document.querySelector('#assignmentSummary');
  if (summaryEl) {
    if (!todayAssignments.length) {
      summaryEl.innerHTML = '<div class="empty-state">今日暂无认领记录。</div>';
    } else {
      // 按 owner 分组
      const byOwner = {};
      for (const a of todayAssignments) {
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
              ${renderAssignmentBrief(a.brief)}
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
    if (!activeTasks.length) {
      assignableEl.innerHTML = '<div class="empty-state">暂无进行中的任务。</div>';
    } else {
      // 统计每个任务已有哪些人认领
      assignableEl.innerHTML = `
        <div class="assignment-focus-note">
          <strong>今日建议领取</strong>
          <span>从 ${activeTasks.length} 个 Cue.AI 当前阶段任务中筛出 ${focusedTasks.length} 个，优先展示卡点、风险和阶段路径相关任务。认领后会自动生成任务细则。</span>
        </div>
        ${focusedTasks.map((task) => {
        const claimants = todayAssignments.filter((a) => a.taskId === task.id);
        return `
            <div class="assignable-task-row">
            <div class="assignable-task-info">
              <div class="assignable-task-title">
                <button class="task-link-btn" type="button" data-task-id="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button>
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
      }).join('')}`;

      assignableEl.querySelectorAll('.claim-btn').forEach((btn) => {
        btn.addEventListener('click', () =>
          claimTask(btn.dataset.taskId, btn.dataset.taskTitle).catch((e) => toast(e.message))
        );
      });
      assignableEl.querySelectorAll('.task-link-btn').forEach((btn) => {
        btn.addEventListener('click', () => openTaskDetail(btn.dataset.taskId));
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
  const btnPushEveningReport = document.querySelector('#btnPushEveningReport');
  if (state.config.wecomEnabled) {
    if (wecomStatus) wecomStatus.style.display = '';
    if (btnPushRisks) btnPushRisks.style.display = '';
    if (btnPushReport) btnPushReport.style.display = '';
    if (btnPushEveningReport) btnPushEveningReport.style.display = '';
  }
}

function renderMeetingStandups() {
  const list = document.querySelector('#meetingStandupList');
  if (!list) return;
  const date = getMeetingDate();
  const standups = state.standups.filter((standup) => standup.date === date);
  if (!standups.length) {
    list.innerHTML = '<div class="empty-state">还没有成员提交今日站会。</div>';
    return;
  }

  list.innerHTML = standups.map((standup) => `
    <div class="standup-item">
      <strong>${escapeHtml(standup.owner)}${standup.isLeave ? ' · 请假' : ''}</strong>
      <span>昨日：${escapeHtml(standup.yesterday || '未填')}</span>
      <span>今日：${escapeHtml(standup.today || '未填')}</span>
      <small>阻塞：${escapeHtml(standup.blockers || '无')}</small>
    </div>
  `).join('');
}

function renderMeetingAssignments() {
  const list = document.querySelector('#meetingAssignmentList');
  if (!list) return;
  const date = getMeetingDate();
  const assignments = state.assignments.filter((assignment) => assignment.date === date);
  if (!assignments.length) {
    list.innerHTML = '<div class="empty-state">晚会确认后，在这里记录成员领取的下一步任务。</div>';
    return;
  }

  list.innerHTML = assignments.map((assignment) => `
    <div class="assignment-item">
      <strong>${escapeHtml(assignment.owner)} · ${escapeHtml(assignment.taskTitle || assignment.taskId)}</strong>
      <span>${escapeHtml(assignment.note || '等待 Git 信号对账')} · ${escapeHtml(assignment.wecomStatus || '待企业微信确认')}</span>
      <small>${escapeHtml(assignment.status || '进行中')} · ${assignment.updatedAt ? new Date(assignment.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''}</small>
    </div>
  `).join('');
}

function renderMeetingReport() {
  const reportBox = document.querySelector('#meetingEveningReport');
  const summary = document.querySelector('#meetingReportSummary');
  if (!reportBox || !summary) return;
  const reportEntry = state.eveningReports?.[getMeetingDate()];
  const reportMarkdown = typeof reportEntry === 'string'
    ? reportEntry
    : reportEntry?.report || state.eveningReport || '';
  const reportSummary = typeof reportEntry === 'object' ? reportEntry.summary || {} : {};

  if (!reportMarkdown) {
    summary.innerHTML = '<div><span>状态</span><b>待生成</b></div>';
    reportBox.textContent = '点击"生成晚会报告"后，这里会输出前一天任务领取、今日提交、AI Review 风险和下一步细化目标。';
    return;
  }

  summary.innerHTML = `
    <div><span>领取任务</span><b>${Number(reportSummary.assignmentCount) || state.assignments.filter((item) => item.date === getMeetingDate()).length}</b></div>
    <div><span>Git 提交</span><b>${Number(reportSummary.commitCount) || 0}</b></div>
    <div><span>Block Review</span><b>${Number(reportSummary.blockReviewCount) || 0}</b></div>
    <div><span>无提交支撑</span><b>${Number(reportSummary.noCommitAssignmentCount) || 0}</b></div>
    <div><span>阶段进度</span><b>${Number(reportSummary.stageProgress) || Number(state.currentStage?.progress) || 0}%</b></div>
  `;
  reportBox.textContent = reportMarkdown;
}

function renderMeeting() {
  const meetingDate = document.querySelector('#meetingDate');
  if (meetingDate && !meetingDate.value) meetingDate.value = getTodayText();
  setOptions('#meetingAssignmentOwner', state.members, (member) => member.name, (member) => `${member.name} · ${member.role}`);
  setOptions('#meetingStandupOwner', state.members, (member) => member.name, (member) => `${member.name} · ${member.role}`);
  setOptions('#meetingAssignmentTask', state.tasks.filter((task) => task.status !== '已完成'), (task) => task.id, (task) => `${task.title} · ${task.owner} · ${task.progress}%`);
  renderMeetingAssignments();
  renderMeetingStandups();
  renderMeetingReport();
}

function renderAll() {
  renderMetrics();
  renderStage();
  renderRoadmap();
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
  renderTaskDetail();
  renderPlanAdjustments();
  renderMeeting();
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
  state.assignments = payload.assignments || [];
  state.standups = payload.standups || [];
  state.eveningReports = payload.eveningReports || {};
  state.currentStage = payload.currentStage || {};
  state.metrics = payload.metrics || {};
  state.docTasks = payload.docTasks || {};
  state.semanticLinks = payload.semanticLinks || {};
  state.riskAnalyses = payload.riskAnalyses || [];
  state.healthAnalysis = payload.healthAnalysis || null;
  state.stageChecklist = payload.stageChecklist || null;
  setText('#syncStatus', '本地 API 已连接');

  // 并行加载站会、配置、今日分工、计划调整建议
  const [standupPayload, config, assignPayload, adjustPayload, eveningPayload, checklistPayload] = await Promise.all([
    api('/api/standups').catch(() => ({ standups: [] })),
    api('/api/config').catch(() => ({})),
    api('/api/assignments').catch(() => ({ assignments: [] })),
    api('/api/plan-adjustments').catch(() => ({ adjustments: [] })),
    api('/api/reports/evening').catch(() => ({ report: null })),
    api('/api/stage/checklist').catch(() => null)
  ]);

  state.standups = standupPayload.standups || [];
  state.config = config;
  state.assignments = assignPayload.assignments || [];
  state.planAdjustments = adjustPayload.adjustments || [];
  state.stageChecklist = checklistPayload || state.stageChecklist;
  if (eveningPayload.report) {
    state.eveningReports = {
      ...state.eveningReports,
      [eveningPayload.date || getTodayText()]: eveningPayload.report
    };
    state.eveningReport = typeof eveningPayload.report === 'string'
      ? eveningPayload.report
      : eveningPayload.report.report || '';
  }

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
  renderAll();
  openTaskDetail(taskId);
  toast(`${owner} 已认领「${taskTitle}」`);
}

async function claimSelectedTask() {
  const owner = document.querySelector('#assignmentOwner')?.value;
  const taskId = document.querySelector('#assignmentTask')?.value;
  const task = state.tasks.find((item) => item.id === taskId);
  const note = document.querySelector('#assignmentNote')?.value || '';
  if (!owner) { toast('请选择领取人'); return; }
  if (!taskId || !task) { toast('请选择领取任务'); return; }

  const payload = await api('/api/assignments', {
    method: 'POST',
    body: JSON.stringify({ owner, taskId, note })
  });
  state.assignments = payload.assignments || state.assignments;
  renderAll();
  openTaskDetail(taskId);
  toast(`${owner} 已认领「${task.title}」`);
}

async function markAssignmentDone(id) {
  const payload = await api(`/api/assignments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: '已完成' })
  });
  state.assignments = payload.assignments || state.assignments;
  renderAll();
  toast('已标记完成');
}

async function cancelAssignment(id) {
  if (!window.confirm('确认取消认领？')) return;
  const payload = await api(`/api/assignments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.assignments = (payload.assignments || []).filter((a) => a.date === getTodayText());
  renderAll();
  toast('已取消认领');
}

async function refreshAssignments() {
  const [assignPayload, adjustPayload] = await Promise.all([
    api('/api/assignments'),
    api('/api/plan-adjustments').catch(() => ({ adjustments: [] }))
  ]);
  state.assignments = assignPayload.assignments || [];
  state.planAdjustments = adjustPayload.adjustments || [];
  renderAll();
  renderPlanAdjustments();
  toast('分工数据已刷新');
}

// ── 晚报 ─────────────────────────────────────────────────────────

async function generateEveningReport() {
  toast('正在同步仓库并生成晚会报告...');
  await syncCueAiGit().catch((error) => {
    toast(`仓库同步未完成，继续使用已有数据生成报告：${error.message}`);
  });
  const date = getMeetingDate();
  const payload = await api('/api/reports/evening', {
    method: 'POST',
    body: JSON.stringify({ date, pushWeCom: true })
  });
  const reportEntry = payload.report || {};
  state.eveningReport = typeof reportEntry === 'string' ? reportEntry : reportEntry.report || '';
  state.eveningReports = {
    ...state.eveningReports,
    [payload.date || date]: reportEntry
  };
  state.tasks = payload.tasks || state.tasks;
  state.currentStage = payload.currentStage || state.currentStage;
  state.alerts = payload.alerts || state.alerts;
  state.metrics = payload.metrics || state.metrics;
  renderEveningReport();
  renderMeeting();
  renderStage();
  setReportTab('evening');
  setText('#syncStatus', `晚会报告已生成 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  toast('晚会报告生成完成' + (payload.wecomSent ? '，已推送至企业微信' : ''));
}

async function doCompareReport() {
  toast('AI 正在生成对照分析...');
  const date = getMeetingDate(); // 使用晚会日期选择器的日期（Shanghai 时区）
  const payload = await api(`/api/reports/compare?date=${date}`);
  if (payload.error) {
    state.compareReport = `> ⚠️ ${payload.error}`;
  } else {
    state.compareReport = payload.comparison || '';
  }
  renderCompareReport();
  setReportTab('compare');
  toast('对照分析完成');
}

// ── 会后总结 ──────────────────────────────────────────────────
async function generateMeetingSummary() {
  toast('正在生成晚会后总结...');
  const date = getMeetingDate();
  const payload = await api('/api/reports/meeting-summary', {
    method: 'POST',
    body: JSON.stringify({ date })
  });
  const wecomMsg = payload.wecomSent
    ? '，已推送至企业微信' : state.config.wecomEnabled ? '，企微推送失败，请检查 Webhook' : '';
  toast(`会后总结完成（${payload.assignmentCount} 条分工）${wecomMsg}`);
  // 刷新分工显示
  await refreshAssignments().catch(() => {});
}

// ── AI 产品经理：从文档导入任务 ──────────────────────────────
async function syncDocsToHub() {
  toast('正在从目标仓库 docs/ 解析任务...');
  const projectId = state.currentProject?.id || 'cue_ai_classroom';
  const payload = await api(`/api/projects/${projectId}/sync-docs`, { method: 'POST', body: '{}' });
  if (payload.imported === 0) {
    toast(payload.message || '没有新任务导入（已全部存在或文档无可执行任务）');
  } else {
    toast(`成功导入 ${payload.imported} 条新任务（共解析 ${payload.total} 条）`);
    await loadState().then(() => renderTasks()).catch(() => {});
  }
}

// ── AI 产品经理：写回进度文档 ─────────────────────────────────
async function updateDocsProgress() {
  toast('正在生成阶段进度追踪并写回 GitHub...');
  const projectId = state.currentProject?.id || 'cue_ai_classroom';
  const payload = await api(`/api/projects/${projectId}/update-docs`, { method: 'POST', body: '{}' });
  if (payload.written) {
    toast(`docs/阶段进度追踪.md 已更新（${payload.date}）`);
  } else {
    toast('写回失败，请检查 GITHUB_TOKEN 是否有 repo 写权限');
  }
}

async function refreshAiAnalysis() {
  toast('正在执行 AI 混合分析...');
  const payload = await api('/api/ai/refresh-analysis', { method: 'POST', body: '{}' });
  state.alerts = payload.alerts || state.alerts;
  state.metrics = payload.metrics || state.metrics;
  state.stageChecklist = payload.stageChecklist || state.stageChecklist;
  state.semanticLinks = payload.semanticLinks || state.semanticLinks;
  state.riskAnalyses = payload.riskAnalyses || state.riskAnalyses;
  state.healthAnalysis = payload.healthAnalysis || state.healthAnalysis;
  renderAll();
  toast(payload.healthAnalysis?.nextFocus || 'AI 混合分析已刷新');
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
      repo: 'CUEAITECH/Cue.AI',
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

async function syncCueAiGit(options = {}) {
  const project = state.projects.find((p) => p.id === 'cue_ai_classroom');
  const useGitHub = project?.githubOwner;
  const endpoint = useGitHub
    ? '/api/projects/cue_ai_classroom/sync-github'
    : '/api/projects/cue_ai_classroom/sync-local-git';

  if (!options.silent) setText('#syncStatus', useGitHub ? '正在同步 GitHub 远端...' : '正在同步本地 Git...');
  const payload = await api(endpoint, { method: 'POST', body: '{}' });
  const nextState = await api('/api/state');
  state.tasks = nextState.tasks || [];
  state.members = nextState.members || [];
  state.reviews = nextState.reviews || [];
  state.alerts = payload.alerts || nextState.alerts || [];
  state.projects = nextState.projects || [];
  state.activities = nextState.activities || [];
  state.assignments = nextState.assignments || [];
  state.standups = nextState.standups || [];
  state.eveningReports = nextState.eveningReports || {};
  state.currentStage = nextState.currentStage || {};
  state.metrics = payload.metrics || nextState.metrics || {};
  state.stageChecklist = nextState.stageChecklist || state.stageChecklist;
  renderAll();
  const srcLabel = payload.source === 'github-api' ? 'GitHub 远端' : '本地 Git';
  setText('#syncStatus', `已同步 (${srcLabel}) · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  if (!options.silent) toast(`同步完成（${srcLabel}）：${payload.addedActivities || 0} 条 commit，${payload.addedReviews || 0} 条 AI Review`);
}

async function createMeetingAssignment() {
  const taskId = document.querySelector('#meetingAssignmentTask').value;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!taskId) { toast('请选择领取任务'); return; }
  const payload = await api('/api/assignments', {
    method: 'POST',
    body: JSON.stringify({
      date: getMeetingDate(),
      owner: document.querySelector('#meetingAssignmentOwner').value,
      taskId,
      taskTitle: task?.title || taskId,
      note: document.querySelector('#meetingAssignmentNote').value,
      status: '进行中',
      wecomStatus: '待企业微信确认'
    })
  });
  state.assignments = [
    ...(payload.assignments || []),
    ...state.assignments.filter((assignment) => assignment.date !== getMeetingDate())
  ];
  renderMeeting();
  renderAssignments();
  toast('任务领取已记录，晚会后可同步到企业微信');
}

async function submitMeetingStandup() {
  const payload = await api('/api/standups', {
    method: 'POST',
    body: JSON.stringify({
      date: getMeetingDate(),
      owner: document.querySelector('#meetingStandupOwner').value,
      yesterday: document.querySelector('#meetingStandupYesterday').value,
      today: document.querySelector('#meetingStandupToday').value,
      blockers: document.querySelector('#meetingStandupBlockers').value
    })
  });
  state.standups = [
    ...(payload.standups || []),
    ...state.standups.filter((standup) => standup.date !== getMeetingDate())
  ];
  renderMeeting();
  renderStandup();
  toast('站会记录已提交');
}

async function copyEveningReport() {
  const report = document.querySelector('#meetingEveningReport')?.textContent || state.eveningReport || '';
  if (!report || report.startsWith('点击')) {
    toast('还没有可复制的晚会报告');
    return;
  }
  await navigator.clipboard.writeText(report);
  toast('晚会报告已复制，可粘贴到企业微信');
}

async function pushEveningReportManual() {
  const report = document.querySelector('#meetingEveningReport')?.textContent || state.eveningReport || '';
  if (!report || report.startsWith('点击')) {
    toast('还没有可推送的晚会报告');
    return;
  }
  const payload = await api('/api/wecom/push', {
    method: 'POST',
    body: JSON.stringify({ content: `# 🌆 CUE 晚会作战包\n\n${report}` })
  });
  toast(payload.sent ? '晚会报告已推送至企业微信' : '推送失败，请检查 WECOM_WEBHOOK_URL');
}

function setRoute(route) {
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === route);
  });
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === route);
  });
}

function openTaskDetail(taskId) {
  selectedTaskId = taskId || '';
  renderTaskDetail();
  setRoute('task-detail');
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

  document.querySelector('#meetingDate')?.addEventListener('change', () => {
    renderMeeting();
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
  document.querySelectorAll('[data-action="sync-cue-ai"]').forEach((button) => button.addEventListener('click', () => {
    syncCueAiGit().catch((e) => toast(e.message));
  }));
  document.querySelector('[data-action="scan-risks"]').addEventListener('click', () => {
    syncSignals().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="run-review"]').addEventListener('click', () => {
    runReview().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="load-review-queue"]').addEventListener('click', () => {
    loadReviewQueue().catch((e) => toast(e.message));
  });
  // 人工审阅决策（事件委托到 reviewQueue 容器）
  document.querySelector('#reviewQueue').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const actionMap = { 'review-ack': 'acknowledged', 'review-fix': 'needs-fix', 'review-exempt': 'exempted' };
    const decision = actionMap[btn.dataset.action];
    if (decision && id) submitHumanReview(id, decision).catch((err) => toast(err.message));
  });
  document.querySelector('[data-action="add-task"]').addEventListener('click', () => {
    createTaskFromPrompt().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="test-alert"]').addEventListener('click', () => {
    syncSignals().then(() => toast('已测试提醒规则，风险队列已刷新')).catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="generate-evening-report"]')?.addEventListener('click', () => {
    generateEveningReport().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="create-assignment"]')?.addEventListener('click', () => {
    createMeetingAssignment().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="submit-meeting-standup"]')?.addEventListener('click', () => {
    submitMeetingStandup().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="copy-evening-report"]')?.addEventListener('click', () => {
    copyEveningReport().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="push-evening-report"]')?.addEventListener('click', () => {
    pushEveningReportManual().catch((e) => toast(e.message));
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
  document.querySelector('[data-action="claim-selected-task"]')?.addEventListener('click', () => {
    claimSelectedTask().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="back-to-assignment"]')?.addEventListener('click', () => {
    setRoute('assignment');
  });
  document.querySelector('[data-action="gen-evening-report"]').addEventListener('click', () => {
    generateEveningReport().then(() => setRoute('report')).catch((e) => toast(e.message));
  });
  // 会后总结按钮（meeting 页和 assignment 页各有一个）
  document.querySelectorAll('[data-action="meeting-summary"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      generateMeetingSummary().catch((e) => toast(e.message));
    });
  });

  // AI 产品经理：文档同步按钮
  document.querySelectorAll('[data-action="sync-docs"]').forEach((button) => button.addEventListener('click', () => {
    syncDocsToHub().catch((e) => toast(e.message));
  }));
  document.querySelectorAll('[data-action="update-docs"]').forEach((button) => button.addEventListener('click', () => {
    updateDocsProgress().catch((e) => toast(e.message));
  }));
  document.querySelectorAll('[data-action="refresh-ai-analysis"]').forEach((button) => button.addEventListener('click', () => {
    refreshAiAnalysis().catch((e) => toast(e.message));
  }));

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

window.setInterval(() => {
  syncCueAiGit({ silent: true }).catch(() => {
    setText('#syncStatus', '自动抓取暂不可用，等待下次重试');
  });
}, 300000);
