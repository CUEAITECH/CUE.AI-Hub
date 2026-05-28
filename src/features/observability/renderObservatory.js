// src/features/observability/renderObservatory.js
//
// V5 管理观察台：LLM 调用账本 / 事件流 / 三端同步健康度
//
// 契约：
//   - 不直接调用 fetch()，不持有 /api/ 端点字符串
//   - 所有网络调用通过注入的 observabilityApi helper 完成
//   - escapeHtml 同样通过 helpers 注入

// ── 内部工具 ─────────────────────────────────────────────────────

/** 按 event.type 前缀返回语义化 badge class */
function eventTypeBadgeClass(type = '') {
  if (type.startsWith('llm.'))       return 'obs-tag-llm';
  if (type.startsWith('webhook.'))   return 'obs-tag-webhook';
  if (type.startsWith('pr.'))        return 'obs-tag-pr';
  if (type.startsWith('task.'))      return 'obs-tag-task';
  if (type.startsWith('scheduler.')) return 'obs-tag-scheduler';
  if (type.startsWith('agent.'))     return 'obs-tag-agent';
  if (type.startsWith('sync.'))      return 'obs-tag-sync';
  return 'obs-tag-default';
}

/** 生成骨架屏行 HTML */
function skeletonRows(count = 3) {
  return Array.from({ length: count }, () => `
    <div class="obs-skeleton-row">
      <div class="obs-skeleton obs-sk-wide"></div>
      <div class="obs-skeleton obs-sk-mid"></div>
      <div class="obs-skeleton obs-sk-narrow"></div>
    </div>`).join('');
}

// ── LLM 账本面板 ─────────────────────────────────────────────────

async function renderLlmPanel(helpers) {
  const { observabilityApi, escapeHtml } = helpers;
  const llmEl = document.getElementById('obsLlmContent');
  if (!llmEl) return;

  llmEl.innerHTML = `<div class="obs-skeleton-group">${skeletonRows(2)}</div>`;

  try {
    const d = await observabilityApi.getLlmStats('default');
    const today       = d.today || {};
    const failRatePct = d.recentFailRatePct ?? 0;
    const costYuan  = today.estimatedCostYuan != null ? `¥${today.estimatedCostYuan.toFixed(2)}` : '—';
    const costLabel = today.costSource === 'newapi-quota'
      ? '今日成本 <span class="obs-source-badge">真实扣费</span>'
      : today.costSource === 'newapi-tokens'
        ? '今日成本 <span class="obs-source-badge obs-source-tokens">真实 tokens</span>'
        : d.newApiAvailable && d.newApiError
          ? `今日成本 <span class="obs-source-badge obs-source-err" title="${escapeHtml(d.newApiError)}">NewAPI ⚠</span>`
          : '今日成本 <span class="obs-source-badge obs-source-est">估算</span>';
    const callsLabel = (d.byModel || []).length
      ? '今日调用 <span class="obs-source-badge">NewAPI</span>'
      : '今日调用';
    const totalIn  = (today.totalInput  || 0).toLocaleString();
    const totalOut = (today.totalOutput || 0).toLocaleString();
    const cacheRate  = today.cacheHitRate ?? '—';
    const failClass  = failRatePct > 20 ? 'obs-val-warn' : failRatePct > 5 ? 'obs-val-caution' : 'obs-val-ok';
    const hasNewApi  = (d.byModel || []).length > 0;

    const byModelRows = (d.byModel || []).map(m => `
      <tr>
        <td class="obs-tc">${escapeHtml(m.model)}</td>
        <td class="obs-tc obs-tc-num">${m.calls}</td>
        <td class="obs-tc obs-tc-num obs-tc-dim">${(m.input || 0).toLocaleString()}</td>
        <td class="obs-tc obs-tc-num obs-tc-dim">${(m.output || 0).toLocaleString()}</td>
        <td class="obs-tc obs-tc-num">${m.costYuan != null ? `¥${m.costYuan}` : '—'}</td>
      </tr>`).join('');

    const byPurpRows = (d.byPurpose || []).map(p => `
      <tr>
        <td class="obs-tc">${escapeHtml(p.purpose || '(unknown)')}</td>
        <td class="obs-tc obs-tc-num">${p.calls}</td>
        <td class="obs-tc obs-tc-num obs-tc-dim">${(p.input  || 0).toLocaleString()}</td>
        <td class="obs-tc obs-tc-num obs-tc-dim">${(p.output || 0).toLocaleString()}</td>
      </tr>`).join('');

    llmEl.innerHTML = `
      <div class="obs-kpi-row">
        <div class="obs-kpi">
          <span class="obs-kpi-label">${callsLabel}</span>
          <span class="obs-kpi-value">${today.totalCalls ?? 0}</span>
        </div>
        ${hasNewApi ? `
        <div class="obs-kpi">
          <span class="obs-kpi-label">输入 tokens</span>
          <span class="obs-kpi-value obs-val-dim">${totalIn}</span>
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">输出 tokens</span>
          <span class="obs-kpi-value obs-val-dim">${totalOut}</span>
        </div>` : `
        <div class="obs-kpi">
          <span class="obs-kpi-label">Cache 命中率</span>
          <span class="obs-kpi-value obs-val-ok">${cacheRate}</span>
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">近5min 失败率</span>
          <span class="obs-kpi-value ${failClass}">${failRatePct}%</span>
        </div>`}
        <div class="obs-kpi">
          <span class="obs-kpi-label">${costLabel}</span>
          <span class="obs-kpi-value">${costYuan}</span>
        </div>
      </div>
      ${hasNewApi ? `
      <div class="obs-table-scroll">
        <table class="obs-data-table" aria-label="按模型真实用量（NewAPI）">
          <thead>
            <tr>
              <th class="obs-th">模型</th>
              <th class="obs-th obs-th-num">调用</th>
              <th class="obs-th obs-th-num">输入 tokens</th>
              <th class="obs-th obs-th-num">输出 tokens</th>
              <th class="obs-th obs-th-num">费用</th>
            </tr>
          </thead>
          <tbody>${byModelRows}</tbody>
        </table>
      </div>` : ''}
      ${byPurpRows ? `
      <details class="obs-hub-detail"${hasNewApi ? '' : ' open'}>
        <summary class="obs-hub-summary">Hub 内部调用（按用途）</summary>
      <div class="obs-table-scroll">
        <table class="obs-data-table" aria-label="按用途 LLM 调用明细">
          <thead>
            <tr>
              <th class="obs-th">用途</th>
              <th class="obs-th obs-th-num">调用次数</th>
              <th class="obs-th obs-th-num">输入 tokens</th>
              <th class="obs-th obs-th-num">输出 tokens</th>
            </tr>
          </thead>
          <tbody>${byPurpRows}</tbody>
        </table>
      </div>
      </details>` : ''}`;
  } catch (e) {
    llmEl.innerHTML = `
      <div class="obs-error-state">
        <span class="obs-error-icon" aria-hidden="true">⚠</span>
        <span>${escapeHtml(e.message)}</span>
      </div>`;
  }
}

// ── 事件流面板 ───────────────────────────────────────────────────

async function renderEventsPanel(helpers) {
  const { observabilityApi, escapeHtml } = helpers;
  const eventsEl = document.getElementById('obsEventsContent');
  if (!eventsEl) return;

  eventsEl.innerHTML = `<div class="obs-skeleton-group">${skeletonRows(5)}</div>`;

  const typeFilter = document.getElementById('obsEventTypeFilter')?.value?.trim() || '';
  const srcFilter  = document.getElementById('obsEventSourceFilter')?.value || '';
  const params     = { limit: 50 };
  if (typeFilter) params.type   = typeFilter;
  if (srcFilter)  params.source = srcFilter;

  try {
    const d      = await observabilityApi.getEvents(params, 'default');
    const events = d.events || [];

    if (events.length === 0) {
      eventsEl.innerHTML = `
        <div class="obs-empty-state">
          <span class="obs-empty-icon" aria-hidden="true">📭</span>
          <p class="obs-empty">暂无事件${typeFilter || srcFilter ? '（匹配当前过滤条件）' : ''}</p>
        </div>`;
      return;
    }

    const metaLine = `共 ${d.total ?? '?'} 条${d.unprocessed ? `，<strong class="obs-val-caution">${d.unprocessed}</strong> 条待处理` : ''}，显示最近 ${events.length} 条`;

    const rows = events.map(e => {
      const ts = e.createdAt
        ? new Date(e.createdAt).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit',
            hour:  '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          })
        : '—';
      const tagClass = eventTypeBadgeClass(e.type);
      const processed = e.processedAt ? 'obs-proc-done' : 'obs-proc-pending';
      const procLabel = e.processedAt ? '已处理' : '待处理';
      return `
        <div class="obs-ev-row" role="listitem">
          <span class="obs-ev-ts" aria-label="时间">${ts}</span>
          <span class="obs-ev-tag ${tagClass}" aria-label="事件类型">${escapeHtml(e.type)}</span>
          <span class="obs-ev-src" aria-label="来源">${escapeHtml(e.source || '—')}</span>
          <span class="obs-ev-proc ${processed}" aria-label="${procLabel}"></span>
        </div>`;
    }).join('');

    eventsEl.innerHTML = `
      <p class="obs-events-meta">${metaLine}</p>
      <div class="obs-ev-list" role="list">${rows}</div>`;
  } catch (e) {
    eventsEl.innerHTML = `
      <div class="obs-error-state">
        <span class="obs-error-icon" aria-hidden="true">⚠</span>
        <span>${escapeHtml(e.message)}</span>
      </div>`;
  }
}

// ── 三端同步健康度面板 ───────────────────────────────────────────

async function renderSyncPanel(helpers) {
  const { observabilityApi, escapeHtml } = helpers;
  const syncEl = document.getElementById('obsSyncContent');
  if (!syncEl) return;

  syncEl.innerHTML = `<div class="obs-skeleton-group">${skeletonRows(2)}</div>`;

  try {
    const d          = await observabilityApi.getSyncHealth('default');
    const pct        = d.taskPrConsistencyPct ?? (d.activeTasks > 0 ? Math.round(d.linkedTasks / d.activeTasks * 100) : 100);
    const isHealthy  = d.health === 'healthy';
    const orphanWarn = (d.orphanPRs ?? 0) > 0;
    const healthPill = isHealthy
      ? '<span class="obs-health-pill obs-health-ok">● 健康</span>'
      : '<span class="obs-health-pill obs-health-warn">● 降级</span>';

    const consistencyBar = `
      <div class="obs-progress-wrap" aria-label="task↔PR 一致性 ${pct}%">
        <div class="obs-progress-bar">
          <div class="obs-progress-fill ${pct >= 80 ? 'obs-prog-ok' : 'obs-prog-warn'}"
               style="width: ${Math.min(pct, 100)}%"></div>
        </div>
        <span class="obs-progress-label">${pct}%</span>
      </div>`;

    syncEl.innerHTML = `
      <div class="obs-kpi-row">
        <div class="obs-kpi">
          <span class="obs-kpi-label">整体状态</span>
          ${healthPill}
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">task↔PR 一致性</span>
          ${consistencyBar}
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">孤儿 PR 数</span>
          <span class="obs-kpi-value ${orphanWarn ? 'obs-val-warn' : 'obs-val-ok'}">
            ${d.orphanPRs ?? 0}${orphanWarn ? ' ⚠' : ''}
          </span>
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">防循环签名 (7d)</span>
          <span class="obs-kpi-value">${d.signatureHits7d ?? 0}</span>
        </div>
      </div>
      <p class="obs-sync-footnote">
        进行中任务 <strong>${d.activeTasks ?? '?'}</strong> 个，其中
        <strong>${d.linkedTasks ?? '?'}</strong> 个已关联 PR
      </p>`;
  } catch (e) {
    syncEl.innerHTML = `
      <div class="obs-error-state">
        <span class="obs-error-icon" aria-hidden="true">⚠</span>
        <span>${escapeHtml(e.message)}</span>
      </div>`;
  }
}

// ── 更新刷新时间戳 ───────────────────────────────────────────────

function updateRefreshedAt() {
  const el = document.getElementById('obsRefreshedAt');
  if (el) {
    el.textContent = `刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  }
}

// ── 主入口 ───────────────────────────────────────────────────────

/**
 * 初始化整个观察台的 HTML 结构（动态创建，确保只在观察台显示）
 */
function initObservatory() {
  const container = document.getElementById('observatoryContainer');
  if (!container) return;
  if (document.getElementById('obsLlmPanel')) return; // 已初始化

  container.innerHTML = `
    <div class="obs-view-header">
      <div class="obs-view-title">
        <h2>管理观察台</h2>
        <span class="obs-refreshed-at" id="obsRefreshedAt" aria-live="polite"></span>
      </div>
      <button class="obs-refresh-btn" type="button" id="observatoryRefreshBtn" aria-label="刷新观察台数据">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
        刷新
      </button>
    </div>

    <div class="panel obs-panel" id="obsLlmPanel">
      <div class="obs-panel-header">
        <h3 class="obs-panel-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
          LLM 调用账本
        </h3>
      </div>
      <div id="obsLlmContent"></div>
    </div>

    <div class="panel obs-panel" id="obsEventsPanel">
      <div class="obs-panel-header">
        <h3 class="obs-panel-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          事件流
        </h3>
        <div class="obs-filters" role="search" aria-label="事件过滤">
          <input type="search" id="obsEventTypeFilter" placeholder="按 type 过滤…"
                 class="obs-filter-input" aria-label="事件类型过滤" />
          <select id="obsEventSourceFilter" class="obs-filter-select" aria-label="按来源过滤">
            <option value="">所有来源</option>
            <option value="webhook">webhook</option>
            <option value="llm">llm</option>
            <option value="ui">ui</option>
            <option value="agent">agent</option>
            <option value="scheduler">scheduler</option>
          </select>
        </div>
      </div>
      <div id="obsEventsContent"></div>
    </div>

    <div class="panel obs-panel" id="obsSyncPanel">
      <div class="obs-panel-header">
        <h3 class="obs-panel-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
          三端同步健康度
        </h3>
      </div>
      <div id="obsSyncContent"></div>
    </div>
  `;
}

/**
 * 渲染全部观察台面板（三面板并发加载）
 *
 * @param {object} _state     - 当前 state（保留供将来 filter 使用）
 * @param {{ observabilityApi: object, escapeHtml: Function }} helpers
 */
export async function renderObservatory(_state, helpers) {
  initObservatory();
  await Promise.allSettled([
    renderLlmPanel(helpers),
    renderEventsPanel(helpers),
    renderSyncPanel(helpers),
  ]);
  updateRefreshedAt();
}
