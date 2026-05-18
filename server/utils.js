import { createId } from './store.js';
import { todayText } from './services/dailyBrief.js';

export function setCorsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-cue-api-key, x-cue-session-token, authorization');
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  setCorsHeaders(res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function sendError(res, status, message, details = undefined) {
  sendJson(res, status, { error: message, details });
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (!raw.length) return { raw, json: {} };

  try {
    return { raw, json: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { raw, json: null };
  }
}

export function normalizeTask(input) {
  const now = new Date().toISOString();
  return {
    id: input.id || createId('task'),
    title: String(input.title || '').trim(),
    owner: String(input.owner || '未分配').trim(),
    status: input.status || '待确认',
    due: input.due || '',
    risk: input.risk || '低',
    progress: Number.isFinite(Number(input.progress)) ? Math.max(0, Math.min(100, Number(input.progress))) : 0,
    signal: input.signal || '等待更新',
    acceptance: input.acceptance || '待补充验收标准',
    description: input.description || '',
    dueDate: input.dueDate || '',
    sourceDoc: input.sourceDoc || '',
    projectId: input.projectId || 'cue_ai_classroom',
    deliverableId: input.deliverableId || null,
    priority: input.priority || '',
    createdAt: input.createdAt || now,
    updatedAt: now,
    linkedRefs: Array.isArray(input.linkedRefs) ? input.linkedRefs : [],
    aiProgressSuggestion: input.aiProgressSuggestion || null,
    completedBy: input.completedBy || '',
    completedAt: input.completedAt || '',
    completionSource: input.completionSource || '',
    progressSource: input.progressSource || (input.completionSource ? 'manual' : 'auto')
  };
}

export function addDaysText(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isCompanyWorkday(dateText = todayText()) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay();
  return dayOfWeek !== 3 && dayOfWeek !== 6;
}
