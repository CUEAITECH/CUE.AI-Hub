/**
 * reviewTaskLinker.js
 * E3: diff 风险 → 自动建修复任务（SPEC-E3）
 *
 * 接线点：
 *   主路 — pullPipeline.js（PR-Agent → hubReview 镜像后调用）
 *   次路 — reviews.js（POST /v2/reviews 手动触发后调用）
 */

import logger from '../logger.js';

/**
 * djb2 hash — 与 docsManager.stableTaskId 相同的实现，
 * 独立复制以避免 import docsManager（会拉入 store/SQLite 整条链）。
 */
function stableId(prefix, ...parts) {
  const raw = parts.join('|');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(h, 33) ^ raw.charCodeAt(i)) >>> 0;
  }
  return `${prefix}_${h.toString(36).padStart(7, '0')}`;
}

/**
 * review 等级为 Block 或 Escalate 时，在 store 中建修复任务并阻断原任务进度。
 * 等级为其他值时立即返回，不做任何操作。
 *
 * @param {object} review - { id, level, suggestion, taskId?, pullId? }
 * @param {Function} updateStore
 * @returns {Promise<{ fixTaskId: string|null }>}
 */
export async function handleReviewOutcome(review, updateStore) {
  const { level, suggestion, taskId: originalTaskId } = review || {};

  if (level !== 'Block' && level !== 'Escalate') return { fixTaskId: null };

  const shortSummary = String(suggestion || '').slice(0, 40).replace(/[\n\r]/g, ' ');
  const fixTitle = `修复：${shortSummary}`.slice(0, 30);
  const fixTaskId = stableId('fix', String(review.id || ''), fixTitle);

  let created = false;

  await updateStore((draft) => {
    // 防重：同一 review 不建第二个修复任务
    if ((draft.tasks || []).some((t) => t.id === fixTaskId)) return draft;

    const originalTask = originalTaskId
      ? (draft.tasks || []).find((t) => t.id === originalTaskId)
      : null;

    const fixTask = {
      id: fixTaskId,
      title: fixTitle,
      businessNote: `修复 AI Review 发现的 ${level} 问题`,
      description: String(suggestion || '').slice(0, 200),
      acceptance: '重新 review 通过，等级降为 Warning 或 Pass',
      priority: 'P0',
      status: 'pending',
      type: 'fix',
      owner: originalTask?.owner || '待认领',
      suggestedOwner: originalTask?.owner || '',
      sourceReview: review.id,
      dependencies: originalTaskId ? [originalTaskId] : [],
      requirementRefs: [],
      evidenceRefs: [],
      milestoneId: originalTask?.milestoneId || null,
      projectId: originalTask?.projectId || null,
      tenantId: originalTask?.tenantId || 'default',
      e2Status: 'not-tested',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    draft.tasks = [fixTask, ...(draft.tasks || [])];

    // Block 等级：标记原任务为阻断，不计入里程碑 completed
    if (level === 'Block' && originalTask) {
      originalTask.blocked = true;
      originalTask.updatedAt = new Date().toISOString();
    }

    created = true;
    return draft;
  });

  if (created) {
    logger.info(`[E3] ${level} review → 修复任务已建立: ${fixTaskId}（原任务: ${originalTaskId || '未知'}）`);
  }

  return { fixTaskId: created ? fixTaskId : null };
}
