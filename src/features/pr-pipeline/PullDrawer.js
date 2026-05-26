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
      return task ? `<a href="#" class="pr-linked-task" onclick="openTaskDetail('${id}'); return false;">${escapeHtml(task.title)}</a>` : `<span class="pr-linked-task">${escapeHtml(id)}</span>`;
    }).join('') || '<span class="pr-linked-task muted">暂无关联任务</span>';
  const reviewLevel = pull.hubReview?.level || pull.prAgentReview?.level || '未审阅';
  const reviewSource = pull.hubReview?.level ? 'Hub Review' : pull.prAgentReview?.level ? 'PR-Agent' : 'Review';
  const hubReviewMetaHtml = (() => {
    if (!pull.hubReview?.level) return '';
    const level = pull.hubReview.level;
    const src = pull.hubReview.analysisSource;
    const prAgentMeta = pull.hubReview.prAgentMeta;
    const sourceLabel = src === 'llm+pr-agent' ? 'Hub AC + PR-Agent'
      : src === 'llm' ? 'Hub AI'
        : '关键词扫描';
    const effort = Number(prAgentMeta?.effort || 0);
    const effortText = effort > 0 ? `审阅工作量 ${'●'.repeat(effort)}${'○'.repeat(Math.max(0, 5 - effort))}` : '';
    return `
      <div class="pr-review-meta">
        <strong>Hub Review</strong>
        <span class="level-${String(level).toLowerCase()}">${escapeHtml(level)}</span>
        <em>${escapeHtml(sourceLabel)}</em>
        ${effortText ? `<small>${escapeHtml(effortText)}</small>` : ''}
        ${prAgentMeta?.hasSecurityConcern ? '<small class="danger">安全问题</small>' : ''}
        ${prAgentMeta?.rawUrl ? `<a href="${escapeHtml(prAgentMeta.rawUrl)}" target="_blank" rel="noopener">查看 PR-Agent 原文</a>` : ''}
      </div>
    `;
  })();

  const complianceHtml = (sourceLabel, compliance) => {
    if (!compliance) return '';
    const done = compliance.done || [];
    const notDone = compliance.notDone || [];
    const needsHumanCheck = compliance.needsHumanCheck || [];
    if (!done.length && !notDone.length && !needsHumanCheck.length) return '';
    const listItems = (arr) => arr.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    return `
      <div class="pr-compliance-section">
        <div class="pr-compliance-header"><span>${sourceLabel} 验收对照</span><small>${done.length + notDone.length + needsHumanCheck.length} 项</small></div>
        <div class="pr-compliance-grid">
          ${done.length ? `<div class="pr-compliance-bucket bucket-done"><h4>已完成 · ${done.length}</h4><ul>${listItems(done)}</ul></div>` : ''}
          ${notDone.length ? `<div class="pr-compliance-bucket bucket-notdone"><h4>仍有缺口 · ${notDone.length}</h4><ul>${listItems(notDone)}</ul></div>` : ''}
          ${needsHumanCheck.length ? `<div class="pr-compliance-bucket bucket-human"><h4>人工确认 · ${needsHumanCheck.length}</h4><ul>${listItems(needsHumanCheck)}</ul></div>` : ''}
        </div>
      </div>
    `;
  };

  return `
    <div class="pr-drawer-hero">
      <div>
        <span class="pull-number">#${pull.number}</span>
        <h3>${escapeHtml(pull.title || '未命名 PR')}</h3>
      </div>
      <span class="pull-state-badge ${pull.state}">${stateLabel}</span>
    </div>
    <div class="pr-branch-flow">
      <span>${escapeHtml(pull.headBranch || 'head')}</span>
      <b>→</b>
      <span>${escapeHtml(pull.baseBranch || 'base')}</span>
    </div>
    <div class="pr-summary-grid">
      <div><span>作者</span><b>${escapeHtml(pull.author || '未知')}</b></div>
      <div><span>${reviewSource}</span><b>${escapeHtml(reviewLevel)}</b></div>
      <div><span>合并时间</span><b>${pull.mergedAt ? pull.mergedAt.slice(0, 16).replace('T', ' ') : '尚未合并'}</b></div>
    </div>
    <div class="pr-linked-section">
      <span>关联任务</span>
      <div>${linkedTasks}</div>
    </div>

    ${complianceHtml('Hub Review', pull.hubReview?.compliance)}
    ${complianceHtml('PR-Agent', pull.prAgentReview?.compliance)}
    ${hubReviewMetaHtml}

    <div class="pr-decision-row">
      <button class="btn-pass" onclick="submitPullDecision('${pull.id}', 'Pass')">标记 Pass</button>
      <button class="btn-escalate" onclick="submitPullDecision('${pull.id}', 'Escalate')">升级 Escalate</button>
    </div>
    ${pull.humanDecision ? `<div class="pr-human-decision">已决策：${escapeHtml(pull.humanDecision)} · ${(pull.humanAt||'').slice(0,10)}</div>` : ''}
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
