// src/features/observability/renderSpacePanel.js
//
// V3 SPACE 健康度维度扩展 — 注入到健康度弹窗 (#healthModalBody)
//
// 契约：
//   - 不直接调用 fetch()，通过注入的 observabilityApi 完成
//   - 修复原实现中 DOM 选择器错误（getElementById('healthModal') 不存在）

const DIM_META = {
  satisfaction:  { label: 'S — 满意度',    desc: '团队满意度与心理安全感' },
  performance:   { label: 'P — 交付质量',  desc: '故障率、测试覆盖、review 通过' },
  activity:      { label: 'A — 生产活动',  desc: '提交频率、PR 吞吐量' },
  communication: { label: 'C — 协作效率',  desc: '异步沟通、评论回应、文档更新' },
  efficiency:    { label: 'E — 流动效率',  desc: 'PR cycle time、阻塞解除速度' },
};

function scoreColor(s) {
  if (s >= 80) return 'var(--green)';
  if (s >= 60) return 'var(--amber)';
  return 'var(--red)';
}

/**
 * 在健康度弹窗的 #healthModalBody 末尾追加 SPACE 五维数据
 *
 * @param {{ observabilityApi: object }} helpers
 */
export async function loadAndRenderSpacePanel(helpers) {
  const { observabilityApi } = helpers;
  // 正确的选择器：健康度弹窗内容区
  const body = document.getElementById('healthModalBody');
  if (!body) return;

  // 清理上次的注入（幂等）
  body.querySelectorAll('.space-dims-v3').forEach(el => el.remove());

  // 骨架屏占位
  const placeholder = document.createElement('div');
  placeholder.className = 'space-dims-v3 space-dims-loading';
  placeholder.innerHTML = `
    <div class="space-skeleton-row">
      <div class="space-sk space-sk-label"></div>
      <div class="space-sk space-sk-bar"></div>
    </div>`.repeat(5);
  body.appendChild(placeholder);

  try {
    const data = await observabilityApi.getSpace('default');
    if (!data) { placeholder.remove(); return; }

    const dims = data.dimensions || {};
    const windowDays = data.windowDays ?? 14;
    const composite  = data.score ?? data.compositeScore ?? null;
    const grade      = data.grade ?? '';

    const dimRows = Object.entries(DIM_META).map(([key, meta]) => {
      const d     = dims[key] || {};
      const score = Math.round(Number(d.score) ?? 0);
      const trend = d.trend;  // 'up' | 'down' | null
      const trendHtml = trend === 'up'   ? '<span class="space-trend-up">↑</span>'
                      : trend === 'down' ? '<span class="space-trend-down">↓</span>'
                      : '';
      const color = scoreColor(score);
      return `
        <div class="space-dim-row">
          <div class="space-dim-label">
            <span class="space-dim-key">${meta.label}</span>
            <span class="space-dim-desc">${meta.desc}</span>
          </div>
          <div class="space-dim-right">
            <span class="space-dim-score" style="color:${color}">${score}${trendHtml}</span>
            <div class="space-dim-bar-wrap" aria-label="${meta.label} ${score}分">
              <div class="space-dim-bar" style="width:${Math.min(score,100)}%;background:${color}"></div>
            </div>
          </div>
        </div>`;
    }).join('');

    const footerHtml = composite != null
      ? `<p class="space-footer">SPACE 综合分：<strong>${composite}</strong>${grade ? ` ${grade}` : ''} · 窗口 ${windowDays}d</p>`
      : '';

    placeholder.className   = 'space-dims-v3';
    placeholder.innerHTML   = `
      <div class="space-section-head">SPACE 五维（v2）</div>
      <div class="space-dim-list">${dimRows}</div>
      ${footerHtml}`;
  } catch {
    placeholder.className = 'space-dims-v3';
    placeholder.innerHTML = '<p class="space-error">SPACE 数据加载失败</p>';
  }
}
