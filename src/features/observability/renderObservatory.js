// src/features/observability/renderObservatory.js
//
// V5 管理观察台：LLM 调用账本 / 事件流 / 三端同步健康度
//
// 契约：
//   - 不直接调用 fetch()，不持有 /api/ 端点字符串
//   - 所有网络调用通过注入的 observabilityApi helper 完成
//   - escapeHtml 同样通过 helpers 注入

/**
 * 渲染 LLM 账本面板
 *
 * @param {{ observabilityApi: object, escapeHtml: Function }} helpers
 */
async function renderLlmPanel(helpers) {
  const { observabilityApi, escapeHtml } = helpers;
  const llmEl = document.getElementById('obsLlmContent');
  if (!llmEl) return;

  llmEl.innerHTML = '<span class="obs-loading">加载中…</span>';
  try {
    const d = await observabilityApi.getLlmStats('default');
    const today = d.today || {};
    const failRatePct = d.recentFailRatePct != null
      ? `${d.recentFailRatePct}%`
      : '—';
    const costYuan = today.estimatedCostYuan != null
      ? `¥${today.estimatedCostYuan.toFixed(2)}`
      : '—';

    const byPurpHtml = (d.byPurpose || [])
      .map(p => `
        <tr>
          <td class="obs-table-cell">${escapeHtml(p.purpose || '(unknown)')}</td>
          <td class="obs-table-cell obs-num">${p.calls}</td>
          <td class="obs-table-cell obs-num">${(p.input || 0).toLocaleString()}</td>
          <td class="obs-table-cell obs-num">${(p.output || 0).toLocaleString()}</td>
        </tr>`)
      .join('');

    llmEl.innerHTML = `
      <div class="obs-stat-grid">
        <div class="obs-stat">
          <span class="obs-label">今日调用</span>
          <strong class="obs-value">${today.totalCalls ?? 0}</strong>
        </div>
        <div class="obs-stat">
          <span class="obs-label">Cache 命中率</span>
          <strong class="obs-value obs-good">${today.cacheHitRate ?? '—'}</strong>
        </div>
        <div class="obs-stat">
          <span class="obs-label">近5min 失败率</span>
          <strong class="obs-value ${d.recentFailRatePct > 20 ? 'obs-warn' : ''}">${failRatePct}</strong>
        </div>
        <div class="obs-stat">
          <span class="obs-label">今日成本</span>
          <strong class="obs-value">${costYuan}</strong>
        </div>
      </div>
      ${byPurpHtml ? `
      <div class="obs-table-wrap">
        <table class="obs-table">
          <thead>
            <tr>
              <th class="obs-table-head">用途</th>
              <th class="obs-table-head obs-num">调用次</th>
              <th class="obs-table-head obs-num">输入 token</th>
              <th class="obs-table-head obs-num">输出 token</th>
            </tr>
          </thead>
          <tbody>${byPurpHtml}</tbody>
        </table>
      </div>` : ''}`;
  } catch (e) {
    llmEl.innerHTML = `<span class="obs-error">加载失败：${escapeHtml(e.message)}</span>`;
  }
}

/**
 * 渲染事件流面板
 *
 * @param {{ observabilityApi: object, escapeHtml: Function }} helpers
 */
async function renderEventsPanel(helpers) {
  const { observabilityApi, escapeHtml } = helpers;
  const eventsEl = document.getElementById('obsEventsContent');
  if (!eventsEl) return;

  eventsEl.innerHTML = '<span class="obs-loading">加载中…</span>';

  const typeFilter = document.getElementById('obsEventTypeFilter')?.value?.trim() || '';
  const srcFilter  = document.getElementById('obsEventSourceFilter')?.value || '';
  const params = { limit: 40 };
  if (typeFilter) params.type   = typeFilter;
  if (srcFilter)  params.source = srcFilter;

  try {
    const d = await observabilityApi.getEvents(params, 'default');
    const events = d.events || [];
    const totalLabel = `共 ${d.total ?? '?'} 条${d.unprocessed ? `，${d.unprocessed} 条待处理` : ''}`;

    if (events.length === 0) {
      eventsEl.innerHTML = `
        <p class="obs-empty">暂无事件 <small style="color:#9ca3af">${totalLabel}</small></p>`;
      return;
    }

    const rows = events.map(e => {
      const ts = e.createdAt
        ? new Date(e.createdAt).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
          })
        : '—';
      const processed = e.processedAt ? '✓' : '…';
      const processedClass = e.processedAt ? 'obs-badge-ok' : 'obs-badge-pending';
      return `
        <div class="obs-event-row">
          <span class="obs-event-time">${ts}</span>
          <span class="obs-event-type">${escapeHtml(e.type)}</span>
          <span class="obs-event-source">${escapeHtml(e.source || '')}</span>
          <span class="obs-badge ${processedClass}">${processed}</span>
        </div>`;
    }).join('');

    eventsEl.innerHTML = `
      <div class="obs-events-meta">${totalLabel}，显示最近 ${events.length} 条</div>
      <div class="obs-events-scroll">${rows}</div>`;
  } catch (e) {
    eventsEl.innerHTML = `<span class="obs-error">加载失败：${escapeHtml(e.message)}</span>`;
  }
}

/**
 * 渲染三端同步健康度面板
 *
 * @param {{ observabilityApi: object, escapeHtml: Function }} helpers
 */
async function renderSyncPanel(helpers) {
  const { observabilityApi, escapeHtml } = helpers;
  const syncEl = document.getElementById('obsSyncContent');
  if (!syncEl) return;

  syncEl.innerHTML = '<span class="obs-loading">加载中…</span>';
  try {
    const d = await observabilityApi.getSyncHealth('default');
    const pct          = d.taskPrConsistencyPct ?? (d.activeTasks > 0 ? Math.round(d.linkedTasks / d.activeTasks * 100) : 100);
    const isHealthy    = d.health === 'healthy';
    const orphanClass  = d.orphanPRs > 0 ? 'obs-warn' : 'obs-good';
    const healthLabel  = isHealthy ? '✅ 健康' : '⚠️ 降级';
    const healthClass  = isHealthy ? 'obs-good' : 'obs-warn';

    syncEl.innerHTML = `
      <div class="obs-stat-grid">
        <div class="obs-stat">
          <span class="obs-label">整体状态</span>
          <strong class="obs-value ${healthClass}">${healthLabel}</strong>
        </div>
        <div class="obs-stat">
          <span class="obs-label">task↔PR 一致性</span>
          <strong class="obs-value ${pct < 80 ? 'obs-warn' : 'obs-good'}">${pct}%</strong>
        </div>
        <div class="obs-stat">
          <span class="obs-label">孤儿 PR 数</span>
          <strong class="obs-value ${orphanClass}">${d.orphanPRs ?? 0}${d.orphanPRs > 0 ? ' ⚠' : ''}</strong>
        </div>
        <div class="obs-stat">
          <span class="obs-label">防循环签名 (7d)</span>
          <strong class="obs-value">${d.signatureHits7d ?? 0}</strong>
        </div>
      </div>
      <div class="obs-sync-detail">
        <span>进行中任务 ${d.activeTasks ?? '?'} 个，其中 ${d.linkedTasks ?? '?'} 个已关联 PR</span>
      </div>`;
  } catch (e) {
    syncEl.innerHTML = `<span class="obs-error">加载失败：${escapeHtml(e.message)}</span>`;
  }
}

/**
 * 渲染全部观察台面板（并发加载）
 *
 * @param {object} _state     - 当前 state（暂未使用，保留供将来 filter 用）
 * @param {{ observabilityApi: object, escapeHtml: Function }} helpers
 */
export async function renderObservatory(_state, helpers) {
  await Promise.allSettled([
    renderLlmPanel(helpers),
    renderEventsPanel(helpers),
    renderSyncPanel(helpers),
  ]);
}
