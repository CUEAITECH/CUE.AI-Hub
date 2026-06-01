import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
const PHONE_CODE_RESEND_MS = 60 * 1000;
const phoneCodeStore = new Map();
const emailCodeStore = new Map();

function sessionSecret() {
  return process.env.CUE_SESSION_SECRET
    || process.env.CUE_API_KEY
    || process.env.HUB_ADMIN_PASSWORD
    || process.env.HUB_LOGIN_PASSWORD
    || 'cue-project-hub-dev-session';
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(String(password || ''), salt, 32).toString('hex');
  return `scrypt:${salt}:${key}`;
}

export function verifyPassword(password, stored) {
  const value = String(stored || '');
  if (!value) return false;
  if (!value.startsWith('scrypt:')) {
    return timingSafeTextEqual(String(password || ''), value);
  }
  const [, salt, expectedHex] = value.split(':');
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(String(password || ''), salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sanitizeUser(user = {}) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

export function roleForProject(user = {}, projectId = '') {
  if (user.role === 'admin') return 'admin';
  const projectRoles = user.projectRoles && typeof user.projectRoles === 'object' ? user.projectRoles : {};
  return projectRoles[projectId] || projectRoles['*'] || user.role || 'developer';
}

export function userCanAccessProject(user = {}, projectId = '') {
  const projectIds = Array.isArray(user.projectIds) ? user.projectIds : [];
  return projectIds.includes('*') || projectIds.includes(projectId);
}

export function userCanManageProject(user = {}, projectId = '') {
  if (!['admin', 'project_admin'].includes(roleForProject(user, projectId))) return false;
  return userCanAccessProject(user, projectId);
}

// ── 组织（租户）级访问与角色 ──────────────────────────────────────
// Organization 是租户边界（tenant_id），Project 是其下的 GitHub 仓库。
export function userCanAccessOrg(user = {}, orgId = '') {
  const orgIds = Array.isArray(user.orgIds) ? user.orgIds : [];
  if (orgIds.includes('*') || orgIds.includes(orgId)) return true;
  // 全局 project 通配符：可访问任意组织
  if (Array.isArray(user.projectIds) && user.projectIds.includes('*')) return true;
  // 向下兼容：通过旧版 POST /api/auth/users 创建的用户只有 projectIds，没有 orgIds。
  // 此类用户 orgIds 为空，但有具体 projectIds → 允许访问 'default' 组织（所有存量项目均在此）。
  // 一旦 orgIds 被正确写入（新建用户或重新邀请），此 fallback 不再触发。
  if (!orgIds.length && Array.isArray(user.projectIds) && user.projectIds.length > 0 && orgId === 'default') return true;
  return false;
}

export function orgRoleForUser(user = {}, orgId = '') {
  if (user.role === 'admin') return 'admin';
  const orgRoles = user.orgRoles && typeof user.orgRoles === 'object' ? user.orgRoles : {};
  return orgRoles[orgId] || orgRoles['*'] || user.role || 'developer';
}

export function userCanManageOrg(user = {}, orgId = '') {
  if (!userCanAccessOrg(user, orgId)) return false;
  return ['admin', 'project_admin'].includes(orgRoleForUser(user, orgId));
}

// 项目创始人：项目创建者，自动是项目管理员，角色不可被他人降级、账号不可被他人停用
// 唯一变更途径：本人主动调用「转移创始人」接口
export function isProjectFounder(user = {}, project = {}) {
  return Boolean(user?.id && project?.founderId && user.id === project.founderId);
}

/**
 * 全局查找用户（不限项目/组织）
 * 用于 GitHub 式登录：用户先凭账号登录，再选择要进入的组织。
 */
export function findUserGlobally(users = [], identifier = '') {
  const normalized = String(identifier || '').trim();
  if (!normalized) return null;
  const asPhone = normalizePhone(normalized);
  const asEmail = normalizeEmail(normalized);
  return users.find((user) => {
    if (user.active === false) return false;
    if (user.username === normalized) return true;
    if (asPhone && user.phone && user.phone === asPhone) return true;
    if (asEmail && user.email && user.email === asEmail) return true;
    return false;
  }) || null;
}

export function findUserForProject(users = [], identifier = '', projectId = '') {
  const normalized = String(identifier || '').trim();
  if (!normalized) return null;
  // 识别手机号：纯数字（可带 +）且长度 6-20 → 走手机号匹配，否则走 username
  const asPhone = normalizePhone(normalized);
  const asEmail = normalizeEmail(normalized);
  return users.find((user) => {
    if (user.active === false) return false;
    if (!userCanAccessProject(user, projectId)) return false;
    if (user.username === normalized) return true;
    if (asPhone && user.phone && user.phone === asPhone) return true;
    if (asEmail && user.email && user.email === asEmail) return true;
    return false;
  }) || null;
}

export function createSessionToken(user, projectId, orgId = 'default', now = Date.now()) {
  const payload = {
    sub:      user.id,
    username: user.username,
    role:     roleForProject(user, projectId),
    orgId,            // 组织 = 租户边界
    projectId,        // 当前选中的项目（组织下的 GitHub 仓库）
    tenantId: orgId,  // 隔离边界 = orgId（不再是 projectId）
    exp:      now + DEFAULT_SESSION_TTL_MS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', sessionSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', sessionSecret()).update(encoded).digest('base64url');
  if (!timingSafeTextEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function phoneCodeKey(phone, purpose = 'login') {
  return `${purpose}:${phone}`;
}

export function issuePhoneCode(phone, purpose = 'login', now = Date.now()) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return { ok: false, error: 'invalid phone number' };
  const key = phoneCodeKey(normalizedPhone, purpose);
  const existing = phoneCodeStore.get(key);
  if (existing && existing.expiresAt > now && now - existing.createdAt < PHONE_CODE_RESEND_MS) {
    return {
      ok: false,
      error: 'phone code sent too frequently',
      retryAfterMs: PHONE_CODE_RESEND_MS - (now - existing.createdAt)
    };
  }
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  phoneCodeStore.set(key, {
    code,
    createdAt: now,
    expiresAt: now + PHONE_CODE_TTL_MS
  });
  return {
    ok: true,
    phone: normalizedPhone,
    code,
    expiresAt: now + PHONE_CODE_TTL_MS
  };
}

export function verifyPhoneCode(phone, code, purpose = 'login', now = Date.now(), { consume = true } = {}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return false;
  const key = phoneCodeKey(normalizedPhone, purpose);
  const record = phoneCodeStore.get(key);
  if (!record || record.expiresAt < now) {
    phoneCodeStore.delete(key);
    return false;
  }
  const expected = String(record.code || '');
  const actual = String(code || '').trim();
  const ok = expected.length === actual.length && timingSafeTextEqual(expected, actual);
  if (ok && consume) phoneCodeStore.delete(key);
  return ok;
}

function emailCodeKey(email, purpose = 'login') {
  return `${purpose}:${email}`;
}

export function issueEmailCode(email, purpose = 'login', now = Date.now()) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { ok: false, error: 'invalid email address' };
  const key = emailCodeKey(normalizedEmail, purpose);
  const existing = emailCodeStore.get(key);
  if (existing && existing.expiresAt > now && now - existing.createdAt < PHONE_CODE_RESEND_MS) {
    return {
      ok: false,
      error: 'email code sent too frequently',
      retryAfterMs: PHONE_CODE_RESEND_MS - (now - existing.createdAt)
    };
  }
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  emailCodeStore.set(key, {
    code,
    createdAt: now,
    expiresAt: now + PHONE_CODE_TTL_MS
  });
  return {
    ok: true,
    email: normalizedEmail,
    code,
    expiresAt: now + PHONE_CODE_TTL_MS
  };
}

export function verifyEmailCode(email, code, purpose = 'login', now = Date.now(), { consume = true } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;
  const key = emailCodeKey(normalizedEmail, purpose);
  const record = emailCodeStore.get(key);
  if (!record || record.expiresAt < now) {
    emailCodeStore.delete(key);
    return false;
  }
  const expected = String(record.code || '');
  const actual = String(code || '').trim();
  const ok = expected.length === actual.length && timingSafeTextEqual(expected, actual);
  if (ok && consume) emailCodeStore.delete(key);
  return ok;
}

// 手机号规范化：去掉空格/横线/括号，保留 +/数字；长度合理才作为有效号
export function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/[\s\-()（）]/g, '');
  if (!/^\+?\d{6,20}$/.test(cleaned)) return '';
  return cleaned;
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (email.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

/**
 * 从请求中提取 session token（同时支持 Authorization: Bearer 和 X-CUE-Session-Token）
 * Bearer 前缀大小写不敏感（RFC 6750）。
 */
export function getSessionToken(req) {
  const header = String(req.headers?.authorization || '');
  const bearerMatch = header.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1].trim();
  const fallback = req.headers?.['x-cue-session-token'];
  return fallback ? String(fallback).trim() : '';
}

/**
 * 从请求中拿到当前登录用户对象（基于 store.users 查 payload.sub）
 * @returns user 对象 或 null
 */
export function getUserFromRequest(req, store) {
  const token = getSessionToken(req);
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload?.sub) return null;
  const users = (store && store.users) || [];
  return users.find((u) => u.id === payload.sub) || null;
}

/**
 * Extract the tenant (org) id from the session token in the request.
 * Returns 'default' when the request has no valid session (anonymous, webhooks, cron).
 */
export function getTenantId(req) {
  const token = getSessionToken(req);
  if (!token) return 'default';
  const payload = verifySessionToken(token);
  return payload?.tenantId || payload?.orgId || 'default';
}

export function normalizeUserRecord(user, now = new Date().toISOString()) {
  const projectIds = Array.isArray(user.projectIds) && user.projectIds.length ? user.projectIds : ['cue_ai_classroom'];
  const role = user.role || 'developer';
  const projectRoles = user.projectRoles && typeof user.projectRoles === 'object'
    ? user.projectRoles
    : Object.fromEntries(projectIds.map((projectId) => [projectId, role]));
  return {
    id: user.id || `user_${String(user.username || 'unknown').replace(/[^a-z0-9_-]/gi, '_')}`,
    username: String(user.username || '').trim(),
    name: String(user.name || user.username || '').trim(),
    phone: normalizePhone(user.phone || ''),
    email: normalizeEmail(user.email || ''),
    role,
    projectIds,
    projectRoles,
    active: user.active !== false,
    passwordHash: user.passwordHash || hashPassword(user.password || ''),
    createdAt: user.createdAt || now,
    updatedAt: user.updatedAt || now
  };
}
