// src/features/pr-pipeline/renderPullList.js
// PR 列表渲染 — 从 src/app.js 提取
// 依赖：state.pulls（当前列表），escapeHtml（外部传入），openPullDrawer（window global，inline onclick 引用）
// 注意：不直接调用 fetch()，数据加载由调用方（app.js）通过 pullsApi 完成后再调 renderPullList

export function renderPullList(state, { escapeHtml }) {
  const container = document.getElementById('pullList');
  if (!container) return;
  const pulls = state.pulls || [];
  if (!pulls.length) {
    container.innerHTML = '<div class="pull-empty-state"><b>暂无 PR 信号</b><span>同步 GitHub 项目后，这里会展示待合并、已合并和已关闭的 PR 审阅流。</span></div>';
    return;
  }
  container.innerHTML = pulls.map((pr) => {
    const stateLabel = { open: '待合并', merged: '已合并', closed: '已关闭' }[pr.state] || pr.state;
    const compliance = pr.hubReview?.compliance || pr.prAgentReview?.compliance;
    const doneCount = (compliance?.done || []).length;
    const notDoneCount = (compliance?.notDone || []).length;
    const humanCount = (compliance?.needsHumanCheck || []).length;
    const complianceBadge = compliance
      ? `<span class="pull-compliance-badge"><b>${doneCount}</b> 已验收 <b>${notDoneCount}</b> 缺口 <b>${humanCount}</b> 待确认</span>`
      : '<span class="pull-compliance-badge muted">等待验收对照</span>';
    const reviewLevel = pr.hubReview?.level || pr.prAgentReview?.level || '';
    const reviewBadge = reviewLevel
      ? `<span class="pull-review-badge level-${String(reviewLevel).toLowerCase()}">${escapeHtml(reviewLevel)}</span>`
      : '<span class="pull-review-badge neutral">未审阅</span>';
    const dateStr = pr.mergedAt
      ? `合并于 ${pr.mergedAt.slice(0, 10)}`
      : `更新于 ${(pr.updatedAt || '').slice(0, 10)}`;
    const branchText = `${pr.headBranch || 'head'} → ${pr.baseBranch || 'base'}`;
    return `
      <div class="pull-card" onclick="openPullDrawer('${escapeHtml(pr.id)}')">
        <div class="pull-card-header">
          <div class="pull-title-stack">
            <div class="pull-kicker">
              <span class="pull-number">#${pr.number}</span>
              <span class="pull-branch">${escapeHtml(branchText)}</span>
            </div>
            <span class="pull-title">${escapeHtml(pr.title)}</span>
          </div>
          <div class="pull-card-status">
            <span class="pull-state-badge ${pr.state}">${stateLabel}</span>
            ${reviewBadge}
          </div>
        </div>
        <div class="pull-card-meta">
          <span class="pull-author">${escapeHtml(pr.author || '未知')}</span>
          <span>${escapeHtml(dateStr)}</span>
          ${complianceBadge}
        </div>
      </div>
    `;
  }).join('');
}
