// server/events/types.js
import { z } from 'zod';

// 公共字段
const base = { tenantId: z.string().default('default'), projectId: z.string().optional() };

export const EventSchemas = {
  // ── PR 生命周期 ──────────────────────────────────────
  'pr.opened': z.object({ ...base, prNumber: z.number(), author: z.string(), title: z.string(), repoFull: z.string() }),
  'pr.synchronized': z.object({ ...base, prNumber: z.number(), repoFull: z.string(), beforeSha: z.string().optional(), afterSha: z.string().optional() }),
  'pr.merged': z.object({ ...base, prNumber: z.number(), repoFull: z.string(), mergedAt: z.string(), prId: z.string().optional(), taskIds: z.array(z.string()).default([]) }),
  'pr.closed': z.object({ ...base, prNumber: z.number(), repoFull: z.string() }),
  'pr.review.posted': z.object({
    ...base,
    prId: z.string(),
    source: z.enum(['hub', 'pr-agent']),
    level: z.string(),
    complianceDelta: z.object({
      done: z.array(z.string()),
      notDone: z.array(z.string()),
      needsHumanCheck: z.array(z.string())
    }).optional()
  }),
  'pr.bypass.detected': z.object({ ...base, sha: z.string(), branch: z.string(), pusher: z.string() }),

  // ── Task 生命周期 ─────────────────────────────────────
  'task.created': z.object({ ...base, taskId: z.string(), source: z.enum(['ai-pm', 'manual', 'wecom', 'agent']) }),
  'task.claimed': z.object({ ...base, taskId: z.string(), actorId: z.string(), source: z.enum(['ui', 'wecom', 'agent', 'scheduler']) }),
  'task.progressed': z.object({ ...base, taskId: z.string(), fromProgress: z.number(), toProgress: z.number(), signal: z.string().optional(), source: z.string() }),
  'task.state.changed': z.object({ ...base, taskId: z.string(), from: z.string(), to: z.string(), reason: z.string().optional() }),
  'task.merged': z.object({ ...base, taskId: z.string(), prId: z.string() }),
  'task.cancelled': z.object({ ...base, taskId: z.string(), reason: z.string().optional() }),

  // ── Agent ─────────────────────────────────────────────
  'agent.task.accepted': z.object({ ...base, agentId: z.string(), taskId: z.string() }),
  'agent.task.completed': z.object({ ...base, agentId: z.string(), taskId: z.string(), artifacts: z.array(z.string()).default([]), acStatus: z.any().optional() }),
  'agent.task.blocked': z.object({ ...base, agentId: z.string(), taskId: z.string(), reason: z.string() }),
  'agent.task.needs-human': z.object({ ...base, agentId: z.string(), taskId: z.string(), question: z.string() }),

  // ── Doc ───────────────────────────────────────────────
  'doc.scan.requested': z.object({ ...base, paths: z.array(z.string()).optional() }),
  'doc.updated': z.object({ ...base, path: z.string(), sha: z.string().optional() }),

  // ── Standup ───────────────────────────────────────────
  'standup.submitted': z.object({ ...base, actorId: z.string(), date: z.string(), yesterday: z.string(), today: z.string(), blockers: z.string().optional() }),

  // ── Evening report ────────────────────────────────────
  'evening.report.due': z.object({ ...base, date: z.string() }),
  'evening.report.generated': z.object({ ...base, date: z.string(), reportId: z.string() }),

  // ── Health / Risk ─────────────────────────────────────
  'risk.detected': z.object({ ...base, alertId: z.string(), severity: z.string(), ref: z.string().optional() }),
  'health.recomputed': z.object({ ...base, score: z.number(), components: z.any() }),
};

/**
 * 校验并构造一个 event payload
 * @param {string} type
 * @param {object} payload
 * @returns {object} 已校验的 payload
 */
export function validateEvent(type, payload) {
  const schema = EventSchemas[type];
  if (!schema) throw new Error(`Unknown event type: ${type}`);
  return schema.parse(payload);
}
