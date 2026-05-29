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

      <section class="cfg-group" id="cfgOrgSection">
        <h3 class="cfg-group-title">组织管理</h3>
        <p class="cfg-gateway-desc">查看并管理你所在的组织，邀请成员加入当前组织。</p>
        <div id="cfgOrgList" class="cfg-gateway-list"><p class="cfg-gateway-empty">加载中…</p></div>
        <form id="cfgInviteForm" class="cfg-gateway-create" autocomplete="off" style="margin-top:12px;">
          <h4 style="margin:0 0 10px;font-size:.88rem;color:var(--text-muted);">邀请成员到当前组织</h4>
          <div class="cfg-field">
            <label class="cfg-label"><span class="cfg-label-text">用户名 / 邮箱 / 手机号</span></label>
            <input class="cfg-input" id="inviteIdentifier" type="text" placeholder="输入已注册的用户名、邮箱或手机号" autocomplete="off" />
          </div>
          <div class="cfg-field">
            <label class="cfg-label"><span class="cfg-label-text">角色</span></label>
            <select class="cfg-input" id="inviteRole">
              <option value="developer">开发者</option>
              <option value="hr_manager">HR 管理员</option>
              <option value="project_admin">组织管理员</option>
            </select>
          </div>
          <button type="submit" class="cfg-btn cfg-btn-primary" id="inviteBtn">邀请加入</button>
        </form>
      </section>

      <section class="cfg-group cfg-group-gateway" id="cfgGatewaySection">
        <h3 class="cfg-group-title">API 访问密钥</h3>
        <p class="cfg-gateway-desc">生成密钥后可在外部系统中以 <code>Authorization: Bearer cue_xxx</code> 头调用本 API。密钥仅在创建时完整显示一次。</p>
        <div id="cfgGatewayList" class="cfg-gateway-list">
          <p class="cfg-gateway-empty">加载中…</p>
        </div>
        <form id="cfgGatewayForm" class="cfg-gateway-create" autocomplete="off">
          <div class="cfg-field">
            <label class="cfg-label"><span class="cfg-label-text">密钥名称</span></label>
            <input class="cfg-input" id="gwKeyName" type="text" placeholder="用途描述，例如：production-server" autocomplete="off" />
          </div>
          <div class="cfg-field">
            <label class="cfg-label"><span class="cfg-label-text">速率限制（次/分钟）</span></label>
            <input class="cfg-input" id="gwRateLimit" type="number" value="100" min="1" max="10000" autocomplete="off" />
          </div>
          <button type="submit" class="cfg-btn cfg-btn-primary" id="gwCreateBtn">生成新 API Key</button>
        </form>
      </section>

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
 * @param {import('../../api/authApi.js').createAuthApi}   helpers.authApi
 * @param {function} helpers.toast
 * @param {function} [helpers.getCurrentOrgId] - 返回当前登录的 orgId
 */
export async function renderSettings(helpers) {
  const { configApi, gatewayApi, authApi, toast, getCurrentOrgId } = helpers;
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
  // 加载组织成员列表
  if (authApi) {
    loadOrgMembers(container, authApi, getCurrentOrgId?.() || '', toast);
  }
  // 加载 API 密钥列表（如果 gatewayApi 可用）
  if (gatewayApi) {
    loadGatewayKeys(container, gatewayApi, toast);
  }
}

function bindEvents(container, helpers) {
  const { configApi, gatewayApi, toast } = helpers;
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
      await reloadConfig(container, { configApi, gatewayApi, toast });
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
    await reloadConfig(container, { configApi, gatewayApi, toast });
  });

  // 组织管理：邀请成员
  const inviteForm = container.querySelector('#cfgInviteForm');
  inviteForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn        = container.querySelector('#inviteBtn');
    const identifier = container.querySelector('#inviteIdentifier')?.value?.trim() || '';
    const role       = container.querySelector('#inviteRole')?.value || 'developer';
    const orgId      = helpers?.getCurrentOrgId?.() || '';
    if (!identifier) { toast('请填写用户名、邮箱或手机号'); return; }
    if (!orgId)      { toast('请先选择要管理的组织'); return; }
    btn.disabled = true;
    btn.textContent = '邀请中…';
    try {
      await helpers.authApi.inviteMember(orgId, { username: identifier, role });
      toast(`已邀请 ${identifier} 加入组织`);
      container.querySelector('#inviteIdentifier').value = '';
      // 刷新成员列表
      loadOrgMembers(container, helpers.authApi, orgId, toast);
    } catch (err) {
      toast(`邀请失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '邀请加入';
    }
  });

  // API 密钥：创建
  const gwForm = container.querySelector('#cfgGatewayForm');
  gwForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#gwCreateBtn');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const name      = container.querySelector('#gwKeyName')?.value?.trim() || undefined;
      const rateLimit = parseInt(container.querySelector('#gwRateLimit')?.value || '100', 10);
      const res = await gatewayApi.createKey({ name, rateLimit });
      // 一次性展示完整密钥
      showNewKeyModal(container, res.key, res.keyPrefix);
      // 刷新列表
      await loadGatewayKeys(container, gatewayApi, toast);
      // 重置表单
      container.querySelector('#gwKeyName').value = '';
    } catch (err) {
      showStatus(container, 'err', `生成密钥失败：${escHtml(err.message)}`);
      toast(`生成密钥失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '生成新 API Key';
    }
  });
}

async function reloadConfig(container, { configApi, gatewayApi, toast }) {
  try {
    const res = await configApi.getConfig();
    const config = res.config || {};
    // 重新渲染内容
    container.innerHTML = buildHtml(config);
    bindEvents(container, { configApi, gatewayApi, toast });
    if (gatewayApi) {
      loadGatewayKeys(container, gatewayApi, toast);
    }
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

// ── 组织成员列表 ──────────────────────────────────────────────────
async function loadOrgMembers(container, authApi, orgId, toast) {
  const listEl = container.querySelector('#cfgOrgList');
  if (!listEl) return;
  try {
    const res  = await authApi.listOrgs();
    const orgs = res.orgs || [];
    if (!orgs.length) {
      listEl.innerHTML = '<p class="cfg-gateway-empty">你目前没有加入任何组织。</p>';
      return;
    }
    const roleLabel = (role) => ({ admin: '系统管理员', project_admin: '组织管理员', hr_manager: 'HR', developer: '开发者' }[role] || role);
    listEl.innerHTML = `
      <table class="cfg-key-table" style="width:100%;border-collapse:collapse;font-size:.85rem;">
        <thead>
          <tr style="color:var(--text-muted);text-align:left;">
            <th style="padding:6px 8px;border-bottom:1px solid var(--border);">组织名称</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--border);">ID</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--border);">简介</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--border);">当前</th>
          </tr>
        </thead>
        <tbody>
          ${orgs.map((org) => `
            <tr>
              <td style="padding:6px 8px;">${escHtml(org.name)}</td>
              <td style="padding:6px 8px;color:var(--text-muted);font-family:monospace;font-size:.78rem;">${escHtml(org.id)}</td>
              <td style="padding:6px 8px;color:var(--text-muted);">${escHtml(org.summary || '—')}</td>
              <td style="padding:6px 8px;">${org.id === orgId ? '✓' : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    listEl.innerHTML = `<p class="cfg-gateway-empty" style="color:var(--red);">加载组织列表失败：${escHtml(err.message)}</p>`;
  }
}

async function loadGatewayKeys(container, gatewayApi, toast) {
  const listEl = container.querySelector('#cfgGatewayList');
  if (!listEl) return;
  try {
    const res = await gatewayApi.listKeys();
    const keys = res.keys || [];
    if (!keys.length) {
      listEl.innerHTML = '<p class="cfg-gateway-empty">暂无 API Key，点击下方按钮生成。</p>';
      return;
    }
    listEl.innerHTML = `
      <table class="cfg-gateway-table">
        <thead><tr>
          <th>名称</th><th>前缀</th><th>权限</th><th>速率限制</th><th>最后使用</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${keys.map((k) => `
            <tr data-key-id="${k.id}">
              <td>${escHtml(k.name || '—')}</td>
              <td><code>${escHtml(k.key_prefix)}</code></td>
              <td>${escHtml((k.scopes || []).join(', '))}</td>
              <td>${escHtml(String(k.rate_limit))}/min</td>
              <td>${k.last_used ? escHtml(k.last_used.slice(0, 16).replace('T', ' ')) : '从未'}</td>
              <td><button class="cfg-btn cfg-btn-danger cfg-btn-sm gw-revoke-btn" data-id="${k.id}">撤销</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
    // 绑定撤销按钮
    listEl.querySelectorAll('.gw-revoke-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('确认撤销此 API Key？撤销后无法恢复。')) return;
        btn.disabled = true;
        btn.textContent = '撤销中…';
        try {
          await gatewayApi.revokeKey(btn.dataset.id);
          await loadGatewayKeys(container, gatewayApi, toast);
          toast('API Key 已撤销');
        } catch (err) {
          toast(`撤销失败: ${err.message}`);
          btn.disabled = false;
          btn.textContent = '撤销';
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<p class="cfg-gateway-empty cfg-error">加载密钥列表失败：${escHtml(err.message)}</p>`;
  }
}

function showNewKeyModal(container, fullKey, keyPrefix) {
  // 移除已有弹窗
  document.querySelector('#gwNewKeyModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'gwNewKeyModal';
  modal.className = 'cfg-modal-overlay';
  modal.innerHTML = `
    <div class="cfg-modal">
      <h3 class="cfg-modal-title">🔑 新 API Key 已生成</h3>
      <p class="cfg-modal-warn">⚠️ 请立即复制并安全保存。此密钥不会再次显示。</p>
      <div class="cfg-key-display">
        <code id="gwNewKeyText">${escHtml(fullKey)}</code>
        <button class="cfg-btn cfg-btn-ghost cfg-btn-sm" id="gwCopyBtn">复制</button>
      </div>
      <p class="cfg-modal-note">前缀：<code>${escHtml(keyPrefix)}</code>（列表中显示的标识）</p>
      <div class="cfg-modal-actions">
        <button class="cfg-btn cfg-btn-primary" id="gwModalClose">已复制，关闭</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#gwCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(fullKey).then(() => {
      const btn = modal.querySelector('#gwCopyBtn');
      if (btn) { btn.textContent = '已复制 ✓'; }
    }).catch(() => {
      // 降级：选中文字
      const code = modal.querySelector('#gwNewKeyText');
      if (code) {
        const range = document.createRange();
        range.selectNode(code);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    });
  });

  modal.querySelector('#gwModalClose')?.addEventListener('click', () => modal.remove());
  // 点击遮罩关闭
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}
