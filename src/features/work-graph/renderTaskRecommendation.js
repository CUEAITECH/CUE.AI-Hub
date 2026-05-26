// src/features/work-graph/renderTaskRecommendation.js
//
// V1 任务卡片"推荐理由"区块
// 展示推荐引擎对 top actor 的评分理由（来自 /v2/tasks/:id/explanation）
//
// 契约：
//   - 不直接调用 fetch()；通过注入的 tasksApi 完成
//   - escapeHtml 通过 helpers 注入

// ── 内存缓存（会话级，模块单例） ─────────────────────────────────
const _cache = new Map();

// ── 渲染 ─────────────────────────────────────────────────────────

function renderBlock(explanation, escapeHtml) {
  if (!explanation?.topActor) return '';

  const { displayName, type, confidence, explanation: reason, scoreBreakdown } = explanation.topActor;
  const confPct    = Math.round((confidence || 0.5) * 100);
  const isAgent    = type === 'ai-agent';
  const typeLabel  = isAgent ? 'AI Agent' : '成员推荐';
  const typeClass  = isAgent ? 'rec-type-agent' : 'rec-type-member';

  const dimRows = scoreBreakdown
    ? Object.entries(scoreBreakdown).slice(0, 5).map(([k, v]) => {
        const num = typeof v === 'number' ? v : parseFloat(v);
        const barPct = isNaN(num) ? 0 : Math.min(Math.abs(num) * 100, 100).toFixed(0);
        const valStr = isNaN(num) ? String(v) : num.toFixed(2);
        return `
          <div class="rec-dim-row">
            <span class="rec-dim-key">${escapeHtml(k)}</span>
            <div class="rec-dim-bar-wrap">
              <div class="rec-dim-bar" style="width:${barPct}%"></div>
            </div>
            <span class="rec-dim-val">${valStr}</span>
          </div>`;
      }).join('')
    : '';

  return `
    <div class="rec-block">
      <button class="rec-toggle" type="button" aria-expanded="false" aria-controls="recBody">
        <span class="rec-toggle-icon" aria-hidden="true">›</span>
        <span class="rec-label">
          <span class="rec-type-pill ${typeClass}">${typeLabel}</span>
          为什么推给 <strong>${escapeHtml(displayName)}</strong>
        </span>
        <span class="rec-conf">${confPct}%</span>
      </button>
      <div class="rec-body" id="recBody" hidden>
        ${reason ? `<p class="rec-reason">${escapeHtml(reason)}</p>` : ''}
        ${dimRows ? `<div class="rec-dims">${dimRows}</div>` : ''}
      </div>
    </div>`;
}

// ── 公开接口 ─────────────────────────────────────────────────────

/**
 * 异步加载任务推荐理由并注入到 #taskDetailRecommendation
 *
 * @param {string} taskId
 * @param {{ tasksApi: object, escapeHtml: Function }} helpers
 */
export async function enrichTaskDetailWithExplanation(taskId, helpers) {
  const { tasksApi, escapeHtml } = helpers;
  const container = document.getElementById('taskDetailRecommendation');
  if (!container) return;

  // 骨架屏
  container.innerHTML = `<div class="rec-skeleton"><div class="rec-sk rec-sk-line"></div></div>`;

  try {
    let data;
    if (_cache.has(taskId)) {
      data = _cache.get(taskId);
    } else {
      data = await tasksApi.getTaskExplanation(taskId).catch(() => null);
      _cache.set(taskId, data);
    }
    const html = renderBlock(data, escapeHtml);
    container.innerHTML = html;

    // Wire accordion toggle
    const btn = container.querySelector('.rec-toggle');
    const body = container.querySelector('.rec-body');
    if (btn && body) {
      btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        body.hidden = expanded;
        btn.querySelector('.rec-toggle-icon').textContent = expanded ? '›' : '‹';
      });
    }
  } catch {
    container.innerHTML = '';
  }
}
