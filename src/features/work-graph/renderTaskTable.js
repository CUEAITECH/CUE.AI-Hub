// src/features/work-graph/renderTaskTable.js
// 任务列表渲染（dashboard overview — 前 5 条，按风险排序）— 从 src/app.js 提取
// helpers: escapeHtml, getTaskAssignments, onClaimTask(taskId, taskTitle), onSetRoute(route)

export function renderTaskTable(state, { escapeHtml, getTaskAssignments, onClaimTask, onSetRoute }) {
  const table = document.querySelector('#taskTable');
  if (!table) return;
  if (!state.tasks?.length) {
    table.innerHTML = '<div class="empty-state">暂无任务。可以从 AI 排期生成任务，或手动新增。</div>';
    return;
  }

  const overviewTasks = [...state.tasks]
    .sort((a, b) => {
      const riskWeight = { 高: 3, 中: 2, 低: 1 };
      return (riskWeight[b.risk] || 0) - (riskWeight[a.risk] || 0)
        || new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    })
    .slice(0, 5);

  table.innerHTML = `
    ${overviewTasks.map((task) => {
      const claimants = getTaskAssignments ? getTaskAssignments(task.id) : [];
      const isDone = task.status === '已完成';
      return `
        <div class="task-row overview-task-row">
          <div class="overview-task-main">
            <strong>${escapeHtml(task.title)}</strong>
          </div>
          <div class="overview-task-meta">
            <span>${claimants.length ? escapeHtml(claimants.map((item) => item.owner).join('、')) : '未领'}</span>
            <span class="risk-badge risk-${escapeHtml(task.risk)}">${escapeHtml(task.risk)}</span>
            <span>${escapeHtml(task.due || '未设置')}</span>
          </div>
          <div class="task-row-actions">
            ${!isDone ? `<button class="claim-inline-btn" data-task-id="${escapeHtml(task.id)}" data-task-title="${escapeHtml(task.title)}">领取</button>` : ''}
          </div>
        </div>
      `;
    }).join('')}
    ${state.tasks.length > 5 ? '<button class="text-link-btn" type="button" data-route="assignment">查看全部任务领取</button>' : ''}
  `;

  if (onClaimTask) {
    table.querySelectorAll('.claim-inline-btn').forEach((btn) => {
      btn.addEventListener('click', () => onClaimTask(btn.dataset.taskId, btn.dataset.taskTitle));
    });
  }
  if (onSetRoute) {
    table.querySelectorAll('[data-route]').forEach((btn) => {
      btn.addEventListener('click', () => onSetRoute(btn.dataset.route));
    });
  }
}
