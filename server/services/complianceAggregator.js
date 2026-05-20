/**
 * 聚合任务的验收合规状态：扫描该任务所有有 compliance 字段的 review，
 * 以"最新一条 review 的 compliance 快照"作为当前状态。
 *
 * 设计假设：reviewer.js 的 prompt 要求 LLM 每次评估都基于"项目当前整体状态"
 * 给出全量 done/notDone/needsHumanCheck，而不是只看本次 diff。所以最新 review 就是
 * 最新快照，不需要跨 review 做合集运算。
 */

/**
 * @param {string} taskId
 * @param {object[]} reviews  store.reviews
 * @returns {null|{
 *   reviewId: string,
 *   reviewedAt: string,
 *   done: string[],
 *   notDone: string[],
 *   needsHumanCheck: string[],
 *   total: number,
 *   doneCount: number,
 *   progress: number  // 0-100，done / (done + notDone + needsHumanCheck)
 * }}
 */
export function aggregateTaskCompliance(taskId, reviews = []) {
  if (!taskId) return null;
  const relevant = reviews
    .filter((r) => r.compliance?.taskId === taskId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (!relevant.length) return null;

  const latest = relevant[0];
  const c = latest.compliance;
  const done = c.done || [];
  const notDone = c.notDone || [];
  const needsHumanCheck = c.needsHumanCheck || [];
  const total = done.length + notDone.length + needsHumanCheck.length;
  const progress = total > 0 ? Math.round((done.length / total) * 100) : 0;

  return {
    reviewId: latest.id,
    reviewedAt: latest.createdAt,
    done,
    notDone,
    needsHumanCheck,
    total,
    doneCount: done.length,
    progress
  };
}

/**
 * 批量聚合，返回 { [taskId]: aggregateResult }
 */
export function buildComplianceMap(reviews = []) {
  const map = {};
  for (const review of reviews) {
    const taskId = review.compliance?.taskId;
    if (!taskId) continue;
    if (!map[taskId]) {
      // 取该任务最新一条 review
      map[taskId] = aggregateTaskCompliance(taskId, reviews);
    }
  }
  return map;
}
