// src/features/pr-pipeline/PrAcChecklist.js
//
// V2 PR 实时 AC Checklist — SSE 驱动，注入到 PR 详情侧滑面板
//
// 契约：
//   - 不直接调用 fetch() / new EventSource()，通过注入的 helpers 完成
//   - streamUrl 由 eventsApi.prReviewStreamUrl() 提供，作为字符串传入
//   - escapeHtml 通过 helpers 注入

// ── 内部状态（模块级，单例） ─────────────────────────────────────
let _sseSource     = null;
let _sseTargetId   = null;
let _lastPayload   = null;

// ── 骨架屏 ───────────────────────────────────────────────────────
function skeletonHtml() {
  return `
    <div class="ac-skeleton-group" aria-label="正在等待 AC 数据" aria-busy="true">
      <div class="ac-skeleton ac-sk-full"></div>
      <div class="ac-skeleton ac-sk-wide"></div>
      <div class="ac-skeleton ac-sk-mid"></div>
      <div class="ac-skeleton ac-sk-wide"></div>
    </div>`;
}

// ── 渲染 checklist ────────────────────────────────────────────────
function renderItems(container, payload, helpers) {
  const { escapeHtml } = helpers;
  const items  = payload?.acItems || payload?.checklist || [];
  const source = payload?.source || 'hub';
  const ts     = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  if (!items.length) {
    container.innerHTML = `
      <div class="ac-empty">
        <span class="ac-empty-icon" aria-hidden="true">📋</span>
        <p class="ac-empty-text">暂无验收条目</p>
      </div>`;
    return;
  }

  const rowsHtml = items.map(item => {
    const status  = item.status || 'pending';
    const text    = escapeHtml(item.text || item.criterion || '');
    const iconCls = status === 'pass' ? 'ac-icon-pass'
                  : status === 'warn' ? 'ac-icon-warn'
                  : status === 'fail' ? 'ac-icon-fail'
                  : 'ac-icon-pending';
    const icon    = status === 'pass'    ? '✓'
                  : status === 'warn'    ? '!'
                  : status === 'fail'    ? '✕'
                  : '…';
    return `
      <li class="ac-item ac-item-${status}" role="listitem">
        <span class="ac-status-icon ${iconCls}" aria-label="${status}">${icon}</span>
        <span class="ac-item-text">${text}</span>
      </li>`;
  }).join('');

  const passCount = items.filter(i => i.status === 'pass').length;
  const total     = items.length;
  const allPass   = passCount === total;
  const summaryClass = allPass ? 'ac-summary-ok' : 'ac-summary-partial';

  container.innerHTML = `
    <div class="ac-checklist" role="region" aria-label="验收对照">
      <div class="ac-checklist-head">
        <span class="ac-head-title">验收对照</span>
        <span class="ac-summary ${summaryClass}">${passCount}/${total} 通过</span>
      </div>
      <ul class="ac-item-list" role="list">${rowsHtml}</ul>
      <p class="ac-checklist-meta">
        来源：${escapeHtml(source)}　${ts}
      </p>
    </div>`;
}

// ── 公开接口 ─────────────────────────────────────────────────────

/**
 * 启动 SSE 订阅，首次渲染骨架屏
 *
 * @param {string}   prId
 * @param {object}   helpers  — { streamUrl: string, escapeHtml: Function }
 */
export function startPrAcSse(prId, helpers) {
  if (_sseSource && _sseTargetId === prId) return; // 已连接
  stopPrAcSse();

  _sseTargetId = prId;
  _lastPayload = null;

  const container = document.getElementById('prAcChecklist');
  if (container) container.innerHTML = skeletonHtml();

  try {
    _sseSource = new EventSource(helpers.streamUrl);
    _sseSource.onmessage = (evt) => {
      try {
        const envelope = JSON.parse(evt.data);
        const payload  = envelope.payload || envelope;
        if (payload?.prId === prId || String(payload?.prNumber) === String(prId)) {
          _lastPayload = payload;
          const el = document.getElementById('prAcChecklist');
          if (el) renderItems(el, payload, helpers);
        }
      } catch { /* skip malformed frames */ }
    };
    _sseSource.onerror = () => { stopPrAcSse(); };
  } catch { /* browser may not support EventSource */ }
}

/**
 * 停止 SSE 订阅，清空面板内容
 */
export function stopPrAcSse() {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
  _sseTargetId = null;
  _lastPayload = null;
  const container = document.getElementById('prAcChecklist');
  if (container) container.innerHTML = '';
}

/**
 * 手动推送 payload（用于测试或主动刷新）
 *
 * @param {string}   prId
 * @param {object}   payload
 * @param {object}   helpers  — { escapeHtml: Function }
 */
export function refreshPrAcChecklist(prId, payload, helpers) {
  _lastPayload = payload;
  const container = document.getElementById('prAcChecklist');
  if (!container) return;
  renderItems(container, payload, helpers);
}
