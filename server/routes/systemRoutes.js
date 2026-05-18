import {
  createSessionToken,
  findUserForProject,
  getSessionToken,
  hashPassword,
  issueEmailCode,
  issuePhoneCode,
  isProjectFounder,
  normalizeEmail,
  normalizePhone,
  roleForProject,
  sanitizeUser,
  userCanManageProject,
  verifyEmailCode,
  verifyPhoneCode,
  verifyPassword,
  verifySessionToken
} from '../services/auth.js';
import { isSmtpConfigured, sendVerificationEmail } from '../services/mailer.js';

function getSessionUser(req, users, projectId) {
  const session = verifySessionToken(getSessionToken(req));
  if (!session || session.projectId !== projectId) return null;
  const user = users.find((item) => item.id === session.sub && item.active !== false) || null;
  return user && userCanManageProject(user, projectId) ? user : null;
}

function getProjectSessionUser(req, users, projectId) {
  const session = verifySessionToken(getSessionToken(req));
  if (!session || session.projectId !== projectId) return null;
  const user = users.find((item) => item.id === session.sub && item.active !== false) || null;
  return user && findUserForProject(users, user.username, projectId) ? user : null;
}

function sanitizeUserForProject(user, projectId, project = null) {
  return {
    ...sanitizeUser(user),
    projectRole: roleForProject(user, projectId),
    isFounder: project ? isProjectFounder(user, project) : false
  };
}

export function createSystemRoutes({
  loadStore,
  updateStore,
  readBody = async () => ({ json: {} }),
  scanRisks,
  normalizeStageName,
  buildMetrics,
  buildStageChecklist,
  aggregateDeliverableProgress,
  buildOpenApiSpec,
  sendJson,
  port,
  cueApiKey,
  isWeComAvailable,
  meetingHour,
  hubUrl
}) {
  return async function systemRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'CUE Project Hub', time: new Date().toISOString() });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const store = await loadStore();
      const projectId = String(url.searchParams.get('projectId') || (store.projects || [])[0]?.id || 'cue_ai_classroom').trim();
      const session = verifySessionToken(getSessionToken(req));
      if (!session) {
        sendJson(res, 401, { ok: false, error: 'not authenticated' });
        return true;
      }
      const me = (store.users || []).find((u) => u.id === session.sub && u.active !== false);
      if (!me) {
        sendJson(res, 401, { ok: false, error: 'session user not found' });
        return true;
      }
      const project = (store.projects || []).find((p) => p.id === projectId) || null;
      sendJson(res, 200, { ok: true, user: sanitizeUserForProject(me, projectId, project) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { json } = await readBody(req);
      const username = String(json?.username || '').trim();
      const password = String(json?.password || '');
      const emailCode = String(json?.emailCode || '').trim();
      const phoneCode = String(json?.phoneCode || json?.code || '').trim();
      const projectId = String(json?.projectId || '').trim();
      const store = await loadStore();
      const fallbackProjectId = (store.projects || [])[0]?.id || 'cue_ai_classroom';
      const targetProjectId = projectId || fallbackProjectId;
      let user = null;
      if (emailCode) {
        const email = normalizeEmail(username);
        if (!email || !verifyEmailCode(email, emailCode, 'login')) {
          sendJson(res, 401, { ok: false, error: 'invalid verification code' });
          return true;
        }
        user = findUserForProject(store.users || [], email, targetProjectId);
      } else if (phoneCode) {
        const phone = normalizePhone(username);
        if (!phone || !verifyPhoneCode(phone, phoneCode, 'login')) {
          sendJson(res, 401, { ok: false, error: 'invalid verification code' });
          return true;
        }
        user = findUserForProject(store.users || [], phone, targetProjectId);
      } else {
        user = findUserForProject(store.users || [], username, targetProjectId);
      }
      if (!user || (!phoneCode && !emailCode && !verifyPassword(password, user.passwordHash))) {
        sendJson(res, 401, { ok: false, error: 'invalid credentials' });
        return true;
      }
      const project = (store.projects || []).find((p) => p.id === targetProjectId) || null;
      sendJson(res, 200, {
        ok: true,
        user: sanitizeUserForProject(user, targetProjectId, project),
        projectId: targetProjectId,
        token: createSessionToken(user, targetProjectId)
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/email-code') {
      const { json } = await readBody(req);
      const purpose = json?.purpose === 'bind_email' ? 'bind_email' : 'login';
      const email = normalizeEmail(json?.email || json?.username || '');
      const projectId = String(json?.projectId || '').trim();
      if (!email) {
        sendJson(res, 400, { ok: false, error: 'invalid email address' });
        return true;
      }
      const store = await loadStore();
      if (purpose === 'login') {
        const fallbackProjectId = (store.projects || [])[0]?.id || 'cue_ai_classroom';
        const targetProjectId = projectId || fallbackProjectId;
        const user = findUserForProject(store.users || [], email, targetProjectId);
        if (!user) {
          sendJson(res, 404, { ok: false, error: 'email is not bound to an active account' });
          return true;
        }
      } else {
        const session = verifySessionToken(getSessionToken(req));
        if (!session) {
          sendJson(res, 401, { ok: false, error: 'not authenticated' });
          return true;
        }
        const me = (store.users || []).find((u) => u.id === session.sub && u.active !== false);
        if (!me) {
          sendJson(res, 401, { ok: false, error: 'session user not found' });
          return true;
        }
        const collision = (store.users || []).some((u) => u.id !== me.id && u.email === email);
        if (collision) {
          sendJson(res, 409, { ok: false, error: 'email already bound to another account' });
          return true;
        }
      }
      const issued = issueEmailCode(email, purpose);
      if (!issued.ok) {
        sendJson(res, issued.error === 'email code sent too frequently' ? 429 : 400, issued);
        return true;
      }
      if (isSmtpConfigured()) {
        try {
          await sendVerificationEmail(issued.email, issued.code);
        } catch (error) {
          sendJson(res, 502, { ok: false, error: 'email delivery failed', details: error.message });
          return true;
        }
      }
      sendJson(res, 200, {
        ok: true,
        email: issued.email,
        expiresAt: issued.expiresAt,
        devCode: isSmtpConfigured() ? undefined : issued.code
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/phone-code') {
      const { json } = await readBody(req);
      const purpose = json?.purpose === 'bind_phone' ? 'bind_phone' : 'login';
      const phone = normalizePhone(json?.phone || json?.username || '');
      const projectId = String(json?.projectId || '').trim();
      if (!phone) {
        sendJson(res, 400, { ok: false, error: 'invalid phone number' });
        return true;
      }
      const store = await loadStore();
      if (purpose === 'login') {
        const fallbackProjectId = (store.projects || [])[0]?.id || 'cue_ai_classroom';
        const targetProjectId = projectId || fallbackProjectId;
        const user = findUserForProject(store.users || [], phone, targetProjectId);
        if (!user) {
          sendJson(res, 404, { ok: false, error: 'phone is not bound to an active account' });
          return true;
        }
      } else {
        const session = verifySessionToken(getSessionToken(req));
        if (!session) {
          sendJson(res, 401, { ok: false, error: 'not authenticated' });
          return true;
        }
        const me = (store.users || []).find((u) => u.id === session.sub && u.active !== false);
        if (!me) {
          sendJson(res, 401, { ok: false, error: 'session user not found' });
          return true;
        }
        const collision = (store.users || []).some((u) => u.id !== me.id && u.phone === phone);
        if (collision) {
          sendJson(res, 409, { ok: false, error: 'phone already bound to another account' });
          return true;
        }
      }
      const issued = issuePhoneCode(phone, purpose);
      if (!issued.ok) {
        sendJson(res, issued.error === 'phone code sent too frequently' ? 429 : 400, issued);
        return true;
      }
      // 当前项目尚未接入短信供应商；开发/内网环境直接返回 devCode 供页面提示，接 SMS 时替换为真实发送即可。
      sendJson(res, 200, {
        ok: true,
        phone: issued.phone,
        expiresAt: issued.expiresAt,
        devCode: issued.code
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/users') {
      const projectId = url.searchParams.get('projectId') || '';
      const store = await loadStore();
      const targetProjectId = projectId || (store.projects || [])[0]?.id || 'cue_ai_classroom';
      const sessionUser = getProjectSessionUser(req, store.users || [], targetProjectId);
      if (!sessionUser) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return true;
      }
      const project = (store.projects || []).find((p) => p.id === targetProjectId) || null;
      const callerIsSystemAdmin = sessionUser.role === 'admin';
      const users = (store.users || [])
        .filter((user) => (user.projectIds || []).some((id) => id === '*' || id === targetProjectId))
        // 系统管理员账号是 bootstrap 兜底账号，平时只对系统管理员可见
        .filter((user) => user.role !== 'admin' || callerIsSystemAdmin)
        .map((user) => sanitizeUserForProject(user, targetProjectId, project));
      sendJson(res, 200, { users });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/users') {
      if (typeof updateStore !== 'function') {
        sendJson(res, 500, { ok: false, error: 'auth store is not writable' });
        return true;
      }
      const { json } = await readBody(req);
      const projectId = String(json?.projectId || '').trim();
      const username = String(json?.username || '').trim();
      const password = String(json?.password || '');
      const name = String(json?.name || username).trim();
      const role = ['developer', 'project_admin', 'hr_manager'].includes(json?.role) ? json.role : 'developer';
      if (!projectId || !username || !password) {
        sendJson(res, 400, { ok: false, error: 'projectId, username and password are required' });
        return true;
      }

      const before = await loadStore();
      const tokenAdmin = getProjectSessionUser(req, before.users || [], projectId);
      const credentialAdmin = (() => {
        const adminUsername = String(json?.adminUsername || '').trim();
        const adminPassword = String(json?.adminPassword || '');
        const candidate = findUserForProject(before.users || [], adminUsername, projectId);
        return candidate && verifyPassword(adminPassword, candidate.passwordHash) && userCanManageProject(candidate, projectId)
          ? candidate
          : null;
      })();
      const adminUser = tokenAdmin || credentialAdmin;
      const adminRole = adminUser ? roleForProject(adminUser, projectId) : '';
      if (!adminUser || !['admin', 'project_admin', 'hr_manager'].includes(adminRole)) {
        sendJson(res, 403, { ok: false, error: 'project admin credentials required' });
        return true;
      }
      const existingUser = (before.users || []).find((user) => user.username === username) || null;
      if (existingUser && (existingUser.projectIds || []).some((id) => id === '*' || id === projectId)) {
        sendJson(res, 409, { ok: false, error: 'username already exists' });
        return true;
      }

      const now = new Date().toISOString();
      let createdUser = null;
      await updateStore((draft) => {
        draft.users = draft.users || [];
        if (existingUser) {
          const index = draft.users.findIndex((user) => user.id === existingUser.id);
          if (index !== -1) {
            const current = draft.users[index];
            createdUser = {
              ...current,
              name: name || current.name,
              projectIds: [...new Set([...(current.projectIds || []), projectId])],
              projectRoles: { ...(current.projectRoles || {}), [projectId]: role },
              active: true,
              updatedAt: now
            };
            draft.users[index] = createdUser;
          }
          return draft;
        }
        createdUser = {
          id: `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          username,
          name,
          role,
          projectIds: [projectId],
          projectRoles: { [projectId]: role },
          active: true,
          passwordHash: hashPassword(password),
          createdAt: now,
          updatedAt: now
        };
        draft.users.push(createdUser);
        return draft;
      });
      const project = (before.projects || []).find((p) => p.id === projectId) || null;
      sendJson(res, existingUser ? 200 : 201, { ok: true, user: sanitizeUserForProject(createdUser, projectId, project) });
      return true;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/auth/users/')) {
      if (typeof updateStore !== 'function') {
        sendJson(res, 500, { ok: false, error: 'auth store is not writable' });
        return true;
      }
      const userId = decodeURIComponent(url.pathname.split('/').pop() || '');
      const { json } = await readBody(req);
      const projectId = String(json?.projectId || '').trim();
      if (!projectId || !userId) {
        sendJson(res, 400, { ok: false, error: 'projectId and user id are required' });
        return true;
      }

      const before = await loadStore();
      const adminUser = getProjectSessionUser(req, before.users || [], projectId);
      if (!adminUser) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return true;
      }

      const target = (before.users || []).find((user) => user.id === userId) || null;
      if (!target || !(target.projectIds || []).some((id) => id === '*' || id === projectId)) {
        sendJson(res, 404, { ok: false, error: 'user not found' });
        return true;
      }
      if (target.role === 'admin' && roleForProject(adminUser, projectId) !== 'admin') {
        sendJson(res, 403, { ok: false, error: 'system admin account is protected' });
        return true;
      }
      // 创始人保护：项目创始人的角色不可被他人降级，账号不可被他人停用
      // 例外：系统管理员或创始人本人调用可以放行（但本人也不能把自己降级——通过 UI 不暴露该按钮即可）
      const project = (before.projects || []).find((p) => p.id === projectId) || null;
      const targetIsFounder = isProjectFounder(target, project);
      const callerIsFounder = isProjectFounder(adminUser, project);
      const callerIsSystemAdmin = adminUser.role === 'admin';
      const callerProjectRole = roleForProject(adminUser, projectId);
      const callerIsHrManager = callerProjectRole === 'hr_manager';
      const wantsRoleChange = json?.role && json.role !== roleForProject(target, projectId);
      const hasActivePatch = typeof json?.active === 'boolean';
      const wantsActiveChange = hasActivePatch && json.active !== (target.active !== false);
      if (targetIsFounder && !callerIsSystemAdmin && !callerIsFounder) {
        const wantsDeactivate = json?.active === false;
        if (wantsRoleChange || wantsDeactivate) {
          sendJson(res, 403, { ok: false, error: 'project founder is protected; use transfer-founder to change' });
          return true;
        }
      }
      // 角色调整权限：只有项目创始人（或系统管理员）能改角色。
      // 项目管理员只能创建账号 / 停用账号 / 重置密码，不能把别人提到其他权限等级
      if (wantsRoleChange && !callerIsFounder && !callerIsSystemAdmin) {
        sendJson(res, 403, { ok: false, error: 'only project founder can change role' });
        return true;
      }
      if (wantsActiveChange && !callerIsFounder && !callerIsSystemAdmin && !callerIsHrManager) {
        sendJson(res, 403, { ok: false, error: 'only project founder, system admin or hr manager can change account status' });
        return true;
      }

      const nextRole = ['developer', 'project_admin', 'hr_manager'].includes(json?.role) ? json.role : undefined;
      // 安全：管理员不能给他人改/重置密码（之前会导致管理员任意覆盖他人凭据）。
      // 密码只能本人通过 PATCH /api/auth/me 改，必须验证旧密码
      let updatedUser = null;
      const now = new Date().toISOString();
      await updateStore((draft) => {
        draft.users = draft.users || [];
        const index = draft.users.findIndex((user) => user.id === userId);
        if (index === -1) return draft;
        const current = draft.users[index];
        const projectRoles = current.projectRoles && typeof current.projectRoles === 'object' ? current.projectRoles : {};
        updatedUser = {
          ...current,
          role: current.role === 'admin' ? 'admin' : current.role,
          projectRoles: current.role === 'admin'
            ? projectRoles
            : { ...projectRoles, ...(nextRole ? { [projectId]: nextRole } : {}) },
          active: current.role === 'admin' ? true : (hasActivePatch ? json.active : current.active !== false),
          updatedAt: now
        };
        draft.users[index] = updatedUser;
        return draft;
      });
      sendJson(res, 200, { ok: true, user: sanitizeUserForProject(updatedUser, projectId, project) });
      return true;
    }

    // 本人账号自助：修改密码（须验证旧密码） / 绑定/修改手机号
    if (req.method === 'PATCH' && url.pathname === '/api/auth/me') {
      if (typeof updateStore !== 'function') {
        sendJson(res, 500, { ok: false, error: 'auth store is not writable' });
        return true;
      }
      const session = verifySessionToken(getSessionToken(req));
      if (!session) { sendJson(res, 401, { ok: false, error: 'not authenticated' }); return true; }
      const { json } = await readBody(req);
      const before = await loadStore();
      const me = (before.users || []).find((u) => u.id === session.sub && u.active !== false);
      if (!me) { sendJson(res, 401, { ok: false, error: 'session user not found' }); return true; }

      const currentPassword = String(json?.currentPassword || '');
      const newPassword = String(json?.newPassword || '');
      const newPhoneRaw = json?.phone;
      const newEmailRaw = json?.email;
      const wantsPasswordChange = Boolean(newPassword);
      const wantsPhoneChange = newPhoneRaw !== undefined;
      const wantsEmailChange = newEmailRaw !== undefined;

      if (wantsPasswordChange) {
        if (newPassword.length < 6) {
          sendJson(res, 400, { ok: false, error: 'new password must be at least 6 characters' });
          return true;
        }
        if (!verifyPassword(currentPassword, me.passwordHash)) {
          sendJson(res, 403, { ok: false, error: 'current password is incorrect' });
          return true;
        }
      }

      let normalizedPhone = null;
      if (wantsPhoneChange) {
        const raw = String(newPhoneRaw || '').trim();
        if (raw === '') {
          normalizedPhone = ''; // 显式清空
        } else {
          normalizedPhone = normalizePhone(raw);
          if (!normalizedPhone) {
            sendJson(res, 400, { ok: false, error: 'invalid phone number' });
            return true;
          }
          // 唯一性：同 phone 不能落到不同账号上
          const collision = (before.users || []).some((u) => u.id !== me.id && u.phone === normalizedPhone);
          if (collision) {
            sendJson(res, 409, { ok: false, error: 'phone already bound to another account' });
            return true;
          }
          const phoneCode = String(json?.phoneCode || json?.code || '').trim();
          if (!verifyPhoneCode(normalizedPhone, phoneCode, 'bind_phone')) {
            sendJson(res, 403, { ok: false, error: 'invalid verification code' });
            return true;
          }
        }
      }

      let normalizedEmail = null;
      if (wantsEmailChange) {
        const raw = String(newEmailRaw || '').trim();
        if (raw === '') {
          normalizedEmail = '';
        } else {
          normalizedEmail = normalizeEmail(raw);
          if (!normalizedEmail) {
            sendJson(res, 400, { ok: false, error: 'invalid email address' });
            return true;
          }
          const collision = (before.users || []).some((u) => u.id !== me.id && u.email === normalizedEmail);
          if (collision) {
            sendJson(res, 409, { ok: false, error: 'email already bound to another account' });
            return true;
          }
          const emailCode = String(json?.emailCode || '').trim();
          if (!verifyEmailCode(normalizedEmail, emailCode, 'bind_email')) {
            sendJson(res, 403, { ok: false, error: 'invalid verification code' });
            return true;
          }
        }
      }

      const now = new Date().toISOString();
      let updated = null;
      await updateStore((draft) => {
        const idx = (draft.users || []).findIndex((u) => u.id === me.id);
        if (idx === -1) return draft;
        const cur = draft.users[idx];
        updated = {
          ...cur,
          passwordHash: wantsPasswordChange ? hashPassword(newPassword) : cur.passwordHash,
          phone: wantsPhoneChange ? normalizedPhone : cur.phone,
          email: wantsEmailChange ? normalizedEmail : cur.email,
          updatedAt: now
        };
        draft.users[idx] = updated;
        return draft;
      });
      sendJson(res, 200, {
        ok: true,
        user: sanitizeUser(updated),
        changed: { password: wantsPasswordChange, phone: wantsPhoneChange, email: wantsEmailChange }
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const store = await loadStore();
      const requestedProjectId = url.searchParams.get('projectId') || '';
      const projectIds = (store.projects || []).map((project) => project.id);
      const projectId = requestedProjectId
        ? (projectIds.includes(requestedProjectId) ? requestedProjectId : projectIds[0] || requestedProjectId)
        : '';
      const byProject = (items = []) => projectId
        ? items.filter((item) => !item.projectId || item.projectId === projectId)
        : items;
      const scopedStore = projectId
        ? {
            ...store,
            tasks: byProject(store.tasks || []),
            reviews: byProject(store.reviews || []),
            activities: byProject(store.activities || []),
            assignments: byProject(store.assignments || []),
            standups: byProject(store.standups || []),
            attendanceRecords: byProject(store.attendanceRecords || []),
            alerts: byProject(store.alerts || []),
            deliverables: byProject(store.deliverables || []),
            phases: byProject(store.phases || [])
          }
        : store;
      const alerts = scanRisks(scopedStore);
      const currentStage = normalizeStageName(scopedStore.currentStage || {});
      sendJson(res, 200, {
        ...scopedStore,
        projects: store.projects || [],
        currentProjectId: projectId || (store.projects || [])[0]?.id || '',
        currentStage,
        alerts,
        metrics: buildMetrics(scopedStore, alerts),
        stageChecklist: buildStageChecklist({ ...scopedStore, currentStage }),
        deliverableProgress: aggregateDeliverableProgress(scopedStore)
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const store = await loadStore();
      const status = url.searchParams.get('status');
      const tasks = status ? store.tasks.filter((task) => task.status === status) : store.tasks;
      sendJson(res, 200, { tasks });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/members') {
      const store = await loadStore();
      sendJson(res, 200, { members: store.members });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/openapi.json') {
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`;
      sendJson(res, 200, buildOpenApiSpec(`${proto}://${host}`));
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      sendJson(res, 200, {
        githubEnabled: Boolean(process.env.GITHUB_TOKEN),
        apiKeyRequiredForWrites: Boolean(cueApiKey),
        wecomEnabled: isWeComAvailable(),
        llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
        meetingHour,
        hubUrl
      });
      return true;
    }

    return false;
  };
}
