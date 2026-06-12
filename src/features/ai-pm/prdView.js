/**
 * prdView.js — SPEC-L1 前端纯渲染层（无 DOM 依赖，可 node 单测）。
 * 只做"数据 → HTML 字符串"和"DOM 取值 → 数据"两类纯转换。
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 问题数组 + 回答数组 → { [问题]: 回答 }，跳过空白回答 */
export function collectAnswers(questions, values) {
  const out = {};
  (questions || []).forEach((q, i) => {
    const a = String((values || [])[i] ?? '').trim();
    if (a) out[q] = a;
  });
  return out;
}

/** 渲染澄清问题列表：初步理解 + 每题一个 textarea[data-qi] */
export function buildQuestionsHtml(clarifyResult) {
  const understanding = escapeHtml(clarifyResult?.initialUnderstanding || '');
  const questions = clarifyResult?.clarificationQuestions || [];
  const understandingHtml = understanding
    ? `<p class="l1-understanding">💬 ${understanding}</p>` : '';
  const rows = questions.map((q, i) => `
    <div class="l1-q-row">
      <label class="l1-q-label">${i + 1}. ${escapeHtml(q)}</label>
      <textarea class="l1-q-input" data-qi="${i}" rows="2" placeholder="你的回答…"></textarea>
    </div>`).join('');
  return `${understandingHtml}<div class="l1-q-list">${rows}</div>`;
}

/** 渲染 PRD 卡片：分区字段 + 折叠用户故事 */
export function buildPrdCardHtml(prd) {
  const p = prd || {};
  const list = (arr) => (arr && arr.length)
    ? `<ul class="l1-prd-ul">${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : '<span class="l1-muted">—</span>';
  const story = (s) => `
    <div class="l1-story">
      <strong>${escapeHtml(s.id || 'US')}</strong>
      作为 ${escapeHtml(s.as || '—')}，我想 ${escapeHtml(s.want || '—')}，以便 ${escapeHtml(s.so || '—')}。
      <em>验收：${escapeHtml(s.acceptance || '—')}</em>
    </div>`;
  const stories = (p.userStories && p.userStories.length)
    ? p.userStories.map(story).join('')
    : '<span class="l1-muted">—</span>';
  return `
    <div class="l1-prd-card">
      <div class="l1-prd-row"><span class="l1-prd-k">标题</span><span class="l1-prd-v">${escapeHtml(p.title) || '<span class="l1-muted">—</span>'}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">目标</span><span class="l1-prd-v">${escapeHtml(p.goal) || '<span class="l1-muted">—</span>'}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">验收条件</span><span class="l1-prd-v">${list(p.acceptance)}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">范围</span><span class="l1-prd-v">${list(p.scope)}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">不做</span><span class="l1-prd-v">${list(p.nonGoals)}</span></div>
      <div class="l1-prd-row"><span class="l1-prd-k">风险</span><span class="l1-prd-v">${list(p.risks)}</span></div>
      <details class="l1-prd-stories"><summary>用户故事（${(p.userStories || []).length}）</summary>${stories}</details>
    </div>`;
}
