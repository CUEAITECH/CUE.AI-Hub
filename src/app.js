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
  deliverables: [],
  phases: [],
  semanticLinks: {},
  riskAnalyses: [],
  healthAnalysis: null,
  stageChecklist: null,
  deliverableProgress: null,
  reviewQueue: [],
  currentProjectId: localStorage.getItem('cue_currentProjectId') || '',
  currentProject: null,
  isAuthenticated: Boolean(sessionStorage.getItem('cueHubSessionToken')),
  config: { githubEnabled: false, apiKeyRequiredForWrites: false, wecomEnabled: false, llmEnabled: false }
};

let selectedTaskId = '';
let selectedRiskId = '';
let activeRiskTab = 'P1';
let loginMode = 'password';
const _submitting = new Set();

// 防重复提交：key 相同的调用在前一次完成前直接忽略
function once(key, fn) {
  return async (...args) => {
    if (_submitting.has(key)) { toast('正在提交，请稍候…'); return; }
    _submitting.add(key);
    const btn = document.querySelector(`[data-action="${CSS.escape(key)}"]`);
    if (btn) { btn.disabled = true; btn.dataset.origText = btn.textContent; btn.textContent = '提交中…'; }
    try { await fn(...args); }
    finally {
      _submitting.delete(key);
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || btn.textContent; }
    }
  };
}

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

function renderStageUpdateMeta(stageUpdate = {}) {
  if (!stageUpdate || typeof stageUpdate !== 'object') return '';
  const items = [];
  if (stageUpdate.shortName) items.push(`阶段 ${stageUpdate.shortName}`);
  if (stageUpdate.status) items.push(`状态 ${stageUpdate.status}`);
  if (Number.isFinite(Number(stageUpdate.progressDelta)) && Number(stageUpdate.progressDelta) !== 0) {
    const delta = Number(stageUpdate.progressDelta);
    items.push(`进度 ${delta > 0 ? '+' : ''}${delta}%`);
  }
  if (Array.isArray(stageUpdate.checklist) && stageUpdate.checklist.length) {
    items.push(`路径节点 ${stageUpdate.checklist.length} 个`);
  }
  return items.length
    ? `<div class="ai-pm-stage-update">${items.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`
    : '';
}

let _pendingRequests = 0;
function _showLoader(text) {
  _pendingRequests++;
  const bar = document.querySelector('#loaderBar');
  const label = document.querySelector('#loaderText');
  if (bar) bar.classList.add('active');
  if (label && text) label.textContent = text;
}
function _hideLoader() {
  _pendingRequests = Math.max(0, _pendingRequests - 1);
  if (_pendingRequests === 0) {
    const bar = document.querySelector('#loaderBar');
    if (bar) bar.classList.remove('active');
  }
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  const sessionToken = sessionStorage.getItem('cueHubSessionToken') || '';
  if (sessionToken && !headers.Authorization && !headers['X-CUE-Session-Token']) {
    headers['X-CUE-Session-Token'] = sessionToken;
  }


  _showLoader(options.loadingText || (method !== 'GET' ? '处理中...' : '加载中...'));
  let response;
  try {
    response = await fetch(path, { headers, ...options });
  } finally {
    _hideLoader();
  }

  const payload = await response.json().catch(() => ({}));
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

function addDaysText(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getMeetingWindow(dateText = getMeetingDate()) {
  const previousDate = addDaysText(dateText, -1);
  const start = new Date(`${previousDate}T18:00:00+08:00`);
  const attendanceStart = new Date(`${dateText}T18:30:00+08:00`);
  const attendanceEnd = new Date(`${dateText}T19:00:00+08:00`);
  const now = new Date();
  const selectedIsToday = dateText === getTodayText();
  const end = selectedIsToday ? now : new Date(`${dateText}T23:59:59+08:00`);
  return { previousDate, start, end, attendanceStart, attendanceEnd };
}

function formatDateTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...options
  }).format(date);
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

function getCurrentProjectId() {
  return state.currentProjectId || state.projects[0]?.id || 'cue_ai_classroom';
}

function syncCurrentProject(projectId = '') {
  const fallback = state.projects[0]?.id || 'cue_ai_classroom';
  const requested = projectId || state.currentProjectId || fallback;
  const exists = (state.projects || []).some((project) => project.id === requested);
  state.currentProjectId = exists ? requested : fallback;
  state.currentProject = (state.projects || []).find((project) => project.id === state.currentProjectId) || null;
  if (state.currentProjectId) localStorage.setItem('cue_currentProjectId', state.currentProjectId);
}

function renderProjectSwitcher() {
  const options = (state.projects || []).map((project) => `
    <option value="${escapeHtml(project.id)}">${escapeHtml(project.name || project.id)}</option>
  `).join('');
  document.querySelectorAll('[data-project-switcher]').forEach((select) => {
    select.innerHTML = options;
    select.value = getCurrentProjectId();
  });
}

function getApiScopeLabel() {
  const host = window.location.hostname;
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return '本地 API';
  return '远端 API';
}

function setAuthVisible(isAuthenticated) {
  state.isAuthenticated = Boolean(isAuthenticated);
  document.body.classList.toggle('authenticated', state.isAuthenticated);
}

function logout() {
  sessionStorage.removeItem('cueHubSessionToken');
  sessionStorage.removeItem('cueHubAuthenticated');
  sessionStorage.removeItem('cueHubUser');
  sessionStorage.removeItem('cueHubUserRole');
  // 整页重载，确保所有状态干净归零，回到登录页
  window.location.reload();
}

async function openAccountSettings() {
  const backdrop = document.querySelector('#accountSettingsBackdrop');
  if (!backdrop) return;
  // 拉当前账号的最新信息（手机号可能在别处改过）
  const projectId = getCurrentProjectId();
  let me = null;
  try {
    const payload = await api(`/api/auth/users?projectId=${encodeURIComponent(projectId)}`);
    me = (payload.users || []).find((u) => u.username === currentSessionUsername()) || null;
  } catch { /* 拉不到也允许打开（用户可能不是管理员看不到列表，但还是要能改自己密码） */ }
  setText('#accountSettingsName', me?.name || currentSessionUsername() || '—');
  setText('#accountSettingsUsername', me?.username || currentSessionUsername() || '—');
  setText('#accountSettingsPhoneCurrent', me?.phone || '未绑定');
  setText('#accountSettingsEmailCurrent', me?.email || '未绑定');
  const phoneInput = document.querySelector('#newPhoneInput');
  if (phoneInput) phoneInput.value = me?.phone || '';
  const phoneCodeInput = document.querySelector('#bindPhoneCodeInput');
  if (phoneCodeInput) phoneCodeInput.value = '';
  const emailInput = document.querySelector('#newEmailInput');
  if (emailInput) emailInput.value = me?.email || '';
  const emailCodeInput = document.querySelector('#bindEmailCodeInput');
  if (emailCodeInput) emailCodeInput.value = '';
  setText('#changePasswordHint', '');
  setText('#bindPhoneHint', '');
  setText('#bindEmailHint', '');
  document.querySelector('#changePasswordForm')?.reset();
  backdrop.style.display = 'flex';
}

function closeAccountSettings() {
  const backdrop = document.querySelector('#accountSettingsBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

async function submitChangePassword(event) {
  event.preventDefault();
  const currentPassword = document.querySelector('#currentPasswordInput')?.value || '';
  const newPassword = document.querySelector('#newPasswordInput')?.value || '';
  const confirm = document.querySelector('#newPasswordConfirmInput')?.value || '';
  const hint = document.querySelector('#changePasswordHint');
  if (newPassword !== confirm) {
    if (hint) hint.textContent = '两次新密码不一致';
    return;
  }
  if (newPassword.length < 6) {
    if (hint) hint.textContent = '新密码至少 6 位';
    return;
  }
  try {
    await api('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    if (hint) hint.textContent = '✅ 密码已更新';
    toast('密码已更新，请下次登录使用新密码');
    document.querySelector('#changePasswordForm')?.reset();
  } catch (error) {
    if (hint) hint.textContent = error.message === 'current password is incorrect' ? '当前密码不正确' : `失败：${error.message}`;
  }
}

async function submitBindPhone(event) {
  event.preventDefault();
  const phone = document.querySelector('#newPhoneInput')?.value.trim() || '';
  const phoneCode = document.querySelector('#bindPhoneCodeInput')?.value.trim() || '';
  const hint = document.querySelector('#bindPhoneHint');
  if (phone && !phoneCode) {
    if (hint) hint.textContent = '请先获取并填写验证码';
    return;
  }
  try {
    const payload = await api('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ phone, phoneCode })
    });
    const saved = payload.user?.phone || '';
    if (hint) hint.textContent = saved ? `✅ 已绑定 ${saved}，可用于登录` : '✅ 已清除手机号绑定';
    setText('#accountSettingsPhoneCurrent', saved || '未绑定');
    toast(saved ? '手机号已绑定' : '手机号绑定已清除');
  } catch (error) {
    if (hint) {
      if (error.message === 'invalid phone number') hint.textContent = '手机号格式不正确';
      else if (error.message === 'phone already bound to another account') hint.textContent = '该手机号已被其他账号绑定';
      else if (error.message === 'invalid verification code') hint.textContent = '验证码不正确或已过期';
      else hint.textContent = `失败：${error.message}`;
    }
  }
}

async function submitBindEmail(event) {
  event.preventDefault();
  const email = document.querySelector('#newEmailInput')?.value.trim() || '';
  const emailCode = document.querySelector('#bindEmailCodeInput')?.value.trim() || '';
  const hint = document.querySelector('#bindEmailHint');
  if (email && !emailCode) {
    if (hint) hint.textContent = '请先获取并填写验证码';
    return;
  }
  try {
    const payload = await api('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ email, emailCode })
    });
    const saved = payload.user?.email || '';
    if (hint) hint.textContent = saved ? `✅ 已绑定 ${saved}，可用于邮箱验证码登录` : '✅ 已清除邮箱绑定';
    setText('#accountSettingsEmailCurrent', saved || '未绑定');
    toast(saved ? '邮箱已绑定' : '邮箱绑定已清除');
  } catch (error) {
    if (hint) {
      if (error.message === 'invalid email address') hint.textContent = '邮箱格式不正确';
      else if (error.message === 'email already bound to another account') hint.textContent = '该邮箱已被其他账号绑定';
      else if (error.message === 'invalid verification code') hint.textContent = '验证码不正确或已过期';
      else hint.textContent = `失败：${error.message}`;
    }
  }
}

function setLoginMode(mode) {
  loginMode = mode === 'email' ? 'email' : 'password';
  document.querySelectorAll('[data-login-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.loginMode === loginMode);
  });
  const passwordField = document.querySelector('#loginPasswordField');
  const passwordInput = document.querySelector('#loginPassword');
  const emailCodeField = document.querySelector('#loginEmailCodeField');
  const emailCodeInput = document.querySelector('#loginEmailCode');
  if (passwordField) passwordField.hidden = loginMode !== 'password';
  if (passwordInput) passwordInput.required = loginMode === 'password';
  if (emailCodeField) emailCodeField.hidden = loginMode !== 'email';
  if (emailCodeInput) emailCodeInput.required = loginMode === 'email';
  const hintText = loginMode === 'email'
      ? '??????????????????'
      : '???????????????????';
  setText('#loginHint', hintText);
}

async function sendLoginPhoneCode() {
  const projectId = getCurrentProjectId();
  const phone = document.querySelector('#loginUsername')?.value.trim() || '';
  if (!projectId) { toast('请选择项目'); return; }
  if (!phone) { setText('#loginHint', '请先输入已绑定手机号。'); return; }
  const payload = await api('/api/auth/phone-code', {
    method: 'POST',
    body: JSON.stringify({ phone, projectId, purpose: 'login' })
  });
  const suffix = payload.devCode ? ` 验证码：${payload.devCode}` : '';
  setText('#loginHint', `验证码已发送，10 分钟内有效。${suffix}`);
  toast('验证码已发送');
}

async function sendLoginEmailCode() {
  const projectId = getCurrentProjectId();
  const email = document.querySelector('#loginUsername')?.value.trim() || '';
  if (!projectId) { toast('请选择项目'); return; }
  if (!email) { setText('#loginHint', '请先输入已绑定邮箱。'); return; }
  const payload = await api('/api/auth/email-code', {
    method: 'POST',
    body: JSON.stringify({ email, projectId, purpose: 'login' })
  });
  const suffix = payload.devCode ? ` 验证码：${payload.devCode}` : '';
  setText('#loginHint', `验证码已发送到邮箱，10 分钟内有效。${suffix}`);
  toast('邮箱验证码已发送');
}

async function sendBindPhoneCode() {
  const phone = document.querySelector('#newPhoneInput')?.value.trim() || '';
  const hint = document.querySelector('#bindPhoneHint');
  if (!phone) {
    if (hint) hint.textContent = '请输入要绑定的手机号';
    return;
  }
  const payload = await api('/api/auth/phone-code', {
    method: 'POST',
    body: JSON.stringify({ phone, purpose: 'bind_phone' })
  });
  if (hint) hint.textContent = `验证码已发送，10 分钟内有效。${payload.devCode ? `验证码：${payload.devCode}` : ''}`;
  toast('验证码已发送');
}

async function sendBindEmailCode() {
  const email = document.querySelector('#newEmailInput')?.value.trim() || '';
  const hint = document.querySelector('#bindEmailHint');
  if (!email) {
    if (hint) hint.textContent = '请输入要绑定的邮箱';
    return;
  }
  const payload = await api('/api/auth/email-code', {
    method: 'POST',
    body: JSON.stringify({ email, purpose: 'bind_email' })
  });
  if (hint) hint.textContent = `验证码已发送到邮箱，10 分钟内有效。${payload.devCode ? `验证码：${payload.devCode}` : ''}`;
  toast('邮箱验证码已发送');
}

async function loadLoginProjects() {
  const payload = await api('/api/projects');
  state.projects = payload.projects || [];
  syncCurrentProject(localStorage.getItem('cue_currentProjectId') || state.projects[0]?.id || '');
  renderProjectSwitcher();
}

async function login(event) {
  event.preventDefault();
  const projectId = getCurrentProjectId();
  const username = document.querySelector('#loginUsername')?.value.trim() || '';
  const password = document.querySelector('#loginPassword')?.value || '';
  const emailCode = document.querySelector('#loginEmailCode')?.value.trim() || '';
  if (!projectId) { toast('请选择项目'); return; }
  if (loginMode === 'email' && !emailCode) { setText('#loginHint', '请输入邮箱验证码。'); return; }
  const payload = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(loginMode === 'email'
        ? { username, emailCode, projectId }
        : { username, password, projectId })
  });
  sessionStorage.setItem('cueHubSessionToken', payload.token || '');
  sessionStorage.setItem('cueHubAuthenticated', 'true');
  sessionStorage.setItem('cueHubUser', payload.user?.name || payload.user?.username || username);
  sessionStorage.setItem('cueHubUserRole', payload.user?.projectRole || payload.user?.role || 'developer');
  syncCurrentProject(projectId);
  setAuthVisible(true);
  await loadState();
  const routeAfterLogin = sessionStorage.getItem('cueHubPostLoginRoute') || '';
  sessionStorage.removeItem('cueHubPostLoginRoute');
  if (routeAfterLogin === 'account-admin') {
    if (['admin', 'project_admin'].includes(payload.user?.projectRole || payload.user?.role)) setRoute('account-admin');
    else toast('当前账号没有账号管理权限。');
  }
}

function currentSessionRole() {
  return sessionStorage.getItem('cueHubUserRole') || 'developer';
}

function currentUserCanManageAccounts() {
  return ['admin', 'project_admin'].includes(currentSessionRole());
}

function roleLabel(role) {
  if (role === 'admin') return '系统管理员';
  if (role === 'project_admin') return '项目管理员';
  return '项目开发者';
}

function currentSessionUsername() {
  return sessionStorage.getItem('cueHubUser') || '';
}

async function loadProjectUsers() {
  const projectId = getCurrentProjectId();
  if (!projectId) return [];
  const payload = await api(`/api/auth/users?projectId=${encodeURIComponent(projectId)}`);
  return payload.users || [];
}

async function renderAccountAdmin() {
  const list = document.querySelector('#adminPageUserList');
  const form = document.querySelector('#adminPageRegisterForm');
  const refreshButton = document.querySelector('[data-action="refresh-project-users"]');
  if (!list || !form) return;
  const isAdmin = currentUserCanManageAccounts();
  form.style.display = isAdmin ? '' : 'none';
  if (refreshButton) refreshButton.style.display = isAdmin ? '' : 'none';
  if (!state.isAuthenticated) {
    list.innerHTML = '<div class="empty-state">请先登录项目中枢。</div>';
    return;
  }
  try {
    const users = await loadProjectUsers();
    const callerUsername = currentSessionUsername();
    // 当前调用者是否为本项目创始人——决定他能否看到「权限调整」按钮
    const callerIsFounder = isAdmin && users.some((u) => u.username === callerUsername && u.isFounder);
    // 创始人排在最前面，剩下按角色排：项目管理员 > 开发者
    const sortedUsers = [...users].sort((a, b) => {
      if (a.isFounder !== b.isFounder) return a.isFounder ? -1 : 1;
      const aIsAdmin = (a.projectRole || a.role) === 'project_admin';
      const bIsAdmin = (b.projectRole || b.role) === 'project_admin';
      if (aIsAdmin !== bIsAdmin) return aIsAdmin ? -1 : 1;
      return 0;
    });
    list.innerHTML = sortedUsers.length
      ? sortedUsers.map((user) => {
        const isFounder = Boolean(user.isFounder);
        const isSelfFounder = isFounder && user.username === callerUsername;
        const role = user.projectRole || user.role;
        // 创始人是独立的最高权限等级：UI 上不再展示"项目管理员"角色，直接显示"创始人"
        const displayRole = isFounder ? '创始人' : roleLabel(role);
        const roleTone = isFounder ? 'founder' : role === 'project_admin' ? 'admin' : 'developer';
        return `
        <div class="admin-user-card ${user.active === false ? 'is-disabled' : ''} ${isFounder ? 'is-founder' : ''}" data-user-id="${escapeHtml(user.id)}">
          <div class="admin-user-card-head">
            <div class="admin-user-identity">
              <strong>${escapeHtml(user.name || user.username)}</strong>
              <span class="admin-user-handle">@${escapeHtml(user.username)}</span>
            </div>
            <span class="admin-user-role-pill admin-user-role-${roleTone}">${displayRole}</span>
          </div>
          <div class="admin-user-card-status">
            <span class="admin-user-status-dot admin-user-status-${user.active === false ? 'off' : 'on'}"></span>
            <span>${user.active === false ? '已停用' : '已启用'}</span>
          </div>
          ${isAdmin ? `<div class="admin-user-card-actions">
            ${isFounder
              ? `<span class="admin-user-locked-hint">创始人角色受保护，调整请使用「转移创始人」</span>`
              : `${callerIsFounder
                  ? `<button type="button" data-action="open-role-change" data-target-name="${escapeHtml(user.name || user.username)}" data-target-handle="${escapeHtml(user.username)}" data-current-role="${escapeHtml(role)}">权限调整</button>`
                  : ''}
                <button type="button" data-action="toggle-user-active">
                  ${user.active === false ? '启用' : '停用'}
                </button>`}
            ${isSelfFounder ? '<button type="button" data-action="transfer-founder" class="admin-user-btn-danger">转移创始人</button>' : ''}
          </div>` : ''}
        </div>
      `;
      }).join('')
      : '<div class="empty-state">当前项目还没有账号。</div>';
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message || '账号列表加载失败')}</div>`;
  }
}

let _roleChangeContext = null;

function openRoleChangeModal({ userId, targetName, targetHandle, currentRole }) {
  _roleChangeContext = { userId, currentRole };
  const backdrop = document.querySelector('#roleModalBackdrop');
  if (!backdrop) return;
  setText('#roleModalTargetName', targetName);
  setText('#roleModalTargetHandle', `@${targetHandle}`);
  // 默认选中当前角色，让用户清楚现在是什么
  backdrop.querySelectorAll('input[name="roleChoice"]').forEach((radio) => {
    radio.checked = radio.value === currentRole;
  });
  backdrop.style.display = 'flex';
}

function closeRoleChangeModal() {
  const backdrop = document.querySelector('#roleModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
  _roleChangeContext = null;
}

async function confirmRoleChange() {
  if (!_roleChangeContext) return;
  const checked = document.querySelector('input[name="roleChoice"]:checked');
  if (!checked) {
    toast('请先选择一个权限等级');
    return;
  }
  const nextRole = checked.value;
  const { userId, currentRole } = _roleChangeContext;
  if (nextRole === currentRole) {
    toast('权限未变化，无需调整');
    closeRoleChangeModal();
    return;
  }
  try {
    await updateProjectUserFromAdminPage(userId, { role: nextRole });
    closeRoleChangeModal();
  } catch (error) {
    toast(`❌ 调整失败：${error.message}`);
  }
}

async function transferFounder() {
  const projectId = getCurrentProjectId();
  const targetUsername = window.prompt('请输入新创始人的登录账号（必须是该项目的现有成员）：');
  if (!targetUsername) return;
  if (!window.confirm(`确认把 ${projectId} 项目的创始人权限转移给 ${targetUsername}？\n\n转移后你将不再是创始人，但仍保留项目管理员角色。`)) return;
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/transfer-founder`, {
      method: 'POST',
      body: JSON.stringify({ targetUsername: targetUsername.trim() })
    });
    toast(`✅ 创始人已转移给 ${payload.newFounderUsername}`);
    await renderAccountAdmin();
  } catch (error) {
    toast(`❌ 转移失败：${error.message}`);
  }
}

async function registerProjectUserFromAdminPage(event) {
  event.preventDefault();
  const projectId = getCurrentProjectId();
  const name = document.querySelector('#adminPageRegisterName')?.value.trim() || '';
  const username = document.querySelector('#adminPageRegisterUsername')?.value.trim() || '';
  const password = document.querySelector('#adminPageRegisterPassword')?.value || '';
  const role = document.querySelector('#adminPageRegisterRole')?.value || 'developer';
  const payload = await api('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify({ projectId, name, username, password, role })
  });
  setText('#adminPageRegisterHint', `已创建 ${payload.user?.name || username}，可登录当前项目。`);
  document.querySelector('#adminPageRegisterForm')?.reset();
  const passwordInput = document.querySelector('#adminPageRegisterPassword');
  if (passwordInput) passwordInput.value = '123456';
  await renderAccountAdmin();
}

async function updateProjectUserFromAdminPage(userId, patch) {
  const projectId = getCurrentProjectId();
  const payload = await api(`/api/auth/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ projectId, ...patch })
  });
  setText('#adminPageRegisterHint', `已更新 ${payload.user?.name || payload.user?.username || '账号'}。`);
  await renderAccountAdmin();
}

// ─── 个人中心 Helper ──────────────────────────────────────────────────────────

function getMyTasks() {
  const me = sessionStorage.getItem('cueHubUser') || '';
  if (!me) return [];
  const pid = getCurrentProjectId();
  return state.tasks.filter((t) => {
    if (t.projectId !== pid) return false;
    if (t.owner === me) return true;
    return (state.assignments || []).some((a) => a.taskId === t.id && a.owner === me);
  });
}

function getMyReviews() {
  const me = sessionStorage.getItem('cueHubUser') || '';
  if (!me) return [];
  const pid = getCurrentProjectId();
  return (state.reviews || []).filter((r) => r.owner === me && r.projectId === pid);
}

function getMyReconciliationRows() {
  const me = sessionStorage.getItem('cueHubUser') || '';
  if (!me) return [];
  const rows = [];
  for (const [date, entry] of Object.entries(state.eveningReports || {})) {
    if (!Array.isArray(entry?.reconciliation)) continue;
    entry.reconciliation
      .filter((row) => row.owner === me)
      .forEach((row) => rows.push({ ...row, date }));
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
}

// ─── 个人中心 Render ──────────────────────────────────────────────────────────

function renderMyHealthCard() {
  const el = document.querySelector('#myHealthBody');
  if (!el) return;
  const myTasks = getMyTasks();
  const total = myTasks.length;
  const done = myTasks.filter((t) => t.status === '已完成').length;
  const inProgress = myTasks.filter((t) => t.status === '进行中').length;
  const overdue = myTasks.filter(
    (t) => t.due && new Date(t.due) < new Date() && t.status !== '已完成'
  ).length;
  const withDeliverable = myTasks.filter((t) => t.deliverableId).length;
  const bindingRate = total > 0 ? Math.round((withDeliverable / total) * 100) : 0;

  el.innerHTML = `
    <div class="pc-metric pc-metric-blue">
      <strong>${inProgress}</strong><span>进行中</span>
    </div>
    <div class="pc-metric pc-metric-green">
      <strong>${done}</strong><span>已完成</span>
    </div>
    <div class="pc-metric${overdue > 0 ? ' pc-metric-red' : ' pc-metric-gray'}">
      <strong>${overdue}</strong><span>逾期</span>
    </div>
    <div class="pc-metric pc-metric-indigo">
      <strong>${bindingRate}%</strong><span>交付绑定</span>
    </div>
  `;
}

function renderMyTasksCard() {
  const el = document.querySelector('#myTasksList');
  if (!el) return;
  const myTasks = getMyTasks();
  if (!myTasks.length) {
    el.innerHTML = '<p class="muted-line">当前项目下没有分配给你的任务。</p>';
    return;
  }
  const statusOrder = { 进行中: 0, 待确认: 1, 已完成: 2 };
  const today = new Date();
  const sorted = [...myTasks].sort((a, b) => {
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    return 0;
  });
  el.innerHTML = sorted
    .map((task) => {
      const isOverdue = task.due && new Date(task.due) < today && task.status !== '已完成';
      return `
        <div class="pc-task-row${isOverdue ? ' pc-task-overdue' : ''}">
          <div class="pc-task-status-bar status-${escapeHtml(task.status)}"></div>
          <div class="pc-task-body">
            <span class="pc-task-title">${escapeHtml(task.title)}</span>
            <span class="pc-task-meta">
              ${isOverdue ? '<span class="pc-tag pc-tag-red">逾期</span>' : ''}
              <span class="pc-tag pc-tag-neutral">${escapeHtml(task.due ? task.due : '未设截止')}</span>
              <span class="pc-tag pc-tag-risk-${escapeHtml(task.risk)}">${escapeHtml(task.risk)}</span>
              ${task.progress > 0 ? `<span class="pc-tag pc-tag-neutral">${task.progress}%</span>` : ''}
            </span>
          </div>
          <button class="pc-icon-btn detail-btn" data-task-id="${escapeHtml(task.id)}" aria-label="查看详情">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
          </button>
        </div>
      `;
    })
    .join('');
  el.querySelectorAll('.detail-btn').forEach((btn) => {
    btn.addEventListener('click', () => openTaskDetail(btn.dataset.taskId));
  });
}

function renderMyReviewsCard() {
  const el = document.querySelector('#myReviewsList');
  if (!el) return;
  const myReviews = getMyReviews()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 8);
  if (!myReviews.length) {
    el.innerHTML = '<p class="muted-line">暂无 AI 代码审阅记录。</p>';
    return;
  }
  const levelClass = { Pass: 'risk-低', Warning: 'risk-中', Block: 'risk-高', Escalate: 'risk-高' };
  el.innerHTML = myReviews
    .map(
      (r) => `
      <div class="pc-review-row">
        <span class="pc-level-badge level-${(r.level || 'pass').toLowerCase()}">${escapeHtml(r.level || '-')}</span>
        <span class="pc-review-title">${escapeHtml((r.title || '').slice(0, 40))}</span>
        <span class="pc-review-meta">${r.score ?? '-'}分 · ${escapeHtml((r.createdAt || '').slice(0, 10))}</span>
      </div>
    `
    )
    .join('');
}

function renderMyEveningCard() {
  const el = document.querySelector('#myEveningList');
  if (!el) return;
  const rows = getMyReconciliationRows();
  if (!rows.length) {
    el.innerHTML = '<p class="muted-line">暂无晚会对账记录。</p>';
    return;
  }
  el.innerHTML = rows
    .slice(0, 10)
    .map((row) => {
      const badgeClass = row.completed ? 'pc-tag-green' : row.commitCount > 0 ? 'pc-tag-amber' : 'pc-tag-red';
      const badgeText = row.completed ? '✓ 完成' : row.commitCount > 0 ? `${row.commitCount} commits` : '无提交';
      return `
        <div class="pc-evening-row">
          <span class="pc-evening-date">${escapeHtml(row.date)}</span>
          <span class="pc-evening-task">${escapeHtml(row.taskTitle || row.taskId || '未知任务')}</span>
          <span class="pc-tag ${badgeClass}">${badgeText}</span>
        </div>
      `;
    })
    .join('');
}

function renderPersonalCenter() {
  const me = sessionStorage.getItem('cueHubUser') || '???';
  const role = currentSessionRole();
  const projectName = state.currentProject?.name || getCurrentProjectId();
  setText('#profileUserName', me);
  const avatarEl = document.querySelector('#profileAvatar');
  if (avatarEl) avatarEl.textContent = me ? me.slice(0, 1) : '?';
  setText('#profileUserMeta', `${roleLabel(role)} · ${projectName || '????'}`);
  renderMyHealthCard();
  renderMyTasksCard();
  renderMyReviewsCard();
  renderMyEveningCard();
  document.querySelectorAll('#personal-center .pc-route-btn').forEach((btn) => {
    btn.addEventListener('click', () => setRoute(btn.dataset.route));
  });
}

async function switchProfileProject(event) {
  const projectId = event.target?.value || '';
  if (!projectId || projectId === getCurrentProjectId()) return;
  syncCurrentProject(projectId);
  await loadState();
  renderPersonalCenter();
  setRoute('overview');
}

function getTodayAssignments() {
  const today = getTodayText();
  return (state.assignments || []).filter((a) => a.date === today);
}

// 近期认领：今天 + 昨天未完成（用于分工面板展示）
function getRecentAssignments() {
  const all = state.assignments || [];
  const today = getTodayText();
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const todaySet = new Set(all.filter((a) => a.date === today).map((a) => `${a.owner}|${a.taskId}`));
  const yesterdayCarryover = all.filter(
    (a) => a.date === yesterday && a.status !== '已完成' && !todaySet.has(`${a.owner}|${a.taskId}`)
  );
  return [...all.filter((a) => a.date === today), ...yesterdayCarryover];
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
    return item.taskId === task?.id
      || (task?.deliverableId && item.deliverableId === task.deliverableId)
      || raw.includes(String(task?.id || '').toLowerCase())
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

function getDeliverableForTask(task) {
  if (!task) return null;
  return getRoadmapDeliverables().find((item) => item.id === task.deliverableId)
    || null;
}

function isPlaceholderAcceptance(value) {
  return !String(value || '').trim() || /待补充|未定|todo/i.test(String(value || ''));
}

function getTaskAcceptance(task) {
  if (!isPlaceholderAcceptance(task?.acceptance)) return task.acceptance;
  const deliverable = getDeliverableForTask(task);
  if (!isPlaceholderAcceptance(deliverable?.acceptance)) return deliverable.acceptance;
  if (!isPlaceholderAcceptance(task?.description)) return task.description;
  return '待补充';
}

function getRoadmapDeliverables() {
  // 优先用聚合后的 deliverable 数据；空时也用 state.deliverables。
  // 不再回退到 stageChecklist.checklist（避免 reset 后空状态时显示默认 5 个幽灵节点）
  return state.deliverableProgress?.deliverables?.length
    ? state.deliverableProgress.deliverables
    : (state.deliverables?.length ? state.deliverables : []);
}

function getRoadmapPhases() {
  return state.deliverableProgress?.phases?.length
    ? state.deliverableProgress.phases
    : (state.phases?.length ? state.phases : []);
}

function isCueAiTask(task) {
  const currentProject = state.currentProject || {};
  return task?.projectId === getCurrentProjectId()
    || (currentProject.githubFullRepo && task?.repo === currentProject.githubFullRepo)
    || (currentProject.githubFullRepo && task?.githubFullRepo === currentProject.githubFullRepo)
    || String(task?.sourceDoc || '').startsWith('docs/');
}

function getAssignableTaskPool() {
  return (state.tasks || []).filter((task) => task.status !== '已完成');
}

function getFocusedAssignmentTasks(limit = 8) {
  const stageTaskIds = new Set(getRoadmapDeliverables()
    .filter((item) => ['阻塞', '高风险', '待补证据', '推进中'].includes(item.status))
    .flatMap((item) => item.linkedTasks || [])
    .map((task) => task.id));

  return getAssignableTaskPool()
    .map((task) => {
      const score = [
        task.reviewId ? 100 : 0,        // 打回审阅修复任务最优先
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
  const score = metrics.healthScore ?? 0;
  setText('#healthScore', score);
  const ring = document.querySelector('#healthRingBar');
  if (ring) {
    const pct = Math.max(0, Math.min(100, Number(score)));
    ring.style.strokeDashoffset = 233 - (pct / 100) * 233;
    ring.style.stroke = pct >= 80 ? '#0f7a55' : pct >= 60 ? '#9a6400' : '#b42318';
  }
  setText('#metricHighRisk', metrics.highRiskTasks ?? 0);
  setText('#metricUrgentAlerts', `${metrics.urgentAlerts ?? 0} 个需要管理者处理`);
  setText('#metricCommits', metrics.commitsToday ?? 0);
  setText('#metricReviews', metrics.pendingReviews ?? 0);
  setText('#metricStandup', metrics.standupResponseRate || '0%');
}

function renderStage() {
  const stage = state.currentStage || {};
  const checklistStage = state.stageChecklist?.stage || {};
  const deliverableProgress = Number(state.deliverableProgress?.metrics?.progress);
  const progress = Math.max(0, Math.min(100, Number.isFinite(deliverableProgress) ? deliverableProgress : Number(checklistStage.progress ?? stage.progress) || 0));
  setText('#stageName', stage.shortName || checklistStage.shortName || stage.name || 'MVP / TRTC 联调');
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
    checklistEl.innerHTML = '<div class="stage-compact-empty">暂无阶段对照清单</div>';
    return;
  }
  const blocked = checklist.filter((item) => item.status === '阻塞' || item.status === '高风险').length;
  const missingEvidence = Number(metrics.missingEvidence) || 0;
  checklistEl.innerHTML = `
    <div class="stage-compact-stats" aria-label="阶段摘要">
      <span><b>${metrics.done || 0}/${metrics.total || checklist.length}</b> 完成</span>
      <span><b>${missingEvidence}</b> 缺证据</span>
      <span><b>${blocked}</b> 阻塞/高风险</span>
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

function bindingClass(binding = {}) {
  if (binding.strength === 'strong' || binding.mode === 'fk') return 'strong';
  if (binding.strength === 'medium' || binding.mode === 'hybrid') return 'medium';
  return 'weak';
}

function bindingLabel(binding = {}) {
  return binding.label || (binding.mode === 'fk' ? '显式 FK' : binding.mode === 'hybrid' ? 'AI 语义' : '关键词兜底');
}

function renderRoadmap() {
  const summaryEl = document.querySelector('#roadmapSummary');
  const laneEl = document.querySelector('#roadmapLane');
  const detailEl = document.querySelector('#roadmapDetails');
  if (!summaryEl || !laneEl || !detailEl) return;

  const stage = state.stageChecklist?.stage || state.currentStage || {};
  const metrics = state.deliverableProgress?.metrics || state.stageChecklist?.metrics || {};
  const deliverables = getRoadmapDeliverables();
  const phases = getRoadmapPhases();
  const activeTasks = (state.tasks || []).filter((task) => task.status !== '已完成');
  const todayClaims = getTodayAssignments();

  if (!deliverables.length) {
    summaryEl.innerHTML = '<div class="empty-state">暂无阶段路线。</div>';
    laneEl.innerHTML = '';
    detailEl.innerHTML = '';
    return;
  }

  const fkCount = deliverables.filter((item) => item.linkMode === 'fk').length;
  const fallbackCount = deliverables.filter((item) => item.linkMode === 'rules').length;

  summaryEl.innerHTML = `
    <article>
      <span>当前副本</span>
      <strong title="${escapeHtml(stage.name || '')}">${escapeHtml(stage.shortName || stage.name || 'MVP / TRTC 联调')}</strong>
      <small>${escapeHtml(stage.status || '进行中')} · 目标 ${escapeHtml(stage.targetDate || '待确认')}</small>
    </article>
    <article>
      <span>交付进度</span>
      <strong>${Number(metrics.progress ?? stage.progress) || 0}%</strong>
      <small>${metrics.done || 0}/${metrics.total || deliverables.length} 交付项完成</small>
    </article>
    <article>
      <span>今日领取</span>
      <strong>${todayClaims.length}</strong>
      <small>${activeTasks.length} 个任务仍在推进</small>
    </article>
    <article>
      <span>绑定来源</span>
      <strong>${fkCount}/${deliverables.length}</strong>
      <small>${fallbackCount} 个关键词兜底</small>
    </article>
  `;

  // 按阶段分组渲染交付项
  const nodesByPhase = Object.fromEntries(phases.map((p) => [p.id, []]));
  const unphased = [];
  deliverables.forEach((item, index) => {
    if (item.phaseId && nodesByPhase[item.phaseId]) {
      nodesByPhase[item.phaseId].push({ ...item, _globalIndex: index });
    } else {
      unphased.push({ ...item, _globalIndex: index });
    }
  });

  function renderPhaseNodes(nodes) {
    return nodes.map((item) => {
      const statusClass = roadmapStatusClass(item.status);
      const bindClass = bindingClass(item.binding);
      const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
      return `
        <article class="roadmap-node roadmap-deliverable roadmap-${statusClass}">
          <div class="roadmap-node-index">${item._globalIndex + 1}</div>
          <div class="roadmap-node-body">
            <div class="roadmap-node-top">
              <b>${escapeHtml(item.title)}</b>
              <span>${roadmapStatusIcon(item.status)}</span>
            </div>
            <p>${escapeHtml(item.acceptance || '')}</p>
            ${item.docSuggestComplete ? '<span class="roadmap-doc-suggest">文档侧已完成待确认</span>' : ''}
            <span class="binding-pill binding-${bindClass}">${escapeHtml(bindingLabel(item.binding))}</span>
            <div class="roadmap-node-progress"><i style="width:${progress}%"></i></div>
            <small>${escapeHtml(item.owner || '未指定')} · ${progress}% · ${escapeHtml(item.status)} · ${item.linkedTasks?.length || 0} 个任务</small>
          </div>
        </article>`;
    }).join('');
  }

  if (phases.length) {
    // 隐藏 0 交付项的 phase（LLM 创建了历史阶段但无新 deliverable 落入），
    // 同时保持 P{n} 编号按"可见 phase 的连续序号"递增，看着干净
    const visiblePhases = phases.filter((phase) => (nodesByPhase[phase.id] || []).length > 0);
    laneEl.innerHTML = visiblePhases.map((phase, phaseIndex) => {
      const nodes = nodesByPhase[phase.id] || [];
      const phaseStatusClass = roadmapStatusClass(phase.status || '待开始');
      return `
        <section class="roadmap-phase roadmap-phase-${phaseIndex + 1}">
          <div class="roadmap-phase-header roadmap-phase-header-${phaseIndex + 1}">
            <div class="roadmap-phase-title">
              <span class="roadmap-phase-index">P${phaseIndex + 1}</span>
              <strong>${escapeHtml(phase.title)}</strong>
              <span class="roadmap-phase-status roadmap-${phaseStatusClass}">${roadmapStatusIcon(phase.status)} ${escapeHtml(phase.status || '待开始')}</span>
            </div>
            ${phase.progress != null ? `<div class="roadmap-phase-progress"><i style="width:${phase.progress}%"></i></div>` : ''}
          </div>
          <div class="roadmap-phase-nodes">
            ${renderPhaseNodes(nodes)}
          </div>
        </section>`;
    }).join('') + (unphased.length ? `<section class="roadmap-phase roadmap-phase-other"><div class="roadmap-phase-header">其他</div><div class="roadmap-phase-nodes">${renderPhaseNodes(unphased)}</div></section>` : '');
  } else {
    laneEl.innerHTML = renderPhaseNodes(deliverables.map((item, i) => ({ ...item, _globalIndex: i })));
  }

  detailEl.onclick = async (e) => {
    const doneBtn = e.target.closest('.override-done-btn');
    const resetBtn = e.target.closest('.override-reset-btn');
    const btn = doneBtn || resetBtn;
    if (!btn) return;
    const nodeId = btn.dataset.nodeId;
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const body = doneBtn ? { status: '已完成', by: '手动确认' } : { status: 'reset' };
      const data = await api(`/api/stage/checklist/${encodeURIComponent(nodeId)}`, { method: 'PATCH', body: JSON.stringify(body) });
      state.stageChecklist = data.stageChecklist || data;
      state.deliverableProgress = data.deliverableProgress || state.deliverableProgress;
      renderRoadmap();
      toast(doneBtn ? '已标记为完成' : '已撤销覆盖');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = doneBtn ? '标记已完成（文档确认）' : '撤销覆盖';
    }
  };

  detailEl.innerHTML = deliverables.map((item) => {
    const statusClass = roadmapStatusClass(item.status);
    const tasks = item.linkedTasks || [];
    const commits = item.evidence?.commits || [];
    const reviews = item.evidence?.reviews || [];
    const assignments = item.evidence?.assignments || [];
    const binding = item.binding || {};
    const bindClass = bindingClass(binding);
    const bindingCounts = binding.counts || {};
    return `
      <article class="roadmap-detail roadmap-${statusClass}">
        <div class="roadmap-detail-head">
          <div>
            <span>${escapeHtml(item.status)}</span>
            <h3>${escapeHtml(item.title)}</h3>
          </div>
          <b>${Number(item.progress) || 0}%</b>
        </div>
        <div class="roadmap-binding binding-${bindClass}">
          <div>
            <strong>${escapeHtml(bindingLabel(binding))}</strong>
            <p>${escapeHtml(binding.explanation || '暂无绑定解释')}</p>
          </div>
          <small>任务 ${bindingCounts.tasks || 0} · Commit ${bindingCounts.commits || 0} · 认领 ${bindingCounts.assignments || 0}</small>
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
        <div class="roadmap-detail-section roadmap-override-section">
          ${item.manualOverride
            ? `<span class="override-badge">手动标记：${escapeHtml(item.status)} · ${escapeHtml(item.overriddenBy || item.manualOverride?.by || '')} ${item.overriddenAt || item.manualOverride?.at ? new Date(item.overriddenAt || item.manualOverride.at).toLocaleDateString('zh-CN') : ''}</span>
               <button class="override-reset-btn" data-node-id="${escapeHtml(item.id)}">撤销覆盖</button>`
            : `<button class="override-done-btn" data-node-id="${escapeHtml(item.id)}">标记已完成（文档确认）</button>`
          }
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

  const overviewTasks = [...state.tasks]
    .sort((a, b) => {
      const riskWeight = { 高: 3, 中: 2, 低: 1 };
      return (riskWeight[b.risk] || 0) - (riskWeight[a.risk] || 0)
        || new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    })
    .slice(0, 5);

  table.innerHTML = `
    ${overviewTasks.map((task) => {
      const claimants = getTaskAssignments(task.id);
      const isDone = task.status === '已完成';
      return `
        <div class="task-row overview-task-row">
          <div class="overview-task-main">
            <strong>${escapeHtml(task.title)}</strong>
          </div>
          <div class="overview-task-meta">
            <span>${claimants.length ? escapeHtml(claimants.map((item) => item.owner).join('、')) : '未领'}</span>
            <span class="risk-badge risk-${escapeHtml(task.risk)}">${escapeHtml(task.risk)}</span>
            <span>${escapeHtml(task.due || '未设置')}</span>
          </div>
          <div class="task-row-actions">
            <button class="icon-btn detail-btn" data-task-id="${escapeHtml(task.id)}" aria-label="查看任务详情">↗</button>
            ${!isDone ? `<button class="claim-inline-btn" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">领取</button>` : ''}
          </div>
        </div>
      `;
    }).join('')}
    ${state.tasks.length > 5 ? '<button class="text-link-btn" type="button" data-route="assignment">查看全部任务领取</button>' : ''}
  `;

  table.querySelectorAll('.detail-btn').forEach((btn) => {
    btn.addEventListener('click', () => openTaskDetail(btn.dataset.taskId));
  });
  table.querySelectorAll('.claim-inline-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      claimTask(btn.dataset.taskId, btn.dataset.taskTitle).catch((e) => toast(e.message))
    );
  });
  table.querySelectorAll('[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => setRoute(btn.dataset.route));
  });
}

function renderCueAiProject() {
  const panel = document.querySelector('#cueAiProject');
  const project = state.projects.find((item) => item.id === getCurrentProjectId());

  if (!project) {
    panel.innerHTML = '<div class="empty-state">尚未配置项目仓库。</div>';
    return;
  }

  const githubUrl = project.githubFullRepo
    ? `https://github.com/${project.githubFullRepo}`
    : null;
  const sourceLabel = project.githubOwner ? 'GitHub 远端' : '本地 Git';
  const repoLabel = project.githubFullRepo || project.repository || '待同步';
  const syncText = project.lastSyncAt
    ? formatDateTime(project.lastSyncAt, { year: 'numeric' })
    : '待同步';

  panel.innerHTML = `
    <a class="project-card project-card-dashboard" href="${githubUrl ? escapeHtml(githubUrl) : '#'}" ${githubUrl ? 'target="_blank" rel="noopener"' : 'aria-disabled="true"'}>
      <div>
        <strong>${escapeHtml(project.name)}</strong>
        <span>${escapeHtml(repoLabel)}</span>
      </div>
      <div class="project-dashboard-stats">
        <span><b>${Number(project.commitCount) || 0}</b><small>近期 commits</small></span>
        <span><b>${escapeHtml(project.branch || 'main')}</b><small>分支</small></span>
        <span><b>${escapeHtml(project.status || sourceLabel)}</b><small>状态</small></span>
        <span><b>${escapeHtml(syncText)}</b><small>上次同步</small></span>
      </div>
    </a>
  `;
}

function renderActivities() {
  const list = document.querySelector('#activityList');
  const projectActivities = state.activities
    .filter((activity) => !activity.projectId || activity.projectId === getCurrentProjectId())
    .slice(0, 5);

  if (!projectActivities.length) {
    list.innerHTML = '<div class="empty-state">点击"同步 GitHub 远端"后，这里会展示最近 commit 和工作区改动。</div>';
    return;
  }

  list.innerHTML = projectActivities.map((activity) => `
    <div class="activity-item activity-${escapeHtml(activity.type)}">
      <b>${activity.type === 'commit' ? escapeHtml(activity.shortSha || 'commit') : '未提交'}</b>
      <div class="activity-line">
        <strong>${escapeHtml(activity.title)}</strong>
        <span>${escapeHtml(activity.owner || activity.actor)} · ${formatDateTime(activity.createdAt)}</span>
      </div>
    </div>
  `).join('');
}

function renderRisks() {
  const list = document.querySelector('#riskList');
  const levels = ['P1', 'P2', 'P3'];
  const labels = { P1: '必须今天处理', P2: '需要跟进', P3: '持续观察' };
  list.innerHTML = levels.map((severity) => {
    const alerts = state.alerts.filter((alert) => alert.severity === severity);
    const ownerCount = new Set(alerts.map((alert) => alert.target).filter(Boolean)).size;
    return `
      <button class="risk-summary-card risk-summary-${severity}" type="button" data-risk-level="${severity}">
        <span>${escapeHtml(severity)}</span>
        <strong>${alerts.length}</strong>
        <small>${escapeHtml(labels[severity])} · ${ownerCount} 个对象</small>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.risk-summary-card').forEach((item) => {
    item.addEventListener('click', () => {
      activeRiskTab = item.dataset.riskLevel;
      const firstAlert = state.alerts.find((alert) => alert.severity === activeRiskTab);
      selectedRiskId = firstAlert ? getRiskId(firstAlert) : '';
      renderRiskDetail();
      setRoute('risk-detail');
    });
  });
  renderRiskDetail();
}

function getRiskId(alert) {
  return alert.id || `${alert.severity || 'risk'}_${alert.title || ''}_${alert.target || ''}`.replace(/\s+/g, '_');
}

function renderRiskDetail() {
  const title = document.querySelector('#riskDetailTitle');
  const subtitle = document.querySelector('#riskDetailSubtitle');
  const content = document.querySelector('#riskDetailContent');
  if (!content) return;
  const alert = state.alerts.find((item) => getRiskId(item) === selectedRiskId) || state.alerts.find((item) => item.severity === activeRiskTab) || null;
  if (!alert) {
    if (title) title.textContent = '暂无风险';
    if (subtitle) subtitle.textContent = '当前级别没有风险项。';
    content.innerHTML = '<div class="empty-state">当前没有需要处理的风险。</div>';
    return;
  }
  selectedRiskId = getRiskId(alert);
  if (title) title.textContent = `${alert.severity} · ${alert.title}`;
  if (subtitle) subtitle.textContent = `提醒对象：${alert.target || '未指定'} · ${alert.createdAt ? formatDateTime(alert.createdAt) : '等待处理'}`;
  content.innerHTML = `
    <article class="risk-detail-card">
      <span>风险说明</span>
      <p>${escapeHtml(alert.detail || '暂无详情。')}</p>
    </article>
    <article class="risk-detail-card">
      <span>AI 判断</span>
      <p>${escapeHtml(alert.aiAnalysis?.reason || '暂无 AI 分析。')}</p>
      <p>${escapeHtml(alert.aiAnalysis?.action || '建议确认负责人、截止时间和下一次检查点。')}</p>
    </article>
    <article class="risk-detail-card">
      <span>处理动作</span>
      <div class="risk-detail-actions">
        <button type="button" data-route="assignment">去分工领取</button>
        <button type="button" data-route="reviews">去 AI 审阅</button>
        <button type="button" data-action="scan-risks">重新扫描</button>
      </div>
    </article>
  `;
  content.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => setRoute(button.dataset.route));
  });
}

function renderMembers() {
  const list = document.querySelector('#memberList');
  if (!list) return;
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

let _selectedReviewId = null;
const _reviewDetailCache = {}; // reviewId → { review, diff }，避免重复请求 GitHub

function renderReviewQueue(queue) {
  const container = document.querySelector('#reviewQueue');
  if (!container) return;
  state.reviewQueue = queue || [];
  if (!queue || !queue.length) {
    container.innerHTML = '<div class="empty-state">暂无需要人工确认的审阅项 ✅</div>';
    return;
  }
  const decisionLabel = { acknowledged: '已确认', 'needs-fix': '需修复', exempted: '已豁免' };
  container.innerHTML = queue.map((review) => {
    const levelClass = `review-${String(review.level || '').toLowerCase()}`;
    const decided = review.humanDecision;
    const isSelected = review.id === _selectedReviewId;
    return `
    <div class="review-queue-item ${levelClass}${isSelected ? ' selected' : ''}" data-review-id="${escapeHtml(review.id)}" data-action="open-review-detail">
      <div class="review-queue-info">
        <strong>${escapeHtml(review.title)}</strong>
        <span>${escapeHtml(review.owner || '未知')} · ${escapeHtml(getReviewLevelLabel(review.level))} · 分数 ${Number(review.score) || 0}</span>
      </div>
      <div class="review-queue-actions">
        ${decided
          ? `<span class="review-decided">${escapeHtml(decisionLabel[decided] || decided)}</span>`
          : `<span class="review-level-badge level-${String(review.level||'').toLowerCase()}">${escapeHtml(getReviewLevelLabel(review.level))}</span>`}
      </div>
    </div>`;
  }).join('');
}

async function loadReviewQueue() {
  const container = document.querySelector('#reviewQueue');
  const cached = readCachedReviewQueue();
  if (cached.length) renderReviewQueue(cached);
  else if (container) container.innerHTML = '<div class="empty-state">加载中...</div>';
  const data = await api('/api/reviews/queue');
  renderReviewQueue(data.queue || []);
  writeCachedReviewQueue(data.queue || []);
  if (data.pendingCount) toast(`待处理 Block/Escalate：${data.pendingCount} 条`);
}

function readCachedReviewQueue() {
  try {
    return JSON.parse(sessionStorage.getItem('cueReviewQueue') || '[]');
  } catch {
    return [];
  }
}

function writeCachedReviewQueue(queue) {
  try {
    sessionStorage.setItem('cueReviewQueue', JSON.stringify(queue || []));
  } catch {
    // ignore storage failures
  }
}

async function openReviewDetail(reviewId) {
  _selectedReviewId = reviewId;
  // 高亮选中项
  document.querySelectorAll('#reviewQueue .review-queue-item').forEach((el) => {
    el.classList.toggle('selected', el.dataset.reviewId === reviewId);
  });

  const panel = document.querySelector('#reviewDetailContent');
  const headTitle = document.querySelector('#reviewDetailHeadTitle');
  if (!panel) return;

  // 命中缓存则无需 loading，直接渲染
  if (!_reviewDetailCache[reviewId]) {
    panel.innerHTML = '<div class="empty-state">加载中...</div>';
    const data = await api(`/api/reviews/${encodeURIComponent(reviewId)}`);
    _reviewDetailCache[reviewId] = data;
  }
  const { review, diff } = _reviewDetailCache[reviewId];
  if (headTitle) headTitle.textContent = (review.shortSha || reviewId.slice(-7)) + ' · ' + (review.title || '').slice(0, 28);

  const levelLower = String(review.level || '').toLowerCase();
  const decided = review.humanDecision;
  const membersOptions = (state.members || []).map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`).join('');

  const diffHtml = diff
    ? diff.split('\n').map((line) => {
        if (line.startsWith('+')) return `<span class="diff-add">${escapeHtml(line)}</span>`;
        if (line.startsWith('-')) return `<span class="diff-del">${escapeHtml(line)}</span>`;
        return escapeHtml(line);
      }).join('\n')
    : null;

  panel.innerHTML = `
    <div class="review-detail-body">
      <div class="review-detail-meta">
        <span class="review-level-badge level-${levelLower}">${escapeHtml(getReviewLevelLabel(review.level))}</span>
        <span class="review-meta-chip">分数 ${Number(review.score) || 0}/100</span>
        <span class="review-meta-chip">作者：${escapeHtml(review.owner || review.actor || '未知')}</span>
        ${review.shortSha ? `<span class="review-meta-chip">${escapeHtml(review.shortSha)}</span>` : ''}
        ${review.commitUrl ? `<span class="review-meta-chip"><a href="${escapeHtml(review.commitUrl)}" target="_blank">查看 GitHub ↗</a></span>` : ''}
        <span class="review-meta-chip">${new Date(review.createdAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>

      <div>
        <div class="review-section-label">提交标题</div>
        <div class="review-suggestion">${escapeHtml(review.title || '—')}</div>
      </div>

      ${(review.files || []).length ? `
      <div>
        <div class="review-section-label">变更文件（${review.files.length} 个）</div>
        <div class="review-suggestion" style="font-size:12px">${review.files.slice(0,8).map(escapeHtml).join('<br>')}</div>
      </div>` : ''}

      <div>
        <div class="review-section-label">AI 发现的问题</div>
        <div class="review-findings">
          ${(review.findings || ['无明显问题']).map((f) => `<div class="review-finding-item">${escapeHtml(f)}</div>`).join('')}
        </div>
      </div>

      ${review.suggestion ? `
      <div>
        <div class="review-section-label">AI 建议</div>
        <div class="review-suggestion">${escapeHtml(review.suggestion)}</div>
      </div>` : ''}

      ${diffHtml ? `
      <div>
        <div class="review-section-label">
          Diff
          <button class="review-diff-toggle" onclick="this.parentElement.nextElementSibling.style.display=this.parentElement.nextElementSibling.style.display==='none'?'block':'none';this.textContent=this.textContent.includes('展开')?'收起 diff':'展开 diff'">展开 diff</button>
        </div>
        <div class="review-diff-block" style="display:none"><pre>${diffHtml}</pre></div>
      </div>` : ''}

      ${decided ? `
      <div class="review-decision-area">
        <div style="font-size:13px;color:var(--text-dim)">已处理：${{ acknowledged: '已确认', 'needs-fix': '需修复', exempted: '已豁免（通过）' }[decided] || decided}</div>
        ${review.humanNote ? `<div style="font-size:12px;color:var(--text-dim)">备注：${escapeHtml(review.humanNote)}</div>` : ''}
        ${review.resolvedTaskId ? `<div style="font-size:12px;color:var(--accent)">已建任务：${escapeHtml(review.resolvedTaskId)}</div>` : ''}
      </div>` : `
      <div>
        <div class="review-section-label">
          解决方案
          <button class="btn-sm" id="btnLoadSolutions" onclick="loadReviewSolutions('${escapeHtml(reviewId)}')">AI 生成方案</button>
        </div>
        <div id="solutionsContainer">${(() => {
          const cached = _reviewDetailCache[reviewId]?.solutions;
          if (cached?.length) {
            return `<div class="review-solutions">${cached.map((s, i) => `
              <div class="review-solution-card${s.recommended ? ' recommended' : ''}" data-solution-idx="${i}" onclick="selectSolution(this,${i})">
                <div class="review-solution-title">${escapeHtml(s.title)}</div>
                <div class="review-solution-detail">${escapeHtml(s.detail)}</div>
                <div class="review-solution-effort">预计工作量：${escapeHtml(s.effort||'未知')}</div>
              </div>`).join('')}</div>`;
          }
          return '<div style="font-size:13px;color:var(--text-dim)">点击「AI 生成方案」获取 2-3 个具体解决方案</div>';
        })()}</div>
      </div>

      <div class="review-decision-area" id="reviewDecisionArea">
        <div class="review-decision-row">
          <button class="btn-sm btn-resolve-pass" onclick="resolveReview('${escapeHtml(reviewId)}','pass')">✓ 通过</button>
          <button class="btn-sm btn-resolve-fix" onclick="resolveReview('${escapeHtml(reviewId)}','needs-fix')">↩ 打回 ${escapeHtml(review.owner || review.actor || '负责人')}</button>
        </div>
      </div>`}
    </div>`;

  // 恢复缓存的 solutions dataset，确保 selectSolution 能读取
  const cachedSols = _reviewDetailCache[reviewId]?.solutions;
  if (cachedSols?.length) {
    const sc = document.querySelector('#solutionsContainer');
    if (sc) sc.dataset.solutions = JSON.stringify(cachedSols);
  }
}

let _selectedSolution = null;

async function loadReviewSolutions(reviewId) {
  const btn = document.querySelector('#btnLoadSolutions');
  const container = document.querySelector('#solutionsContainer');
  if (btn) { btn.disabled = true; btn.textContent = '生成中...'; }
  if (container) container.innerHTML = '<div style="font-size:13px;color:var(--text-dim)">AI 正在分析...</div>';

  try {
    const data = await api(`/api/reviews/${encodeURIComponent(reviewId)}/solutions`, { method: 'POST' });
    const solutions = data?.solutions || [];
    _selectedSolution = null;
    // 存进缓存，重新打开时恢复
    if (_reviewDetailCache[reviewId]) _reviewDetailCache[reviewId].solutions = solutions;

    if (container) {
      if (!solutions.length) {
        container.innerHTML = '<div style="font-size:13px;color:var(--text-dim)">AI 未能生成方案，请检查 API 配置</div>';
      } else {
        container.innerHTML = `<div class="review-solutions">${solutions.map((s, i) => `
          <div class="review-solution-card${s.recommended ? ' recommended' : ''}" data-solution-idx="${i}" onclick="selectSolution(this, ${i})">
            <div class="review-solution-title">${escapeHtml(s.title)}</div>
            <div class="review-solution-detail">${escapeHtml(s.detail)}</div>
            <div class="review-solution-effort">预计工作量：${escapeHtml(s.effort || '未知')}</div>
          </div>`).join('')}
        </div>`;
        container.dataset.solutions = JSON.stringify(solutions);
      }
    }
  } catch (err) {
    toast(err.message || 'AI 生成方案失败');
    if (container) container.innerHTML = '<div style="font-size:13px;color:var(--text-dim)">生成失败，请重试</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AI 生成方案'; }
  }
}

function selectSolution(el, idx) {
  document.querySelectorAll('.review-solution-card').forEach((c) => c.classList.remove('selected'));
  el.classList.add('selected');
  const solutions = JSON.parse(document.querySelector('#solutionsContainer')?.dataset.solutions || '[]');
  _selectedSolution = solutions[idx] || null;
}

async function resolveReview(reviewId, decision) {
  // 自动用原负责人，无需手动选择
  const review = _reviewDetailCache[reviewId]?.review;
  const assignee = review?.owner || review?.actor || '';
  const payload = {
    decision,
    solution: _selectedSolution?.detail || '',
    solutionTitle: _selectedSolution?.title || '',
    assignee
  };
  const result = await api(`/api/reviews/${encodeURIComponent(reviewId)}/resolve`, {
    method: 'POST', body: JSON.stringify(payload)
  });
  toast(decision === 'pass' ? '已通过（无需解决）' : `已建任务：${result.task?.title || '跟进任务'}`);
  _selectedSolution = null;
  delete _reviewDetailCache[reviewId]; // 决策后清缓存，下次重新拉最新状态
  await loadReviewQueue();
  await openReviewDetail(reviewId);
  if (result.task) {
    state.tasks = [result.task, ...state.tasks];
    renderTasks();
  }
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
  const normalizedCriteria = (brief.acceptanceCriteria || []).filter((item) => !isPlaceholderAcceptance(item));
  const steps = (brief.steps || []).slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const criteria = normalizedCriteria.slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
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
          <ul>${criteria || '<li>进入任务详情查看所属交付项验收口径。</li>'}</ul>
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

function withTaskAcceptanceBrief(brief, task) {
  if (!brief) return brief;
  const criteria = (brief.acceptanceCriteria || []).filter((item) => !isPlaceholderAcceptance(item));
  if (criteria.length) return brief;
  return {
    ...brief,
    acceptanceCriteria: [
      getTaskAcceptance(task),
      '有 commit、PR、截图、接口返回或文档链接中的至少一种证据。',
      '能说明已完成、未完成和阻塞项，便于晚会重新分配。'
    ].filter((item) => !isPlaceholderAcceptance(item))
  };
}

function renderBriefBlock(brief, hasAssignment, assignmentDone = false, assignmentId = null, briefAge = 0) {
  if (!brief) {
    if (!hasAssignment) {
      return '<div class="empty-state">还没有认领记录，在分工领取页点击名字认领后自动生成。</div>';
    }
    if (assignmentDone) {
      return '<div class="empty-state">任务已完成，细则未留存（认领时生成失败或为历史记录）。</div>';
    }
    if (briefAge > 30_000) {
      return `<div class="brief-failed">
        <span>细则生成失败</span>
        ${assignmentId ? `<button onclick="window.__briefRetry('${escapeHtml(assignmentId)}')" style="font-size:12px;padding:3px 10px;border-radius:4px;border:1px solid var(--red);background:transparent;color:var(--red);cursor:pointer;">重新生成</button>` : ''}
      </div>`;
    }
    return '<div class="brief-generating"><span class="brief-spinner"></span>任务细则生成中，稍等片刻后刷新页面…</div>';
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
  const deliverable = getDeliverableForTask(task);
  const latestAssignment = evidence.assignments[0] || null;
  const brief = latestAssignment?.brief || null;
  const hasAssignment = Boolean(latestAssignment);
  const assignmentDone = latestAssignment?.status === '已完成' || task.status === '已完成';
  const briefAge = latestAssignment ? Date.now() - new Date(latestAssignment.createdAt || 0).getTime() : 0;
  const progress = Number(task.progress) || 0;
  const progressSource = task.progressSource || (task.completionSource ? 'manual' : 'auto');
  const progressSourceLabel = progressSource === 'manual' ? '人工确认' : '自动进度';
  if (title) title.textContent = task.title;
  if (subtitle) {
    subtitle.textContent = `${task.owner || '未指定'} · ${task.status || '未知状态'} · 风险 ${task.risk || '未设置'} · 截止 ${task.due || task.dueDate || '未设置'}`;
  }

  content.innerHTML = `
    <article class="task-detail-card task-detail-overview">
      <span>任务状态 · ${progressSourceLabel}</span>
      <div class="task-detail-status">
        <strong>${progress}%</strong>
        <div class="progress"><i style="width:${progress}%"></i></div>
      </div>
      <p>${escapeHtml(task.description || task.signal || '暂无任务描述。')}</p>
      <dl>
        <div><dt>负责人</dt><dd>${escapeHtml(task.owner || '未指定')}</dd></div>
        <div><dt>所属交付项</dt><dd>${escapeHtml(deliverable?.title || task.deliverableId || '未绑定')}</dd></div>
        <div><dt>来源</dt><dd>${escapeHtml(task.sourceDoc || task.repo || '任务看板')}</dd></div>
        <div><dt>验收</dt><dd>${escapeHtml(getTaskAcceptance(task))}</dd></div>
      </dl>
      ${deliverable?.docSuggestComplete ? `<div class="task-doc-suggest">
        <strong>文档侧建议完成</strong>
        <span>目标仓库进度文档已将所属交付项标记为完成。请先在这里确认任务完成，再由负责人确认交付项。</span>
      </div>` : ''}
      <div class="task-detail-actions">
        ${latestAssignment && latestAssignment.status !== '已完成'
          ? `<button class="task-confirm-done-btn" data-assignment-id="${escapeHtml(latestAssignment.id)}">确认任务完成</button>`
          : task.status !== '已完成'
            ? '<button class="task-confirm-done-btn" data-task-only="true">确认任务完成</button>'
            : '<span class="task-done-mark">任务已完成</span>'}
      </div>
    </article>

    <article class="task-detail-card task-detail-main">
      <span>结构化任务规则</span>
      ${renderBriefBlock(brief, hasAssignment, assignmentDone, latestAssignment?.id, briefAge)}
    </article>

    ${(() => {
      const sug = task.aiProgressSuggestion;
      if (!sug) return '';
      const updatedAt = sug.updatedAt ? new Date(sug.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      const aiProgress = Math.max(0, Math.min(100, Number(sug.progress) || 0));
      const systemProgress = Math.max(0, Math.min(100, Number(sug.appliedProgress ?? task.progress) || 0));
      const isManualProgress = progressSource === 'manual';
      const progressLabel = isManualProgress && aiProgress !== systemProgress
        ? `AI复核 ${aiProgress}% / 人工确认 ${systemProgress}%`
        : `${systemProgress}%`;
      return `<article class="task-detail-card task-ai-progress-card">
      <span>${isManualProgress ? 'AI 进度复核' : '自动进度判断'} · ${progressLabel} <small>${updatedAt}</small></span>
      ${isManualProgress && aiProgress !== systemProgress ? '<p class="ai-progress-note">人工确认进度不会被 AI 自动调低；AI 估算仅作为复核参考。</p>' : ''}
      ${sug.reason ? `<p class="ai-progress-reason"><strong>判断依据：</strong>${escapeHtml(sug.reason)}</p>` : ''}
      ${sug.hint ? `<p class="ai-progress-hint"><strong>提高进度需补充：</strong>${escapeHtml(sug.hint)}</p>` : ''}
      ${sug.suggestComplete ? '<p class="ai-progress-suggest">AI 建议标记为已完成，请在分工领取中确认。</p>' : ''}
    </article>`;
    })()}

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

  content.querySelectorAll('.task-confirm-done-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.assignmentId) {
        markAssignmentDone(btn.dataset.assignmentId).catch((e) => toast(e.message));
      } else {
        markTaskDone(task.id).catch((e) => toast(e.message));
      }
    });
  });
}

async function regenerateBrief(assignmentId) {
  console.log('[Brief] Step 2 — assignmentId:', assignmentId);
  if (!assignmentId || assignmentId === 'undefined') {
    toast('❌ [2/5] assignmentId 为空，无法请求');
    return;
  }
  toast('[2/5] assignmentId 确认: ' + assignmentId.slice(0, 16));

  const btn = document.querySelector(`[data-action="brief-retry"][data-assignment-id="${CSS.escape(assignmentId)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }

  try {
    console.log('[Brief] Step 3 — 发起 API 请求...');
    toast('[3/5] 发起 API 请求中...');
    const payload = await api(`/api/assignments/${encodeURIComponent(assignmentId)}/brief`, { method: 'POST' });
    console.log('[Brief] Step 3 ✅ API 响应:', payload?.message);
    toast('[3/5] ✅ API 响应: ' + (payload?.message || 'ok'));

    toast('[4/5] 开始轮询（最多 20 秒）...');
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      console.log(`[Brief] Step 4 — 第 ${i + 1} 次轮询...`);
      const data = await api('/api/state');
      state.assignments = data.assignments || state.assignments;
      state.tasks = data.tasks || state.tasks;
      const a = (state.assignments || []).find((x) => x.id === assignmentId);
      console.log('[Brief] 轮询结果 brief:', a?.brief ? '有' : '无');
      if (a?.brief) {
        renderTaskDetail();
        toast('[5/5] ✅ 任务细则已生成！');
        return;
      }
    }
    renderTaskDetail();
    toast('⚠️ [5/5] 生成超时，请手动刷新页面');
  } catch (err) {
    console.error('[Brief] ❌ 请求异常:', err);
    throw err;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新生成'; }
  }
}

function switchAssignTab(tabName) {
  document.querySelectorAll('.assign-tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.assign-tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
  });
}

function renderAssignments() {
  const today = getTodayText();
  const todayAssignments = getTodayAssignments();
  const activeTasks = getAssignableTaskPool();
  const focusedTasks = getFocusedAssignmentTasks(30);
  setOptions('#assignmentOwner', state.members, (member) => member.name, (member) => `${member.name} · ${member.role}`);
  setOptions('#assignmentTask', focusedTasks.length ? focusedTasks : activeTasks, (task) => task.id, (task) => `${task.title} · ${task.owner} · ${task.progress}%`);

  // 近期认领情况（今天 + 昨天未完成的延续）
  const recentAssignments = getRecentAssignments();

  // Tab 1 排除集：近 3 天内有过非取消认领的任务（含已完成认领），防止任务次日重现
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const cutoffDate = threeDaysAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const claimedActiveTaskIds = new Set(
    (state.assignments || [])
      .filter((a) => a.date >= cutoffDate && a.status !== '已取消')
      .map((a) => a.taskId)
  );
  const activeAssignments = recentAssignments.filter((a) => a.status !== '已完成');
  const completedTodayAssignments = recentAssignments.filter((a) => a.date === today && a.status === '已完成');
  // 18:00 后隐藏已完成区域
  const nowHour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false });
  const meetingHour = Number(state.config?.meetingHour ?? 18);
  const pastMeeting = Number(nowHour) >= meetingHour;

  function renderAssignGroup(assignments, showDoneBtn) {
    const byOwner = {};
    for (const a of assignments) {
      if (!byOwner[a.owner]) byOwner[a.owner] = [];
      byOwner[a.owner].push(a);
    }
    return Object.entries(byOwner).map(([owner, items]) => `
      <div class="assign-group">
        <strong class="assign-owner">${escapeHtml(owner)}</strong>
        ${items.map((a) => {
          const linkedTask = (state.tasks || []).find((t) => t.id === a.taskId);
          const aiSug = linkedTask?.aiProgressSuggestion;
          const showAiSuggest = showDoneBtn && a.status !== '已完成' && aiSug?.suggestComplete;
          const taskId = linkedTask?.id || a.taskId || '';
          return `
          <div class="assign-item assign-${escapeHtml(a.status || '进行中')}">
            ${taskId
              ? `<button class="assign-title assign-task-link" type="button" data-task-id="${escapeHtml(taskId)}">${escapeHtml(a.taskTitle || linkedTask?.title || '未知任务')}</button>`
              : `<span class="assign-title">${escapeHtml(a.taskTitle || '未知任务')}</span>`}
            <span class="assign-status-badge">${escapeHtml(a.status || '进行中')}</span>
            ${linkedTask ? `<span class="assign-progress-badge">${linkedTask.progress || 0}%</span>` : ''}
            ${a.date !== today ? `<span class="assign-carryover-badge">续 ${a.date}</span>` : ''}
            ${a.note ? `<small class="assign-note">${escapeHtml(a.note)}</small>` : ''}
            ${showAiSuggest ? `<div class="assign-ai-hint">🤖 AI 判断完成度 ${aiSug.progress}%：${escapeHtml(aiSug.reason)}</div>` : ''}
            ${renderAssignmentBrief(withTaskAcceptanceBrief(a.brief, linkedTask))}
            <div class="assign-actions">
              ${showDoneBtn && a.status !== '已完成' && !showAiSuggest ? `<button class="assign-done-btn" data-assign-id="${escapeHtml(a.id)}" title="标记完成">✓</button>` : ''}
              ${showAiSuggest ? `<button class="assign-ai-done-btn" data-assign-id="${escapeHtml(a.id)}" title="确认 AI 建议：标记完成">✓ 确认完成</button>` : ''}
              <button class="assign-cancel-btn" data-assign-id="${escapeHtml(a.id)}" title="取消认领">✕</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    `).join('');
  }

  // 更新 Tab 2 徽章数
  const badgeEl = document.querySelector('#assignClaimedCount');
  if (badgeEl) badgeEl.textContent = activeAssignments.length || '';

  const summaryEl = document.querySelector('#assignmentSummary');
  if (summaryEl) {
    if (!activeAssignments.length && !completedTodayAssignments.length) {
      summaryEl.innerHTML = '<div class="empty-state">今日暂无认领记录。</div>';
    } else {
      const activeHtml = activeAssignments.length
        ? renderAssignGroup(activeAssignments, true)
        : '<div class="empty-state">暂无进行中的认领。</div>';

      const completedHtml = !pastMeeting && completedTodayAssignments.length
        ? `<details class="assign-completed-section" open>
            <summary class="assign-completed-toggle">今日已完成 ${completedTodayAssignments.length} 项</summary>
            ${renderAssignGroup(completedTodayAssignments, false)}
          </details>`
        : '';

      summaryEl.innerHTML = activeHtml + completedHtml;

      summaryEl.querySelectorAll('.assign-done-btn').forEach((btn) => {
        btn.addEventListener('click', () => markAssignmentDone(btn.dataset.assignId).catch((e) => toast(e.message)));
      });
      summaryEl.querySelectorAll('.assign-ai-done-btn').forEach((btn) => {
        btn.addEventListener('click', () => markAssignmentDone(btn.dataset.assignId).catch((e) => toast(e.message)));
      });
      summaryEl.querySelectorAll('.assign-cancel-btn').forEach((btn) => {
        btn.addEventListener('click', () => cancelAssignment(btn.dataset.assignId).catch((e) => toast(e.message)));
      });
      summaryEl.querySelectorAll('.assign-task-link').forEach((btn) => {
        btn.addEventListener('click', () => openTaskDetail(btn.dataset.taskId));
      });
    }
  }

  // 可认领任务列表（已被今日进行中认领的任务移至 Tab 2，此处不显示）
  const assignableEl = document.querySelector('#assignableList');
  if (assignableEl) {
    const suggestTasks = focusedTasks.filter((task) => !claimedActiveTaskIds.has(task.id));
    if (!suggestTasks.length) {
      assignableEl.innerHTML = '<div class="empty-state">今日建议任务已全部认领，在「已认领 / 未完成」查看进度。</div>';
    } else {
      assignableEl.innerHTML = `
        <div class="assignment-focus-note">
          <strong>建议优先认领</strong>
          <span>共 ${activeTasks.length} 个进行中任务，排除已认领后展示 ${suggestTasks.length} 个。</span>
        </div>
        ${suggestTasks.map((task) => {
        const claimants = todayAssignments.filter((a) => a.taskId === task.id);
        const claimedOwners = new Set(claimants.map((a) => a.owner));
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
            </div>
            <div class="claim-member-btns">
              ${state.members.map((m) => `
                <button class="claim-member-btn ${claimedOwners.has(m.name) ? 'claimed' : ''}"
                  data-task-id="${escapeHtml(task.id)}"
                  data-task-title="${escapeHtml(task.title)}"
                  data-owner="${escapeHtml(m.name)}"
                  ${claimedOwners.has(m.name) ? 'disabled title="已认领"' : ''}>
                  ${escapeHtml(m.name)}${claimedOwners.has(m.name) ? ' ✓' : ''}
                </button>`).join('')}
            </div>
          </div>
        `;
      }).join('')}`;

      assignableEl.querySelectorAll('.claim-member-btn:not([disabled])').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          // 立即禁用 + 乐观显示已认领
          btn.disabled = true;
          btn.classList.add('claimed');
          btn.textContent = `${btn.dataset.owner} ✓`;
          claimTask(btn.dataset.taskId, btn.dataset.taskTitle, btn.dataset.owner).then(() => {
            switchAssignTab('claimed');
          }).catch((e) => {
            // 失败时回滚按钮状态
            btn.disabled = false;
            btn.classList.remove('claimed');
            btn.textContent = btn.dataset.owner;
            toast(e.message);
          });
        });
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

function renderAiPm() {
  const summary = document.querySelector('#aiPmSummary');
  const approvalList = document.querySelector('#aiPmApprovalList');
  const autoList = document.querySelector('#aiPmAutoList');
  const triggerList = document.querySelector('#aiPmTriggerList');
  if (!summary || !approvalList || !autoList || !triggerList) return;

  const adjustments = state.planAdjustments || [];
  const pending = adjustments.filter((item) => item.status === 'pending_approval' || item.scope === 'major');
  const auto = adjustments.filter((item) => (
    item.status === 'auto_applied'
    || item.mode === 'auto'
    || item.scope === 'minor'
    || item.scope === 'progress'
    || (!item.scope && item.suggestion)
  ));
  const progress = adjustments.filter((item) => item.scope === 'progress');
  const latest = adjustments[0]?.createdAt ? formatDateTime(adjustments[0].createdAt) : '暂无';

  summary.innerHTML = `
    <div><span>待审批大调整</span><b>${pending.filter((item) => item.status !== 'approved' && item.status !== 'rejected').length}</b></div>
    <div><span>自动小调整</span><b>${auto.filter((item) => item.scope === 'minor').length}</b></div>
    <div><span>进度同步</span><b>${progress.length}</b></div>
    <div><span>最近触发</span><b>${escapeHtml(latest)}</b></div>
  `;

  approvalList.innerHTML = pending.length ? pending.map((item) => {
    const isDone = item.status === 'approved' || item.status === 'rejected';
    const statusLabel = item.status === 'approved' ? (item.selectedAlternativeTitle ? `已批准·${item.selectedAlternativeTitle}` : '已批准') : item.status === 'rejected' ? '不更改' : '待审批';
    return `
    <div class="ai-pm-item ai-pm-major" data-adjust-id="${escapeHtml(item.id)}">
      <div class="ai-pm-item-head">
        <strong>${escapeHtml(item.summary || '大的开发计划调整')}</strong>
        <span>${escapeHtml(statusLabel)}</span>
      </div>
      <p>${escapeHtml(item.suggestion || '')}</p>
      ${renderStageUpdateMeta(item.stageUpdate)}
      <small>${escapeHtml(item.requiresApprovalReason || item.impact || '影响阶段目标、负责人或排期，需要人工审批。')}</small>
      <div class="ai-pm-actions">
        <button type="button" data-action="approve-plan-adjustment" data-adjust-id="${escapeHtml(item.id)}" ${isDone ? 'disabled' : ''}>批准此方案</button>
        <button type="button" data-action="reject-plan-adjustment" data-adjust-id="${escapeHtml(item.id)}" ${isDone ? 'disabled' : ''}>不更改</button>
        ${!isDone ? `<button type="button" data-action="more-plan-options" data-adjust-id="${escapeHtml(item.id)}">更多方案</button>` : ''}
      </div>
      <div class="ai-pm-alternatives" id="alt-${escapeHtml(item.id)}" style="display:none"></div>
    </div>
  `}).join('') : '<div class="empty-state">暂无待审批调整。大的阶段计划变化会出现在这里。</div>';

  autoList.innerHTML = auto.length ? auto.slice(0, 8).map((item) => `
    <div class="ai-pm-item">
      <div class="ai-pm-item-head">
        <strong>${escapeHtml(item.summary || (item.scope === 'progress' ? '进度同步' : '小调整'))}</strong>
        <span>${escapeHtml(item.scope === 'progress' ? '进度' : '自动')}</span>
      </div>
      <p>${escapeHtml(item.suggestion || '')}</p>
      ${renderStageUpdateMeta(item.stageUpdate)}
      <small>${escapeHtml(item.costReason || item.impact || '')}</small>
    </div>
  `).join('') : '<div class="empty-state">暂无自动调整记录。新 commit 到达后，AI PM 会批量判断并自动记录小调整。</div>';

  const commits = (state.activities || []).filter((activity) => activity.type === 'commit').slice(0, 8);
  triggerList.innerHTML = commits.length ? commits.map((activity) => `
    <div class="ai-pm-trigger">
      <strong>${escapeHtml(activity.owner || activity.actor || '未知')}</strong>
      <span>${escapeHtml(activity.title || activity.message || activity.id)}</span>
      <small>${escapeHtml(activity.repo || '')} · ${formatDateTime(activity.createdAt || activity.date)}</small>
    </div>
  `).join('') : '<div class="empty-state">等待 GitHub Webhook 或手动同步提交。</div>';

  approvalList.querySelectorAll('[data-action="approve-plan-adjustment"]').forEach((button) => {
    button.addEventListener('click', () => decidePlanAdjustment(button.dataset.adjustId, 'approved').catch((e) => toast(e.message)));
  });
  approvalList.querySelectorAll('[data-action="reject-plan-adjustment"]').forEach((button) => {
    button.addEventListener('click', () => decidePlanAdjustment(button.dataset.adjustId, 'rejected').catch((e) => toast(e.message)));
  });
  approvalList.querySelectorAll('[data-action="more-plan-options"]').forEach((button) => {
    button.addEventListener('click', () => loadPlanAlternatives(button.dataset.adjustId, button).catch((e) => toast(e.message)));
  });
}

async function loadPlanAlternatives(id, triggerBtn) {
  const container = document.getElementById(`alt-${id}`);
  if (!container) return;
  if (container.style.display !== 'none') { container.style.display = 'none'; return; }
  triggerBtn.disabled = true;
  triggerBtn.textContent = '生成中…';
  try {
    const data = await api(`/api/plan-adjustments/${encodeURIComponent(id)}/alternatives`, { method: 'POST', body: '{}' });
    const alts = data.alternatives || [];
    if (!alts.length) { toast('暂无可用备选方案（需要 Claude API）'); return; }
    container.innerHTML = alts.map((opt) => `
      <div class="ai-pm-alt-card">
        <div class="ai-pm-alt-head">
          <strong>${escapeHtml(opt.title)}</strong>
          <span class="risk-badge risk-${escapeHtml(opt.risk)}">${escapeHtml(opt.risk)}风险</span>
        </div>
        <p>${escapeHtml(opt.approach)}</p>
        <small>${escapeHtml(opt.impact)}</small>
        <button type="button" class="ai-pm-alt-select"
          data-adjust-id="${escapeHtml(id)}"
          data-alt='${JSON.stringify(opt).replace(/'/g, "&#39;")}'>选此方案</button>
      </div>
    `).join('');
    container.style.display = 'block';
    container.querySelectorAll('.ai-pm-alt-select').forEach((btn) => {
      btn.addEventListener('click', () => {
        const alt = JSON.parse(btn.dataset.alt);
        decidePlanAdjustment(btn.dataset.adjustId, 'approved', alt).catch((e) => toast(e.message));
      });
    });
    triggerBtn.textContent = '收起';
  } finally {
    triggerBtn.disabled = false;
  }
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

function renderMeetingAssignments() {
  const list = document.querySelector('#meetingAssignmentList');
  if (!list) return;
  const date = getMeetingDate();
  const assignments = state.assignments.filter((assignment) => assignment.date === date);
  if (!assignments.length) {
    list.innerHTML = '<div class="empty-state">会后还没有领取记录。成员在企微领取后会同步到这里，也可以临时手动补录。</div>';
    return;
  }

  const groups = assignments.reduce((acc, assignment) => {
    acc[assignment.owner] = acc[assignment.owner] || [];
    acc[assignment.owner].push(assignment);
    return acc;
  }, {});

  list.innerHTML = Object.entries(groups).map(([owner, items]) => `
    <div class="meeting-owner-assignments">
      <strong>${escapeHtml(owner)}</strong>
      ${items.map((assignment) => `
        <div class="meeting-assignment-row">
          <span>${escapeHtml(assignment.taskTitle || assignment.taskId)}</span>
          <small>${escapeHtml(assignment.status || '进行中')} · ${escapeHtml(assignment.wecomStatus || '已记录')} · ${formatDateTime(assignment.updatedAt || assignment.createdAt)}</small>
          ${assignment.note ? `<p>${escapeHtml(assignment.note)}</p>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');
}

function renderMeetingReport() {
  const reportBox = document.querySelector('#meetingEveningReport');
  const summary = document.querySelector('#meetingReportSummary');
  if (!reportBox || !summary) return;
  const date = getMeetingDate();
  const reportEntry = state.eveningReports?.[date];
  const reportMarkdown = typeof reportEntry === 'string'
    ? reportEntry
    : reportEntry?.report || state.eveningReport || '';
  const reportSummary = typeof reportEntry === 'object' ? reportEntry.summary || {} : {};
  const { previousDate, start, end, attendanceStart, attendanceEnd } = getMeetingWindow(date);
  const windowText = `${formatDateTime(start)} - ${formatDateTime(reportEntry?.window?.to || end)}`;
  setText('#meetingWindowText', `自动获取 ${previousDate} 18:00 到当前的提交、Review、领取和企微晚会打卡信号。打卡窗口：18:30-19:00。`);

  if (!reportMarkdown) {
    const dateAssignments = state.assignments.filter((item) => item.date === date);
    const commits = state.activities.filter((activity) => {
      const createdAt = new Date(activity.createdAt || activity.date || '');
      return activity.type === 'commit' && createdAt >= start && createdAt <= end;
    });
    const attendance = state.standups.filter((standup) => {
      const createdAt = new Date(standup.createdAt || '');
      return standup.date === date && createdAt >= attendanceStart && createdAt <= attendanceEnd;
    });
    summary.innerHTML = `
      <div><span>对账窗口</span><b>${escapeHtml(windowText)}</b></div>
      <div><span>当前提交</span><b>${commits.length}</b></div>
      <div><span>晚会打卡</span><b>${attendance.length}/${state.members.length || 0}</b></div>
      <div><span>会后领取</span><b>${dateAssignments.length}</b></div>
      <div><span>会后跟进</span><b>待生成</b></div>
    `;
    reportBox.textContent = '点击「生成晚会对账」后，系统会用昨晚 18:00 至当前的 GitHub 提交、AI Review、企微打卡和任务领取生成会后跟进建议。';
    return;
  }

  summary.innerHTML = `
    <div><span>对账窗口</span><b>${escapeHtml(windowText)}</b></div>
    <div><span>Git 提交</span><b>${Number(reportSummary.commitCount) || 0}</b></div>
    <div><span>Block Review</span><b>${Number(reportSummary.blockReviewCount) || 0}</b></div>
    <div><span>无提交支撑</span><b>${Number(reportSummary.noCommitAssignmentCount) || 0}</b></div>
    <div><span>会后跟进</span><b>${Number(reportSummary.nextTargetCount) || 0}</b></div>
  `;
  setText('#meetingStageProgress', `阶段进度 ${Number(reportSummary.stageProgress) || Number(state.currentStage?.progress) || 0}%`);
  reportBox.textContent = reportMarkdown;
}

function renderMeetingReconciliation() {
  const list = document.querySelector('#meetingReconciliationList');
  if (!list) return;
  const reportEntry = state.eveningReports?.[getMeetingDate()];
  const rows = typeof reportEntry === 'object' ? reportEntry.reconciliation || [] : [];
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">暂无自动对账结果。先生成晚会对账后，这里会展示昨日领取任务和当前提交支撑。</div>';
    return;
  }

  list.innerHTML = rows.map((row) => `
    <div class="meeting-reconcile-row">
      <div>
        <strong>${escapeHtml(row.owner)}</strong>
        <span>${escapeHtml(row.taskTitle || row.taskId)}</span>
      </div>
      <div class="meeting-reconcile-status">
        <b class="${row.completed ? 'ok' : row.commitCount > 0 ? 'warn' : 'danger'}">${escapeHtml(row.result)}</b>
        <small>${Number(row.commitCount) || 0} 条提交支撑</small>
      </div>
    </div>
  `).join('');
}

function renderMeetingAttendance() {
  const list = document.querySelector('#meetingAttendanceList');
  if (!list) return;
  const date = getMeetingDate();
  const { attendanceStart, attendanceEnd } = getMeetingWindow(date);
  const standups = state.standups.filter((standup) => standup.date === date);
  const byOwner = new Map(standups.map((standup) => [standup.owner, standup]));
  const members = state.members.length ? state.members : standups.map((standup) => ({ name: standup.owner, role: '' }));

  if (!members.length) {
    list.innerHTML = '<div class="empty-state">暂无成员数据。</div>';
    return;
  }

  list.innerHTML = members.map((member) => {
    const standup = byOwner.get(member.name);
    const createdAt = new Date(standup?.createdAt || '');
    const checkedInWindow = standup && createdAt >= attendanceStart && createdAt <= attendanceEnd;
    const status = checkedInWindow ? '已打卡' : standup ? '窗口外上报' : '未上报';
    return `
      <div class="meeting-attendance-row ${checkedInWindow ? 'is-present' : standup ? 'is-late' : 'is-missing'}">
        <div>
          <strong>${escapeHtml(member.name)}</strong>
          <span>${escapeHtml(member.role || status)}</span>
        </div>
        <b>${status}</b>
        <small>${standup ? formatDateTime(standup.createdAt) : '18:30-19:00 未收到企微上报'}</small>
      </div>
    `;
  }).join('');
}

function renderMeetingTargets() {
  const list = document.querySelector('#meetingNextTargets');
  if (!list) return;
  const reportEntry = state.eveningReports?.[getMeetingDate()];
  const targets = typeof reportEntry === 'object' ? reportEntry.nextTargets || [] : [];
  if (!targets.length) {
    list.innerHTML = '<div class="empty-state">暂无会后跟进建议。生成晚会对账后会按缺口、提交支撑和风险自动生成。</div>';
    return;
  }

  list.innerHTML = targets.map((target) => `
    <div class="meeting-target-row">
      <div>
        <strong>${escapeHtml(target.owner || '待定')} · ${escapeHtml(target.priority || 'P2')}</strong>
        <span>${escapeHtml(target.taskTitle || '待拆分目标')}</span>
      </div>
      <p>${escapeHtml(target.reason || '晚会后跟进')}</p>
    </div>
  `).join('');
}

function renderMeeting() {
  const meetingDate = document.querySelector('#meetingDate');
  if (meetingDate && !meetingDate.value) meetingDate.value = getTodayText();
  setOptions('#meetingAssignmentOwner', state.members, (member) => member.name, (member) => `${member.name} · ${member.role}`);
  setOptions('#meetingAssignmentTask', state.tasks.filter((task) => task.status !== '已完成'), (task) => task.id, (task) => `${task.title} · ${task.owner} · ${task.progress}%`);
  renderMeetingAssignments();
  renderMeetingReport();
  renderMeetingReconciliation();
  renderMeetingAttendance();
  renderMeetingTargets();
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
  renderAiPm();
  renderMeeting();
  renderPersonalCenter();
}

// ── 业务逻辑 ─────────────────────────────────────────────────

async function loadState() {
  const storedProjectId = localStorage.getItem('cue_currentProjectId') || state.currentProjectId || '';
  const payload = await api(storedProjectId ? `/api/state?projectId=${encodeURIComponent(storedProjectId)}` : '/api/state');
  state.tasks = payload.tasks || [];
  state.members = payload.members || [];
  state.reviews = payload.reviews || [];
  state.alerts = payload.alerts || [];
  state.projects = payload.projects || [];
  syncCurrentProject(payload.currentProjectId || storedProjectId);
  state.deliverables = payload.deliverables || [];
  state.phases = payload.phases || [];
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
  state.deliverableProgress = payload.deliverableProgress || null;
  renderProjectSwitcher();
  setText('#syncStatus', `${getApiScopeLabel()} 已连接`);

  // 并行加载站会、配置、计划调整建议（assignments 已在 /api/state 全量返回，不重复拉）
  const projectQuery = getCurrentProjectId() ? `?projectId=${encodeURIComponent(getCurrentProjectId())}` : '';
  const [standupPayload, config, adjustPayload, eveningPayload, checklistPayload] = await Promise.all([
    api('/api/standups').catch(() => ({ standups: [] })),
    api('/api/config').catch(() => ({})),
    api('/api/plan-adjustments').catch(() => ({ adjustments: [] })),
    api('/api/reports/evening').catch(() => ({ report: null })),
    api(`/api/stage/checklist${projectQuery}`).catch(() => null)
  ]);

  state.standups = standupPayload.standups || [];
  state.config = config;
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

async function claimTask(taskId, taskTitle, owner) {
  if (!owner) return;
  const payload = await api('/api/assignments', {
    method: 'POST',
    body: JSON.stringify({ owner, taskId })
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
  const assignment = (state.assignments || []).find((a) => a.id === id);
  const payload = await api(`/api/assignments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: '已完成' })
  });
  state.assignments = payload.assignments || state.assignments;
  if (payload.task) {
    state.tasks = state.tasks.map((task) => task.id === payload.task.id ? payload.task : task);
  }
  renderAll();
  toast('已标记完成');

  // 完成后建议认领下一个任务
  if (assignment) {
    const today = getTodayText();
    const claimedTaskIds = new Set(
      (state.assignments || []).filter((a) => a.date === today && a.owner === assignment.owner).map((a) => a.taskId)
    );
    const nextTask = getFocusedAssignmentTasks(20).find((t) => !claimedTaskIds.has(t.id));
    if (nextTask) {
      const assignableEl = document.querySelector('#assignableList');
      const row = assignableEl?.querySelector(`[data-task-id="${CSS.escape(nextTask.id)}"]`)?.closest('.assignable-task-row');
      if (row) {
        row.classList.add('suggest-next');
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => row.classList.remove('suggest-next'), 3000);
      }
    }
  }
}

async function markTaskDone(taskId) {
  const payload = await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: '已完成',
      progress: 100,
      completionSource: 'task-detail',
      completedAt: new Date().toISOString()
    })
  });
  state.tasks = payload.tasks || state.tasks;
  renderAll();
  openTaskDetail(taskId);
  toast('任务已确认完成');
}

async function cancelAssignment(id) {
  if (!window.confirm('确认取消认领？')) return;
  const payload = await api(`/api/assignments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.assignments = payload.assignments || state.assignments;
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
  renderAiPm();
  toast('分工数据已刷新');
}

async function scanAiProgress() {
  const btn = document.querySelector('[data-action="ai-progress-scan"]');
  if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
  try {
    const payload = await api('/api/tasks/ai-progress', { method: 'POST' });
    state.tasks = payload.tasks || state.tasks;
    renderAll();
    const count = (payload.suggestions || []).length;
    toast(payload.message || (count ? `AI 分析完成，${count} 个任务建议标记完成` : 'AI 分析完成，进度已更新'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AI 分析进度'; }
  }
}

// ── 晚报 ─────────────────────────────────────────────────────────

async function generateEveningReport() {
  toast('正在同步仓库并生成晚会对账...');
  await syncCueAiGit().catch((error) => {
    toast(`仓库同步未完成，继续使用已有数据生成对账：${error.message}`);
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
  setText('#syncStatus', `晚会对账已生成 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  toast('晚会对账生成完成' + (payload.wecomSent ? '，已推送至企业微信' : ''));
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
  const projectId = getCurrentProjectId();
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
  const projectId = getCurrentProjectId();
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
  state.deliverableProgress = payload.deliverableProgress || state.deliverableProgress;
  state.semanticLinks = payload.semanticLinks || state.semanticLinks;
  state.riskAnalyses = payload.riskAnalyses || state.riskAnalyses;
  state.healthAnalysis = payload.healthAnalysis || state.healthAnalysis;
  renderAll();
  toast(payload.healthAnalysis?.nextFocus || 'AI 混合分析已刷新');
}

async function decidePlanAdjustment(id, decision, selectedAlternative = null) {
  if (!id) return;
  const body = { decision };
  if (selectedAlternative) body.selectedAlternative = selectedAlternative;
  const payload = await api(`/api/plan-adjustments/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  const nextState = await api(`/api/state?projectId=${encodeURIComponent(getCurrentProjectId())}`);
  state.planAdjustments = payload.adjustments || state.planAdjustments;
  state.currentStage = nextState.currentStage || state.currentStage;
  state.stageChecklist = nextState.stageChecklist || state.stageChecklist;
  state.deliverableProgress = nextState.deliverableProgress || state.deliverableProgress;
  state.metrics = nextState.metrics || state.metrics;
  state.alerts = nextState.alerts || state.alerts;
  renderPlanAdjustments();
  renderAiPm();
  renderStage();
  renderRoadmap();
  renderRisks();
  const label = selectedAlternative ? `已批准·${selectedAlternative.title}` : decision === 'approved' ? 'AI PM 大调整已批准' : '已选择不更改';
  toast(label);
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
  const payload = await api('/api/risks/scan', { method: 'POST', body: '{}' });
  state.alerts = payload.alerts || [];
  state.metrics = payload.metrics || state.metrics;
  await loadReviewQueue();
  toast('已触发 GitHub 同步和审阅扫描');
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
  const projectId = getCurrentProjectId();
  const project = state.projects.find((p) => p.id === projectId);
  const useGitHub = project?.githubOwner;
  const endpoint = useGitHub
    ? `/api/projects/${encodeURIComponent(projectId)}/sync-github`
    : `/api/projects/${encodeURIComponent(projectId)}/sync-local-git`;

  if (!options.silent) setText('#syncStatus', useGitHub ? '正在同步 GitHub 远端...' : '正在同步本地 Git...');
  const payload = await api(endpoint, { method: 'POST', body: '{}' });
  const nextState = await api(`/api/state?projectId=${encodeURIComponent(projectId)}`);
  state.tasks = nextState.tasks || [];
  state.members = nextState.members || [];
  state.reviews = nextState.reviews || [];
  state.alerts = payload.alerts || nextState.alerts || [];
  state.projects = nextState.projects || [];
  state.deliverables = nextState.deliverables || [];
  state.phases = nextState.phases || [];
  state.activities = nextState.activities || [];
  state.assignments = nextState.assignments || [];
  state.standups = nextState.standups || [];
  state.eveningReports = nextState.eveningReports || {};
  state.currentStage = nextState.currentStage || {};
  state.metrics = payload.metrics || nextState.metrics || {};
  state.planAdjustments = nextState.planAdjustments || state.planAdjustments;
  state.stageChecklist = nextState.stageChecklist || state.stageChecklist;
  state.deliverableProgress = nextState.deliverableProgress || state.deliverableProgress;
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

async function copyEveningReport() {
  const report = document.querySelector('#meetingEveningReport')?.textContent || state.eveningReport || '';
  if (!report || report.startsWith('点击')) {
    toast('还没有可复制的晚会对账');
    return;
  }
  await navigator.clipboard.writeText(report);
  toast('晚会对账已复制，可粘贴到企业微信');
}

async function pushEveningReportManual() {
  const report = document.querySelector('#meetingEveningReport')?.textContent || state.eveningReport || '';
  if (!report || report.startsWith('点击')) {
    toast('还没有可推送的晚会对账');
    return;
  }
  const payload = await api('/api/wecom/push', {
    method: 'POST',
    body: JSON.stringify({ content: `# 🌆 CUE 晚会作战包\n\n${report}` })
  });
  toast(payload.sent ? '晚会对账已推送至企业微信' : '推送失败，请检查 WECOM_WEBHOOK_URL');
}

function setRoute(route) {
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === route);
  });
  const parentByRoute = {
    overview: 'overview',
    roadmap: 'command',
    'ai-pm': 'command',
    meeting: 'command',
    'account-admin': 'command',
    'risk-detail': 'overview',
    planning: 'execution',
    reviews: 'execution',
    standup: 'execution',
    assignment: 'execution',
    'task-detail': 'execution',
    report: 'output',
    automation: 'output',
    'personal-center': 'personal'
  };
  const activeParent = parentByRoute[route] || route;
  document.querySelectorAll('.nav-item').forEach((item) => {
    const isRouteActive = item.dataset.route === route;
    // 一级导航按钮（无自身 route 的分组按钮）通过 data-nav-parent 匹配
    const isParentActive = item.classList.contains('nav-primary') && !item.dataset.route && item.dataset.navParent === activeParent;
    item.classList.toggle('active', isRouteActive || isParentActive);
  });
  if (route === 'account-admin') {
    renderAccountAdmin().catch((error) => toast(error.message));
  }
  if (route === 'personal-center') {
    renderPersonalCenter();
  }
}

let _briefPollTimer = null;

function openTaskDetail(taskId) {
  selectedTaskId = taskId || '';
  renderTaskDetail();
  setRoute('task-detail');
  scheduleBriefPoll();
}

function scheduleBriefPoll() {
  if (_briefPollTimer) clearTimeout(_briefPollTimer);
  const task = state.tasks.find((t) => t.id === selectedTaskId);
  if (!task) return;
  const evidence = getTaskEvidence(task);
  const latestAssignment = evidence.assignments[0] || null;
  // 无认领、已有 brief、已完成任务 → 不轮询
  if (!latestAssignment || latestAssignment.brief) return;
  if (latestAssignment.status === '已完成' || task.status === '已完成') return;
  // 创建超过 30 秒仍无 brief → 认定生成失败，停止轮询，让页面显示重试按钮
  const age = Date.now() - new Date(latestAssignment.createdAt || 0).getTime();
  if (age > 30_000) { renderTaskDetail(); return; }
  _briefPollTimer = setTimeout(async () => {
    try {
      const data = await api('/api/state');
      state.assignments = data.assignments || state.assignments;
      state.tasks = data.tasks || state.tasks;
      renderTaskDetail();
      scheduleBriefPoll();
    } catch { /* ignore */ }
  }, 4000);
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
  setLoginMode(loginMode);
  document.querySelectorAll('[data-login-mode]').forEach((button) => {
    button.addEventListener('click', () => setLoginMode(button.dataset.loginMode));
  });
  document.querySelector('[data-action="send-login-email-code"]')?.addEventListener('click', () => {
    sendLoginEmailCode().catch((error) => {
      if (error.message === 'invalid email address') setText('#loginHint', '请输入有效邮箱。');
      else if (error.message === 'email is not bound to an active account') setText('#loginHint', '该邮箱尚未绑定当前项目账号。');
      else if (error.message === 'email code sent too frequently') setText('#loginHint', '验证码发送太频繁，请稍后再试。');
      else if (error.message === 'email delivery failed') setText('#loginHint', '邮件发送失败，请检查 SMTP 配置。');
      else setText('#loginHint', error.message);
      toast(error.message);
    });
  });
  document.querySelector('#loginForm')?.addEventListener('submit', (event) => {
    login(event).catch((error) => {
      if (error.message === 'invalid credentials') setText('#loginHint', '账号或密码不正确。');
      else if (error.message === 'invalid verification code') setText('#loginHint', '验证码不正确或已过期。');
      else setText('#loginHint', error.message);
      toast(error.message);
    });
  });
  document.querySelector('#logoutBtn')?.addEventListener('click', () => {
    if (window.confirm('确认退出当前账号？将返回登录页面。')) logout();
  });
  document.querySelector('#accountSettingsBtn')?.addEventListener('click', () => {
    openAccountSettings().catch((error) => toast(error.message));
  });
  // 账号设置 modal 内事件
  document.querySelector('#accountSettingsBackdrop')?.addEventListener('click', (event) => {
    const target = event.target;
    if (target === event.currentTarget) { closeAccountSettings(); return; }
    if (target instanceof HTMLElement && target.dataset.action === 'close-account-settings') closeAccountSettings();
  });
  document.querySelector('#changePasswordForm')?.addEventListener('submit', submitChangePassword);
  document.querySelector('#bindPhoneForm')?.addEventListener('submit', submitBindPhone);
  document.querySelector('#bindEmailForm')?.addEventListener('submit', submitBindEmail);
  document.querySelector('[data-action="send-bind-phone-code"]')?.addEventListener('click', () => {
    sendBindPhoneCode().catch((error) => {
      const hint = document.querySelector('#bindPhoneHint');
      if (hint) {
        if (error.message === 'invalid phone number') hint.textContent = '手机号格式不正确';
        else if (error.message === 'phone already bound to another account') hint.textContent = '该手机号已被其他账号绑定';
        else if (error.message === 'phone code sent too frequently') hint.textContent = '验证码发送太频繁，请稍后再试';
        else hint.textContent = `失败：${error.message}`;
      }
      toast(error.message);
    });
  });
  document.querySelector('[data-action="send-bind-email-code"]')?.addEventListener('click', () => {
    sendBindEmailCode().catch((error) => {
      const hint = document.querySelector('#bindEmailHint');
      if (hint) {
        if (error.message === 'invalid email address') hint.textContent = '邮箱格式不正确';
        else if (error.message === 'email already bound to another account') hint.textContent = '该邮箱已被其他账号绑定';
        else if (error.message === 'email code sent too frequently') hint.textContent = '验证码发送太频繁，请稍后再试';
        else if (error.message === 'email delivery failed') hint.textContent = '邮件发送失败，请检查 SMTP 配置';
        else hint.textContent = `失败：${error.message}`;
      }
      toast(error.message);
    });
  });
  document.querySelector('#adminPageRegisterForm')?.addEventListener('submit', (event) => {
    registerProjectUserFromAdminPage(event).catch((error) => {
      setText('#adminPageRegisterHint', error.message === 'project admin credentials required' ? '当前账号没有管理员权限。' : error.message);
      toast(error.message);
    });
  });
  document.querySelector('[data-action="refresh-project-users"]')?.addEventListener('click', () => {
    renderAccountAdmin().catch((error) => toast(error.message));
  });
  document.querySelector('#topbarProjectSelect')?.addEventListener('change', (event) => {
    switchProfileProject(event).catch((error) => toast(error.message));
  });
  document.querySelector('#adminPageUserList')?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const row = target.closest('[data-user-id]');
    const userId = row?.dataset.userId || '';
    if (!userId) return;
    if (target.dataset.action === 'toggle-user-active') {
      const active = target.textContent?.trim() === '启用';
      updateProjectUserFromAdminPage(userId, { active }).catch((error) => toast(error.message));
    }
    if (target.dataset.action === 'transfer-founder') {
      transferFounder();
    }
    if (target.dataset.action === 'open-role-change') {
      openRoleChangeModal({
        userId,
        targetName: target.dataset.targetName || '',
        targetHandle: target.dataset.targetHandle || '',
        currentRole: target.dataset.currentRole || 'developer'
      });
    }
  });
  // 权限调整 modal 的关闭 / 确认按钮
  document.querySelector('#roleModalBackdrop')?.addEventListener('click', (event) => {
    const target = event.target;
    if (target === event.currentTarget) { closeRoleChangeModal(); return; } // 点 backdrop 关闭
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.action === 'close-role-modal') closeRoleChangeModal();
    if (target.dataset.action === 'confirm-role-change') confirmRoleChange();
  });

  document.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => setRoute(button.dataset.route));
  });

  // 挂到 window，供动态渲染的 onclick 内联调用
  window.__briefRetry = (assignmentId) => {
    console.log('[Brief] Step 1 ✅ onclick 触发，assignmentId =', assignmentId);
    toast('[1/5] 按钮点击已捕获');
    regenerateBrief(assignmentId).catch((err) => {
      console.error('[Brief] ❌ 异常:', err);
      toast(`❌ ${err.message}`);
    });
  };

  // 腾讯云式导航：hover 一级按钮展开第二行，鼠标离开整个 topbar 后收起
  const topbarEl = document.querySelector('#topbar');
  const headerSubGroups = document.querySelectorAll('.header-sub-group');

  function showHeaderSub(parent) {
    let hasGroup = false;
    headerSubGroups.forEach((g) => {
      const match = g.dataset.sub === parent;
      g.classList.toggle('visible', match);
      if (match) hasGroup = true;
    });
    topbarEl?.classList.toggle('sub-open', hasGroup);
  }

  function hideHeaderSub() {
    headerSubGroups.forEach((g) => g.classList.remove('visible'));
    topbarEl?.classList.remove('sub-open');
  }

  // 一级有子菜单的按钮（无自身 route）
  document.querySelectorAll('.nav .nav-primary:not([data-route])').forEach((btn) => {
    btn.addEventListener('mouseenter', () => showHeaderSub(btn.dataset.navParent));
  });

  // 鼠标移到 topbar 其他区域（brand、project select、actions）时收起
  document.querySelectorAll('.brand, .topbar-project-wrap, .topbar-actions').forEach((el) => {
    el.addEventListener('mouseenter', hideHeaderSub);
  });

  // 鼠标离开整个 topbar 时收起
  topbarEl?.addEventListener('mouseleave', hideHeaderSub);

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
  document.querySelectorAll('.risk-tab').forEach((button) => {
    button.addEventListener('click', () => {
      activeRiskTab = button.dataset.riskTab || 'P1';
      selectedRiskId = '';
      renderRisks();
    });
  });
  document.querySelector('[data-action="run-review"]').addEventListener('click', () => {
    runReview().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="load-review-queue"]').addEventListener('click', () => {
    loadReviewQueue().catch((e) => toast(e.message));
  });
  // 人工审阅队列：点击条目打开详情面板
  document.querySelector('#reviewQueue').addEventListener('click', (e) => {
    const item = e.target.closest('[data-action="open-review-detail"]');
    if (item && item.dataset.reviewId) {
      openReviewDetail(item.dataset.reviewId).catch((err) => toast(err.message));
    }
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
  document.querySelector('[data-action="create-assignment"]')?.addEventListener('click', once('create-assignment', () => (
    createMeetingAssignment().catch((e) => toast(e.message))
  )));
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

  // 分工页 — tab 切换
  document.querySelectorAll('.assign-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchAssignTab(btn.dataset.tab));
  });

  document.querySelector('[data-action="refresh-assignments"]').addEventListener('click', () => {
    refreshAssignments().catch((e) => toast(e.message));
  });
  document.querySelector('[data-action="ai-progress-scan"]').addEventListener('click', () => {
    scanAiProgress().catch((e) => toast(e.message));
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

  // AI 产品经理：一键扫描（同步仓库 → 文档解析导入 → AI 混合分析）
  document.querySelectorAll('[data-action="daily-scan"]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    const orig = button.textContent;
    button.textContent = '扫描中...';
    try {
      toast('开始一键扫描，通常需要 60-90 秒，请稍候…');
      const projectId = getCurrentProjectId();
      const result = await api(`/api/projects/${projectId}/daily-scan`, { method: 'POST', body: '{}' });
      const steps = result.steps || {};
      const msgs = [];
      const added = steps.syncCommits?.added ?? steps.commits?.newCount;
      const imported = steps.syncDocs?.imported ?? steps.docs?.imported;
      if (added) msgs.push(`新 commit ${added} 条`);
      if (imported) msgs.push(`导入任务 ${imported} 条`);
      if (steps.syncDocs?.phases) msgs.push(`路径图阶段已更新`);
      toast(msgs.length ? `扫描完成：${msgs.join('，')}` : '扫描完成，无新数据');
      await loadState().then(() => renderAll()).catch(() => {});
    } catch (e) {
      if (e.message?.includes('504') || e.message?.includes('Gateway') || e.message?.includes('timeout')) {
        toast('扫描仍在后台处理中（网关超时），稍后刷新页面查看结果');
        await new Promise((r) => setTimeout(r, 8000));
        await loadState().then(() => renderAll()).catch(() => {});
      } else {
        toast(e.message || '扫描失败');
      }
    } finally {
      button.disabled = false;
      button.textContent = orig;
    }
  }));
  // 保留单独按钮的处理（其他页面可能还有）
  document.querySelectorAll('[data-action="sync-docs"]').forEach((button) => button.addEventListener('click', () => {
    syncDocsToHub().catch((e) => toast(e.message));
  }));
  document.querySelectorAll('[data-action="update-docs"]').forEach((button) => button.addEventListener('click', () => {
    updateDocsProgress().catch((e) => toast(e.message));
  }));
  document.querySelectorAll('[data-action="refresh-ai-analysis"]').forEach((button) => button.addEventListener('click', () => {
    refreshAiAnalysis().catch((e) => toast(e.message));
  }));

  document.querySelectorAll('[data-action="cleanup-tasks"]').forEach((button) => button.addEventListener('click', async () => {
    const confirmed = window.confirm(
      '🧹 清洗任务数据？\n\n将自动合并标题相同的重复任务（保留进度最高/已完成的版本），并将"成员A/B/C"等占位符替换为"待认领"。\n\n此操作不可撤销，请确认。'
    );
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = '清洗中…';
    try {
      const result = await api('/api/tasks/cleanup', { method: 'POST', body: '{}' });
      toast(`✅ ${result.message || '清洗完成'}`);
      await loadState();
    } catch (e) {
      toast(`❌ 清洗失败：${e.message}`);
    } finally {
      button.disabled = false;
      button.textContent = '清洗任务';
    }
  }));

  document.querySelectorAll('[data-action="reset-roadmap"]').forEach((button) => button.addEventListener('click', async () => {
    const confirmed = window.confirm(
      '⚠️ 按最新文档重建路径图？\n\n将执行以下操作（不可撤销）：\n'
      + '• 清空所有交付项 / 阶段划分 / 路径图缓存\n'
      + '• 剥离任务的旧 FK 绑定\n'
      + '• 删除过时的文档任务（来自旧文档、未完成、无 commit/认领证据的任务）\n'
      + '• 自动触发同步文档，按最新仓库文档重新生成\n\n'
      + '保留：已完成任务 / 有 commit 证据的任务 / 已被认领的任务 / 人工创建的任务（无 sourceDoc）\n\n'
      + '改了目标仓库文档后用这个按钮可以让 hub 完全反映最新规划。'
    );
    if (!confirmed) return;
    const projectId = getCurrentProjectId();
    button.disabled = true;
    button.textContent = '重置中…';
    try {
      const result = await api('/api/stage/reset-roadmap', {
        method: 'POST',
        body: JSON.stringify({ projectId, purgeStaleTasks: true })
      });
      toast(`✅ ${result.message || '路径图已重置'}`);
      // 重置后立即触发 sync-docs（limit 拉到 20 一次性吃满），避免空路径图中间态
      button.textContent = '同步文档…';
      try {
        const sync = await api(`/api/projects/${projectId}/sync-docs?limit=20`, { method: 'POST', body: '{}' });
        toast(`✅ ${sync.message || '路径图已重新生成'}`);
      } catch (syncErr) {
        toast(`⚠️ 重置成功但 sync-docs 失败：${syncErr.message}，请手动点击「同步文档」`);
      }
      await loadState();
    } catch (e) {
      toast(`❌ 重置失败：${e.message}`);
    } finally {
      button.disabled = false;
      button.textContent = '重置路径图';
    }
  }));

  // ESC 关闭 modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTaskModal();
  });
}

bindEvents();
renderRules();
renderReviewQueue(readCachedReviewQueue());

// ES module 内函数不自动暴露到 window，内联 onclick 需要手动挂载
window.loadReviewSolutions = loadReviewSolutions;
window.resolveReview = resolveReview;
window.selectSolution = selectSolution;
window.openReviewDetail = openReviewDetail;

async function initApp() {
  setAuthVisible(state.isAuthenticated);
  await loadLoginProjects();
  if (!state.isAuthenticated) return;
  await loadState();
}

initApp().catch((error) => {
  setAuthVisible(false);
  setText('#loginHint', `无法连接服务器：${error.message}`);
  setText('#syncStatus', `${getApiScopeLabel()} 未连接`);
  renderRisks();
  renderMeeting();
  toast(`请先运行 npm run dev：${error.message}`);
});

window.setInterval(() => {
  if (!state.isAuthenticated) return;
  syncCueAiGit({ silent: true }).catch(() => {
    setText('#syncStatus', '自动抓取暂不可用，等待下次重试');
  });
}, 300000);
