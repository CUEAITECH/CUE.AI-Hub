// src/features/settings/renderSettings.js
// 系统设置页：LLM / NewAPI 配置，支持热更新和 PR-Agent 同步

// ── 骨架屏 ────────────────────────────────────────────────────────
function skeletonField() {
  return `<div class="cfg-skeleton"></div>`;
}

// ── 工具函数 ──────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function sourceBadge(source) {
  if (source === 'db')      return '<span class="cfg-src cfg-src-db">DB</span>';
  if (source === 'env')     return '<span class="cfg-src cfg-src-env">ENV</span>';
  if (source === 'default') return '<span class="cfg-src cfg-src-def">默认</span>';
  return '';
}

// ── 渲染配置项字段 ────────────────────────────────────────────────
function renderField({ key, label, value, source, hasValue, type = 'text', placeholder = '' }) {
  const maskVal = type === 'password' ? '' : escHtml(value || '');
  const placeholderAttr = placeholder
    ? `placeholder="${escHtml(placeholder)}"`
    : (type === 'password' ? 'placeholder="••••••••（留空不更改）"' : '');

  return `
    <div class="cfg-field" data-key="${escHtml(key)}">
      <label class="cfg-label">
        <span class="cfg-label-text">${escHtml(label)}</span>
        ${sourceBadge(source)}
        ${hasValue ? '<span class="cfg-has-val">✓</span>' : '<span class="cfg-no-val">未设置</span>'}
      </label>
      <input
        class="cfg-input"
        type="${type}"
        name="${escHtml(key)}"
        value="${maskVal}"
        ${placeholderAttr}
        autocomplete="off"
        data-original="${maskVal}"
      />
    </div>`;
}

// ── 渲染整页 ─────────────────────────────────────────────────────
function buildHtml(config) {
  const c = config || {};

  const fields = [
    // ── LLM ────────────────────────────────────────────────────
    { group: 'LLM 接口配置', items: [
      { key: 'openai.apiKey',   label: 'API Key',         type: 'password', placeholder: '••••••••（留空不更改）' },
      { key: 'openai.baseUrl',  label: 'Base URL',        placeholder: 'https://api.openai.com/v1' },
      { key: 'openai.model',    label: '主力模型',          placeholder: 'gpt-5.5' },
      { key: 'openai.miniModel',label: '轻量模型（mini）',  placeholder: 'gpt-5.4-mini' },
    ]},
    // ── NewAPI ─────────────────────────────────────────────────
    { group: 'NewAPI 账单配置', items: [
      { key: 'newapi.token',     label: '访问令牌',          type: 'password', placeholder: '••••••••（留空不更改）' },
      { key: 'newapi.userId',    label: '用户 ID',           placeholder: '36736' },
      { key: 'newapi.quotaRate', label: 'Quota 汇率（1 USD = N quota）', placeholder: '500000' },
    ]},
  ];

  const groupsHtml = fields.map(({ group, items }) => `
    <section class="cfg-group">
      <h3 class="cfg-group-title">${escHtml(group)}</h3>
      ${items.map((f) => {
        const entry = c[f.key] || {};
        return renderField({ ...f, value: entry.value || '', source: entry.source || '', hasValue: entry.hasValue || false });
      }).join('')}
    </section>
  `).join('');

  return `
    <div class="cfg-page">
      <div class="cfg-header">
        <h2 class="cfg-title">系统设置</h2>
        <p class="cfg-subtitle">配置立即生效，无需重启服务。API Key 等敏感值在展示时自动打码。</p>
      </div>

      <form id="cfgForm" class="cfg-form" autocomplete="off">
        ${groupsHtml}

        <div class="cfg-actions">
          <button type="submit" class="cfg-btn cfg-btn-primary" id="cfgSaveBtn">
            保存配置
          </button>
          <button type="button" class="cfg-btn cfg-btn-ghost" id="cfgSyncBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            同步到 PR-Agent
          </button>
          <button type="button" class="cfg-btn cfg-btn-ghost" id="cfgReloadBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            重新加载
          </button>
        </div>
      </form>

      <div id="cfgStatus" class="cfg-status" hidden></div>

      <div class="cfg-info-box">
        <strong>说明</strong>
        <ul>
          <li><b>DB</b>：值来自数据库，覆盖 env 变量（前端保存的都写到这里）</li>
          <li><b>ENV</b>：值来自服务器环境变量</li>
          <li><b>默认</b>：内置默认值</li>
          <li>API Key 留空保存 = 删除 DB 覆盖，恢复使用 env 变量</li>
          <li>「同步到 PR-Agent」= 把 API Key 写入 GitHub Secrets，并更新 PR-Agent workflow YAML 的 Base URL + 模型</li>
        </ul>
      </div>
    </div>`;
}

// ── 主入口 ────────────────────────────────────────────────────────
/**
 * @param {object} helpers
 * @param {import('../../api/configApi.js').createConfigApi} helpers.configApi
 * @param {function} helpers.toast
 */
export async function renderSettings(helpers) {
  const { configApi, toast } = helpers;
  const container = document.getElementById('sys-config');
  if (!container) return;

  // 骨架屏
  container.innerHTML = `<div class="cfg-page cfg-loading">
    ${[...Array(6)].map(() => `<div class="cfg-skeleton-block">${skeletonField()}</div>`).join('')}
  </div>`;

  let config;
  try {
    const res = await configApi.getConfig();
    config = res.config || {};
  } catch (e) {
    container.innerHTML = `<div class="cfg-page"><p class="cfg-error">加载配置失败：${escHtml(e.message)}</p></div>`;
    return;
  }

  container.innerHTML = buildHtml(config);
  bindEvents(container, helpers);
}

function bindEvents(container, { configApi, toast }) {
  // 保存
  const form = container.querySelector('#cfgForm');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#cfgSaveBtn');
    btn.disabled = true;
    btn.textContent = '保存中…';

    const entries = {};
    form.querySelectorAll('.cfg-input').forEach((input) => {
      const key = input.closest('.cfg-field')?.dataset.key;
      if (!key) return;
      const val = input.value.trim();
      // 密码框：若为空则跳过（不覆盖已有值）
      if (input.type === 'password' && !val) return;
      entries[key] = val;
    });

    if (!Object.keys(entries).length) {
      showStatus(container, 'info', '没有需要更新的配置项。');
      btn.disabled = false;
      btn.textContent = '保存配置';
      return;
    }

    try {
      const res = await configApi.setConfig(entries);
      showStatus(container, 'ok', `已保存：${res.updated?.join('、') || '配置'}。`);
      toast('配置已保存');
      // 重新加载最新值
      await reloadConfig(container, { configApi, toast });
    } catch (err) {
      showStatus(container, 'err', `保存失败：${err.message}`);
      toast(`保存失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '保存配置';
    }
  });

  // 同步到 PR-Agent
  container.querySelector('#cfgSyncBtn')?.addEventListener('click', async () => {
    const btn = container.querySelector('#cfgSyncBtn');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span>同步中…</span>';

    try {
      const res = await configApi.syncPrAgent();
      const secrets = JSON.stringify(res.results?.secrets || {});
      const yaml    = res.results?.workflowYaml || '—';
      showStatus(container, 'ok',
        `已同步到 ${escHtml(res.repo || '?')}。<br>Secrets：${escHtml(secrets)}；YAML：${escHtml(yaml)}`);
      toast('PR-Agent 同步成功');
    } catch (err) {
      showStatus(container, 'err', `同步失败：${err.message}`);
      toast(`PR-Agent 同步失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });

  // 重新加载
  container.querySelector('#cfgReloadBtn')?.addEventListener('click', async () => {
    await reloadConfig(container, { configApi, toast });
  });
}

async function reloadConfig(container, { configApi, toast }) {
  try {
    const res = await configApi.getConfig();
    const config = res.config || {};
    // 重新渲染内容
    container.innerHTML = buildHtml(config);
    bindEvents(container, { configApi, toast });
  } catch (err) {
    toast(`重新加载失败: ${err.message}`);
  }
}

function showStatus(container, type, html) {
  const el = container.querySelector('#cfgStatus');
  if (!el) return;
  el.hidden = false;
  el.className = `cfg-status cfg-status-${type}`;
  el.innerHTML = html;
  // 5 秒后自动隐藏 ok 状态
  if (type === 'ok') {
    setTimeout(() => { el.hidden = true; }, 5000);
  }
}
