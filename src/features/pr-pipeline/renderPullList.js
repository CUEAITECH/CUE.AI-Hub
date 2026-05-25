// src/features/pr-pipeline/renderPullList.js
// PR 列表渲染 — 从 src/app.js 提取
// 依赖：state.pulls（当前列表），escapeHtml（外部传入），openPullDrawer（window global，inline onclick 引用）
// 注意：不直接调用 fetch()，数据加载由调用方（app.js）通过 pullsApi 完成后再调 renderPullList

export function renderPullList(state, { escapeHtml }) {
  const container = document.getElementById('pullList');
  if (!container) return;
  const pulls = state.pulls || [];
  if (!pulls.length) {
    container.innerHTML = '<div class="empty-hint">暂无 PR 数据。请先同步 GitHub 项目。</div>';
    return;
  }
  container.innerHTML = pulls.map((pr) => {
    const stateLabel = { open: '待合并', merged: '已合并', closed: '已关闭' }[pr.state] || pr.state;
    const compliance = pr.hubReview?.compliance || pr.prAgentReview?.compliance;
    const complianceBadge = compliance
      ? `<span class="pull-compliance-badge">✅${(compliance.done||[]).length} ❌${(compliance.notDone||[]).length} ⚠️${(compliance.needsHumanCheck||[]).length}</span>`
      : '';
    const dateStr = pr.mergedAt
      ? `合并于 ${pr.mergedAt.slice(0, 10)}`
      : `更新于 ${(pr.updatedAt || '').slice(0, 10)}`;
    return `
      <div class="pull-card" onclick="openPullDrawer('${escapeHtml(pr.id)}')">
        <div class="pull-card-header">
          <span class="pull-number">#${pr.number}</span>
          <span class="pull-title">${escapeHtml(pr.title)}</span>
          <span class="pull-state-badge ${pr.state}">${stateLabel}</span>
        </div>
        <div class="pull-card-meta">
          <span>${escapeHtml(pr.author || '未知')}</span>
          <span>${dateStr}</span>
          ${complianceBadge}
        </div>
      </div>
    `;
  }).join('');
}
