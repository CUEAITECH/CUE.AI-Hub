// src/features/command-center/renderEveningTimeline.js
//
// V4 晚会作战包 Timeline — 24h 成员/系统事件时间轴
//
// 契约：
//   - 不直接调用 fetch()，通过注入的 eventsApi 完成
//   - escapeHtml 通过 helpers 注入

/** SVG icon per event type (无 emoji，SVG path-based) */
const TYPE_COLOR = {
  'task.claimed':       '#2563eb',  // blue
  'task.progressed':    '#0891b2',  // cyan
  'pr.opened':          '#7c3aed',  // purple
  'pr.merged':          '#059669',  // green
  'pr.review.posted':   '#d97706',  // amber
  'standup.submitted':  '#db2777',  // pink
  'agent.task.completed': '#64748b', // slate
};

const TYPE_LABEL = {
  'task.claimed':       '领取任务',
  'task.progressed':    '任务进展',
  'pr.opened':          'PR 开启',
  'pr.merged':          'PR 合并',
  'pr.review.posted':   'PR Review',
  'standup.submitted':  '站会提交',
  'agent.task.completed': 'Agent 完成',
};

function eventColor(type) {
  for (const prefix of Object.keys(TYPE_COLOR)) {
    if (type === prefix || type.startsWith(prefix + '.')) return TYPE_COLOR[prefix];
  }
  return '#94a3b8'; // dim
}

function skeletonHtml() {
  return Array.from({ length: 4 }, () => `
    <div class="tl-skeleton-row">
      <div class="tl-sk tl-sk-label"></div>
      <div class="tl-sk tl-sk-track"></div>
    </div>`).join('');
}

/**
 * 渲染 24h 活动 Timeline 到 #eveningTimeline
 *
 * @param {object}  _state         - 当前 state（暂未使用，保留接口一致性）
 * @param {{ eventsApi: object, escapeHtml: Function }} helpers
 */
export async function renderEveningTimeline(_state, helpers) {
  const { eventsApi, escapeHtml } = helpers;
  const container = document.getElementById('eveningTimeline');
  if (!container) return;

  container.innerHTML = skeletonHtml();

  try {
    const data = await eventsApi.getGroupedEvents({ hours: 24 }, 'default').catch(() => null);
    const grouped = data?.grouped;

    if (!grouped || Object.keys(grouped).length === 0) {
      container.innerHTML = `
        <div class="tl-empty">
          <p class="tl-empty-text">今日暂无事件数据</p>
        </div>`;
      return;
    }

    const actors = Object.entries(grouped).slice(0, 10);

    // 时间轴 header（0h / 6h / 12h / 18h / 24h）
    const headerHtml = `
      <div class="tl-header" aria-hidden="true">
        <span class="tl-actor-col"></span>
        <div class="tl-track-col tl-axis">
          <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>24h</span>
        </div>
      </div>`;

    const rowsHtml = actors.map(([actor, events]) => {
      const dotsHtml = events.slice(0, 20).map(e => {
        const ts = new Date(e.createdAt);
        const h  = ts.getHours() + ts.getMinutes() / 60;
        const pct = (h / 24 * 100).toFixed(1);
        const color = eventColor(e.type);
        const label = TYPE_LABEL[e.type] || e.type;
        const timeStr = ts.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
        return `
          <span class="tl-dot"
            style="left:${pct}%;background:${color}"
            title="${escapeHtml(label)} · ${timeStr}"
            aria-label="${escapeHtml(label)} 于 ${timeStr}">
          </span>`;
      }).join('');

      return `
        <div class="tl-row">
          <span class="tl-actor-col" title="${escapeHtml(actor)}">${escapeHtml(actor.slice(0, 6))}</span>
          <div class="tl-track-col">
            <div class="tl-track" role="img" aria-label="${escapeHtml(actor)} 的事件时间轴">
              ${dotsHtml}
            </div>
          </div>
        </div>`;
    }).join('');

    const totalEvents = data.totalEvents ?? events?.length ?? '?';
    container.innerHTML = `
      <div class="tl-chart" role="region" aria-label="24小时活动时间轴">
        ${headerHtml}
        <div class="tl-rows">${rowsHtml}</div>
        <p class="tl-footer">共 ${totalEvents} 个事件 · ${actors.length} 个成员/系统</p>
      </div>`;
  } catch (e) {
    container.innerHTML = `
      <div class="tl-error">
        <span>Timeline 加载失败：${escapeHtml(e.message)}</span>
      </div>`;
  }
}
