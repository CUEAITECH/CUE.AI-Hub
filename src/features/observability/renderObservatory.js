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
    const costYuan    = today.estimatedCostYuan != null ? `¥${today.estimatedCostYuan.toFixed(2)}` : '—';
    const cacheRate   = today.cacheHitRate ?? '—';
    const failClass   = failRatePct > 20 ? 'obs-val-warn' : failRatePct > 5 ? 'obs-val-caution' : 'obs-val-ok';

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
          <span class="obs-kpi-label">今日调用</span>
          <span class="obs-kpi-value">${today.totalCalls ?? 0}</span>
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">Cache 命中率</span>
          <span class="obs-kpi-value obs-val-ok">${cacheRate}</span>
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">近5min 失败率</span>
          <span class="obs-kpi-value ${failClass}">${failRatePct}%</span>
        </div>
        <div class="obs-kpi">
          <span class="obs-kpi-label">今日成本</span>
          <span class="obs-kpi-value">${costYuan}</span>
        </div>
      </div>
      ${byPurpRows ? `
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
      </div>` : '<p class="obs-empty">今日暂无 LLM 调用记录</p>'}`;
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
 * 渲染全部观察台面板（三面板并发加载）
 *
 * @param {object} _state     - 当前 state（保留供将来 filter 使用）
 * @param {{ observabilityApi: object, escapeHtml: Function }} helpers
 */
export async function renderObservatory(_state, helpers) {
  await Promise.allSettled([
    renderLlmPanel(helpers),
    renderEventsPanel(helpers),
    renderSyncPanel(helpers),
  ]);
  updateRefreshedAt();
}
