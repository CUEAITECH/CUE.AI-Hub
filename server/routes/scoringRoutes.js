import {
  buildDailyScores,
  buildMonthlyScores,
  buildWeeklyScores,
  canManageAttendance,
  normalizeAttendanceRecord,
  parseAttendanceMessage
} from '../services/scoring.js';
import { roleForProject, verifySessionToken } from '../services/auth.js';

function getSessionUser(req, users = [], projectId = '') {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : req.headers['x-cue-session-token'] || '';
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const user = users.find((item) => item.id === payload.sub || item.username === payload.username);
  if (!user || user.active === false) return null;
  return { ...user, projectRole: roleForProject(user, projectId) };
}

function resolveProjectId(store, url, json = {}) {
  return String(json?.projectId || url.searchParams.get('projectId') || store.projects?.[0]?.id || 'cue_ai_classroom').trim();
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStartMonday(dateText) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 1);
  return date.toISOString().slice(0, 10);
}

export function createScoringRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  todayText
}) {
  function byProject(items = [], projectId = '') {
    return projectId ? items.filter((item) => !item.projectId || item.projectId === projectId) : items;
  }

  return async function scoringRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/scoring/daily') {
      const store = await loadStore();
      const projectId = resolveProjectId(store, url);
      const date = url.searchParams.get('date') || todayText();
      const totalBonus = Number(url.searchParams.get('totalBonus') || 0);
      const attendanceBonusBase = Number(url.searchParams.get('attendanceBonusBase') || 0);
      const payload = buildDailyScores(store, { projectId, date, totalBonus, attendanceBonusBase });
      sendJson(res, 200, payload);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/scoring/monthly') {
      const store = await loadStore();
      const projectId = resolveProjectId(store, url);
      const month = url.searchParams.get('month') || todayText().slice(0, 7);
      const totalBonus = Number(url.searchParams.get('totalBonus') || 0);
      const attendanceBonusBase = Number(url.searchParams.get('attendanceBonusBase') || 0);
      const payload = buildMonthlyScores(store, { projectId, month, totalBonus, attendanceBonusBase });
      sendJson(res, 200, payload);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/scoring/weekly') {
      const store = await loadStore();
      const projectId = resolveProjectId(store, url);
      const date = url.searchParams.get('date') || todayText();
      const totalBonus = Number(url.searchParams.get('totalBonus') || 0);
      const attendanceBonusBase = Number(url.searchParams.get('attendanceBonusBase') || 0);
      const payload = buildWeeklyScores(store, { projectId, date, totalBonus, attendanceBonusBase });
      sendJson(res, 200, payload);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/scoring/me') {
      const store = await loadStore();
      const projectId = resolveProjectId(store, url);
      const date = url.searchParams.get('date') || todayText();
      const sessionUser = getSessionUser(req, store.users || [], projectId);
      if (!sessionUser) {
        sendError(res, 403, 'forbidden');
        return true;
      }
      const owner = sessionUser.name || sessionUser.username;
      const daily = buildDailyScores(store, { projectId, date });
      const row = daily.rows.find((item) => item.owner === owner) || null;
      sendJson(res, 200, { date, projectId, owner, row });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/attendance/records') {
      const store = await loadStore();
      const projectId = resolveProjectId(store, url);
      const date = url.searchParams.get('date') || todayText();
      const records = byProject(store.attendanceRecords || [], projectId)
        .filter((item) => item.date === date)
        .sort((a, b) => {
          const ownerDiff = String(a.owner || '').localeCompare(String(b.owner || ''), 'zh-CN');
          if (ownerDiff !== 0) return ownerDiff;
          return String(a.kind || '').localeCompare(String(b.kind || ''));
        });
      sendJson(res, 200, { projectId, date, records });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/attendance/weekly') {
      const store = await loadStore();
      const projectId = resolveProjectId(store, url);
      const date = url.searchParams.get('date') || todayText();
      const weekStart = weekStartMonday(date);
      const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
      const records = byProject(store.attendanceRecords || [], projectId)
        .filter((item) => days.includes(item.date));
      sendJson(res, 200, { projectId, date, weekStart, days, records });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/attendance/records') {
      const { json } = await readBody(req);
      const before = await loadStore();
      const projectId = resolveProjectId(before, url, json);
      const sessionUser = getSessionUser(req, before.users || [], projectId);
      if (!sessionUser || !canManageAttendance(sessionUser, projectId)) {
        sendError(res, 403, 'attendance manager required');
        return true;
      }
      const record = normalizeAttendanceRecord({
        ...json,
        projectId,
        source: 'manual',
        editedBy: sessionUser.name || sessionUser.username
      });
      if (!record.owner) {
        sendError(res, 400, 'owner is required');
        return true;
      }
      const next = await updateStore((draft) => {
        draft.attendanceRecords = draft.attendanceRecords || [];
        draft.attendanceRecords = draft.attendanceRecords.filter((item) => !(
          item.projectId === record.projectId
          && item.date === record.date
          && item.owner === record.owner
          && item.kind === record.kind
        ));
        draft.attendanceRecords.unshift(record);
        draft.attendanceRecords = draft.attendanceRecords.slice(0, 2000);
        return draft;
      });
      sendJson(res, 201, {
        record,
        scoring: buildDailyScores(next, { projectId, date: record.date })
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom/attendance') {
      const { json } = await readBody(req);
      const store = await loadStore();
      const projectId = resolveProjectId(store, url, json);
      const parsed = parseAttendanceMessage(json?.text || json?.content || json?.message || '');
      if (!parsed) {
        sendJson(res, 200, { result: '未识别考勤格式。请发送：姓名正常完成 / 姓名延迟完成 / 姓名正常出席 / 姓名延迟出席 / 姓名临时请假 / 姓名缺勤' });
        return true;
      }
      const record = normalizeAttendanceRecord({
        ...parsed,
        projectId,
        date: json?.date || todayText(),
        source: 'wecom'
      });
      await updateStore((draft) => {
        draft.attendanceRecords = draft.attendanceRecords || [];
        draft.attendanceRecords = draft.attendanceRecords.filter((item) => !(
          item.projectId === record.projectId
          && item.date === record.date
          && item.owner === record.owner
          && item.kind === record.kind
        ));
        draft.attendanceRecords.unshift(record);
        draft.attendanceRecords = draft.attendanceRecords.slice(0, 2000);
        return draft;
      });
      sendJson(res, 200, { result: `已记录 ${record.owner} ${record.kind === 'meeting' ? '晚会出席' : '任务完成'}：${record.status}`, record });
      return true;
    }

    return false;
  };
}
