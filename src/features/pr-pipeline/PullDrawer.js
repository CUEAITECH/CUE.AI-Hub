// src/features/pr-pipeline/PullDrawer.js
// PR Drawer 逻辑：打开/关闭/渲染详情/提交决策
// SSE 回调（startPrAcSse, stopPrAcSse）由 app.js 通过 helpers 传入

import { pullsApi } from '../../api/pullsApi.js';

/** 内部：构建 Drawer 正文 HTML */
function buildPullDrawerHtml(pull, state, { escapeHtml }) {
  const stateLabel = { open: '待合并', merged: '已合并', closed: '已关闭' }[pull.state] || pull.state;
  const linkedTasks = (pull.linkedTaskIds || [])
    .map((id) => {
      const task = (state.tasks || []).find((t) => t.id === id);
      return task ? `<a href="#" onclick="openTaskDetail('${id}'); return false;">${escapeHtml(task.title)}</a>` : id;
    }).join(', ') || '无';

  const complianceHtml = (sourceLabel, compliance) => {
    if (!compliance) return '';
    const done = compliance.done || [];
    const notDone = compliance.notDone || [];
    const needsHumanCheck = compliance.needsHumanCheck || [];
    if (!done.length && !notDone.length && !needsHumanCheck.length) return '';
    const listItems = (arr) => arr.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    return `
      <div class="pr-compliance-section">
        <div class="pr-compliance-header">${sourceLabel} 验收对照</div>
        ${done.length ? `<div class="pr-compliance-bucket bucket-done"><h4>✅ 已完成（${done.length}）</h4><ul>${listItems(done)}</ul></div>` : ''}
        ${notDone.length ? `<div class="pr-compliance-bucket bucket-notdone"><h4>❌ 未完成（${notDone.length}）</h4><ul>${listItems(notDone)}</ul></div>` : ''}
        ${needsHumanCheck.length ? `<div class="pr-compliance-bucket bucket-human"><h4>⚠️ 需人工确认（${needsHumanCheck.length}）</h4><ul>${listItems(needsHumanCheck)}</ul></div>` : ''}
      </div>
    `;
  };

  return `
    <div class="pr-info-row">
      <span class="pull-state-badge ${pull.state}">${stateLabel}</span>
      <span>${escapeHtml(pull.headBranch)} → ${escapeHtml(pull.baseBranch)}</span>
    </div>
    <div class="pr-info-row"><strong>作者：</strong>${escapeHtml(pull.author || '未知')}</div>
    <div class="pr-info-row"><strong>关联任务：</strong>${linkedTasks}</div>
    ${pull.mergedAt ? `<div class="pr-info-row"><strong>合并时间：</strong>${pull.mergedAt.slice(0, 16).replace('T', ' ')}</div>` : ''}

    ${complianceHtml('Hub Review', pull.hubReview?.compliance)}
    ${complianceHtml('PR-Agent', pull.prAgentReview?.compliance)}

    ${pull.hubReview?.level ? (() => {
      const level = pull.hubReview.level;
      const src = pull.hubReview.analysisSource;
      const prAgentMeta = pull.hubReview.prAgentMeta;
      const levelColor = level === 'Block' || level === 'Escalate' ? '#ef4444'
        : level === 'Warning' ? '#f59e0b' : '#22c55e';
      const srcBadge = src === 'llm+pr-agent'
        ? `<span style="font-size:0.75rem;color:#6366f1;margin-left:0.5rem;">✦ Hub AC + PR-Agent</span>`
        : src === 'llm'
          ? `<span style="font-size:0.75rem;color:#22c55e;margin-left:0.5rem;">✦ Hub AI</span>`
          : `<span style="font-size:0.75rem;color:#f59e0b;margin-left:0.5rem;">⚠ 关键词扫描</span>`;
      const effortBadge = prAgentMeta?.effort
        ? `<span style="font-size:0.75rem;color:#9ca3af;margin-left:0.5rem;">审阅工作量 ${'🔵'.repeat(prAgentMeta.effort)}${'⚪'.repeat(5 - prAgentMeta.effort)}</span>`
        : '';
      const secBadge = prAgentMeta?.hasSecurityConcern
        ? `<span style="font-size:0.75rem;color:#ef4444;margin-left:0.5rem;">🔒 安全问题</span>`
        : '';
      return `<div class="pr-info-row" style="margin-top:0.8rem;align-items:center;flex-wrap:wrap;gap:0.25rem;">
        <strong>Hub Review：</strong><span style="color:${levelColor};font-weight:600;">${level}</span>
        ${srcBadge}${effortBadge}${secBadge}
        ${prAgentMeta?.rawUrl ? `<a href="${prAgentMeta.rawUrl}" target="_blank" rel="noopener" style="font-size:0.75rem;color:#6b7280;margin-left:0.5rem;">查看 PR-Agent 原文 →</a>` : ''}
      </div>`;
    })() : ''}

    <div class="pr-decision-row">
      <button class="btn-pass" onclick="submitPullDecision('${pull.id}', 'Pass')">✓ Pass</button>
      <button class="btn-escalate" onclick="submitPullDecision('${pull.id}', 'Escalate')">⚠ Escalate</button>
    </div>
    ${pull.humanDecision ? `<div class="pr-info-row" style="margin-top:0.5rem;color:#6b7280;font-size:0.8rem;">已决策：${pull.humanDecision}（${(pull.humanAt||'').slice(0,10)}）</div>` : ''}
  `;
}

export function openPullDrawer(pullId, state, { escapeHtml, startPrAcSse }) {
  const pull = (state.pulls || []).find((p) => p.id === pullId);
  if (!pull) return;
  const drawer   = document.getElementById('pullDrawer');
  const backdrop = document.getElementById('pullDrawerBackdrop');
  const title    = document.getElementById('pullDrawerTitle');
  const body     = document.getElementById('pullDrawerBody');
  if (!drawer || !body) return;

  title.textContent = `PR #${pull.number}`;
  body.innerHTML = buildPullDrawerHtml(pull, state, { escapeHtml });
  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  if (startPrAcSse) startPrAcSse(pull.number || pullId);
}

export function closePullDrawer({ stopPrAcSse } = {}) {
  document.getElementById('pullDrawer')?.classList.add('hidden');
  document.getElementById('pullDrawerBackdrop')?.classList.add('hidden');
  if (stopPrAcSse) stopPrAcSse();
}

export async function submitPullDecision(pullId, decision, state, { renderPullList, closePullDrawer: close }) {
  try {
    const data = await pullsApi.submitDecision(pullId, decision);
    const idx = (state.pulls || []).findIndex((p) => p.id === pullId);
    if (idx !== -1) state.pulls[idx] = data.pull;
    renderPullList();
    close();
  } catch (err) {
    alert('决策提交失败：' + err.message);
  }
}
