// src/features/work-graph/renderTaskDetail.js
// 任务详情面板渲染 — 从 src/app.js 提取
// 所有内部依赖（selectedTaskId, helper 函数, action 回调）通过 helpers 对象传入
// 无直接 fetch() 调用；数据操作通过 onMarkAssignmentDone / onMarkTaskDone / onRegenerateBrief 回调

export function renderTaskDetail(state, {
  selectedTaskId,
  escapeHtml,
  getTaskEvidence,
  getDeliverableForTask,
  getTaskAcceptance,
  renderComplianceCard,
  renderBriefBlock,
  getReviewLevelLabel,
  onMarkAssignmentDone,
  onMarkTaskDone,
  onRegenerateBrief,
  onMergePR,
}) {
  const title   = document.querySelector('#taskDetailTitle');
  const subtitle = document.querySelector('#taskDetailSubtitle');
  const content  = document.querySelector('#taskDetailContent');
  if (!content) return;

  const task = state.tasks.find((item) => item.id === selectedTaskId) || null;
  if (!task) {
    if (title)    title.textContent = '选择一个任务';
    if (subtitle) subtitle.textContent = '从任务看板或分工领取进入，查看任务细则、完成证据、验收指标和 AI 下一步操作。';
    content.innerHTML = '<div class="empty-state">还没有选择任务。</div>';
    return;
  }

  const evidence          = getTaskEvidence(task);
  const deliverable       = getDeliverableForTask(task);
  const latestAssignment  = evidence.assignments[0] || null;
  const brief             = latestAssignment?.brief || null;
  const hasAssignment     = Boolean(latestAssignment);
  const assignmentDone    = latestAssignment?.status === '已完成' || task.status === '已完成';
  const briefAge          = latestAssignment ? Date.now() - new Date(latestAssignment.createdAt || 0).getTime() : 0;
  const progress          = Number(task.progress) || 0;
  const progressSource    = task.progressSource || (task.completionSource ? 'manual' : 'auto');
  const progressSourceLabel = progressSource === 'manual' ? '人工确认' : '自动进度';
  if (title)    title.textContent = task.title;
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
        ${task.deliverableId ? `<div><dt>所属交付项</dt><dd>${escapeHtml(deliverable?.title || task.deliverableId)}</dd></div>` : ''}
        <div><dt>来源</dt><dd>${escapeHtml(task.sourceDoc || task.repo || '任务看板')}</dd></div>
        <div><dt>验收</dt><dd>${escapeHtml(getTaskAcceptance(task))}</dd></div>
      </dl>
      ${deliverable?.docSuggestComplete ? `<div class="task-doc-suggest">
        <strong>文档侧建议完成</strong>
        <span>目标仓库进度文档已将所属交付项标记为完成。请先在这里确认任务完成，再由负责人确认交付项。</span>
      </div>` : ''}
      ${(() => {
        // 查找关联的 open PR
        const linkedPull = (state.pulls || []).find((p) =>
          (p.linkedTaskIds || []).includes(task.id) && p.state === 'open'
        );
        const review = linkedPull?.hubReview || null;
        const humanDecision = review?.humanDecision;
        const humanApproved = (typeof humanDecision === 'object' && humanDecision?.status === 'approved')
          || humanDecision === 'exempted' || humanDecision === 'acknowledged';
        const aiAutoPass = review?.level === 'Pass' && (review?.completionRate ?? 0) >= 90;
        const unresolvedBlocks = (review?.blocks || []).filter((b) => !b.isOverridden).length;
        const mergeReady = linkedPull && (humanApproved || aiAutoPass) && !unresolvedBlocks;
        if (!linkedPull) return '';
        return `<div class="pull-merge-status">
          <span style="font-size:12px;color:var(--text-dim)">
            关联 PR #${escapeHtml(String(linkedPull.number))}：
            ${review?.completionRate !== null && review?.completionRate !== undefined ? `${review.completionRate}% ·` : ''}
            ${escapeHtml(review?.level || '未评估')}
            ${mergeReady ? '· <span style="color:var(--success)">✅ 准备合并</span>' : ''}
          </span>
        </div>`;
      })()}
      <div class="task-detail-actions">
        ${latestAssignment && latestAssignment.status !== '已完成'
          ? `<button class="task-confirm-done-btn" data-assignment-id="${escapeHtml(latestAssignment.id)}">确认任务完成</button>`
          : task.status !== '已完成'
            ? '<button class="task-confirm-done-btn" data-task-only="true">确认任务完成</button>'
            : '<span class="task-done-mark">任务已完成</span>'}
        ${(() => {
          const linkedPull = (state.pulls || []).find((p) =>
            (p.linkedTaskIds || []).includes(task.id) && p.state === 'open'
          );
          // 未有关联 PR 时显示「创建工作 PR」按钮
          if (!linkedPull && task.status !== '已完成') {
            return `<button class="task-create-pr-btn" data-action="create-pr" data-task-id="${escapeHtml(task.id)}" title="在 GitHub 自动创建 Draft PR，内嵌验收标准 checklist">🔀 创建工作 PR</button>`;
          }
          // 已有关联 PR 且满足合并条件时显示合并按钮
          const review = linkedPull?.hubReview || null;
          const humanDecision = review?.humanDecision;
          const humanApproved = (typeof humanDecision === 'object' && humanDecision?.status === 'approved')
            || humanDecision === 'exempted' || humanDecision === 'acknowledged';
          const aiAutoPass = review?.level === 'Pass' && (review?.completionRate ?? 0) >= 90;
          const unresolvedBlocks = (review?.blocks || []).filter((b) => !b.isOverridden).length;
          const mergeReady = linkedPull && (humanApproved || aiAutoPass) && !unresolvedBlocks;
          if (!mergeReady) return '';
          return `<button class="task-merge-btn" data-action="merge-pr" data-pull-id="${escapeHtml(linkedPull.id)}" data-task-id="${escapeHtml(task.id)}">🚀 合并 PR #${escapeHtml(String(linkedPull.number))}</button>`;
        })()}
      </div>
    </article>

    ${renderComplianceCard(task)}

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
        onMarkAssignmentDone(btn.dataset.assignmentId);
      } else {
        onMarkTaskDone(task.id);
      }
    });
  });
  content.querySelectorAll('[data-action="brief-retry"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onRegenerateBrief(btn.dataset.assignmentId);
    });
  });
}
