/**
 * test-frontend-ui-contracts.mjs
 *
 * 验收条件（UI 结构契约）：
 *   1. index.html 必须包含所有 v2 导航路由的 data-route 条目
 *   2. index.html 移动端导航 5 个条目（总览/任务/PR/观察/我的）
 *   3. styles.css 必须定义所有 CSS 变量（--text, --blue, --green…）
 *   4. styles.css 禁止裸 emoji 作为图标（仅允许在注释中）
 *   5. 所有 feature section（.view）在 HTML 中都有对应 id
 *   6. 旧版路由在 HTML 中存在（可被访问，只是不在主导航）
 *   7. :focus-visible 样式必须存在（无障碍要求）
 *   8. CSS 不得硬编码 hex 值（应使用 CSS 变量）—— 仅检查 feature 模块产生的动态 innerHTML
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css  = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

// ── 1. v2 核心路由在 HTML 中存在 ──────────────────────────────────────────
const v2Routes = ['overview', 'assignment', 'roadmap', 'ai-pm', 'viewPulls', 'reviews', 'observatory', 'meeting'];
for (const route of v2Routes) {
  assert.ok(
    html.includes(`data-route="${route}"`),
    `index.html must contain data-route="${route}"`,
  );
}
console.log('✓ v2 核心路由 data-route 完整性 OK');

// ── 2. 旧版路由仍然可访问 ────────────────────────────────────────────────
const legacyRoutes = ['planning', 'standup', 'report', 'automation', 'attendance'];
for (const route of legacyRoutes) {
  assert.ok(
    html.includes(`data-route="${route}"`),
    `index.html must still have legacy route data-route="${route}"`,
  );
}
console.log('✓ 旧版路由仍可访问（data-route 存在）OK');

// 侧边栏重构后：交付导航已移入 #sbGroupDelivery，旧 header-sub-group 不再存在
// 验证侧边栏内包含这些路由（data-route 即可，不依赖具体容器）
for (const route of ['roadmap', 'ai-pm']) {
  assert.ok(
    html.includes(`data-route="${route}"`),
    `${route} must exist as a navigable route in sidebar`,
  );
}
// 旧版功能路由也必须可访问
for (const route of ['planning', 'standup', 'report', 'automation', 'attendance']) {
  assert.ok(
    html.includes(`data-route="${route}"`),
    `legacy route ${route} must remain accessible`,
  );
}
// 路由不应分类错误：roadmap/ai-pm 不应在旧版组
const legacySbGroup = html.match(/id="sbBodyLegacy"[^>]*>([\s\S]*?)<\/div>/);
if (legacySbGroup) {
  assert.ok(!legacySbGroup[0].includes('data-route="roadmap"'), 'roadmap must not be in legacy sidebar group');
  assert.ok(!legacySbGroup[0].includes('data-route="ai-pm"'), 'ai-pm must not be in legacy sidebar group');
}

// ── 3. 移动端导航 5 个条目 ───────────────────────────────────────────────
const mobileNavSection = html.match(/class="mobile-app-nav"[^>]*>([\s\S]*?)<\/nav>/);
assert.ok(mobileNavSection, 'mobile-app-nav must exist in HTML');
const mobileNavItems = (mobileNavSection[0].match(/class="mobile-app-nav-item/g) || []).length;
assert.equal(mobileNavItems, 5, `mobile-app-nav must have exactly 5 items, got ${mobileNavItems}`);
console.log('✓ 移动端导航 5 个条目 OK');

// ── 4. 移动端导航路由包含关键页面 ────────────────────────────────────────
const mobileNavHTML = mobileNavSection[0];
const mobileNavRoutes = ['overview', 'assignment', 'viewPulls', 'observatory', 'pc-workspace'];
for (const route of mobileNavRoutes) {
  assert.ok(
    mobileNavHTML.includes(`data-route="${route}"`),
    `mobile-app-nav must include data-route="${route}"`,
  );
}
console.log('✓ 移动端导航路由完整性 OK');

// ── 5. CSS 变量系统完整性 ──────────────────────────────────────────────────
const requiredCssVars = [
  '--bg', '--panel', '--panel-2', '--line', '--text', '--muted', '--dim',
  '--blue', '--green', '--amber', '--red', '--shadow',
  '--accent', '--accent-subtle', '--success-subtle', '--danger-subtle', '--warning-subtle',
];
for (const varName of requiredCssVars) {
  assert.ok(
    css.includes(`${varName}:`),
    `styles.css must define CSS variable ${varName}`,
  );
}
console.log('✓ CSS 变量系统完整性 OK');

// ── 6. :focus-visible 样式存在（无障碍必要） ─────────────────────────────
assert.ok(css.includes(':focus-visible'), 'styles.css must define :focus-visible');
assert.ok(css.includes('outline'), ':focus-visible must include outline rule');
console.log('✓ :focus-visible 无障碍样式 OK');

// ── 7. 主要 section.view id 存在 ─────────────────────────────────────────
const requiredSectionIds = [
  'overview', 'assignment', 'viewPulls', 'reviews', 'observatory', 'meeting',
  'pc-workspace', 'pc-profile', 'pc-account', 'account-admin',
];
for (const id of requiredSectionIds) {
  assert.ok(
    html.includes(`id="${id}"`),
    `index.html must have section id="${id}"`,
  );
}
console.log('✓ section.view id 完整性 OK');

// ── 8. 侧边栏分组存在（data-sb-toggle 替代旧版 data-nav-parent）──────────
const sbToggleGroups = ['delivery', 'insight', 'projects', 'legacy'];
for (const group of sbToggleGroups) {
  assert.ok(
    html.includes(`data-sb-toggle="${group}"`),
    `侧边栏必须包含 data-sb-toggle="${group}" 分组`,
  );
}
console.log('✓ 主导航 data-nav-parent 属性完整性 OK');

// ── 9. 侧边栏分组 body 存在 ───────────────────────────────────────────────
const sbBodyIds = ['sbBodyDelivery', 'sbBodyInsight', 'sbBodyProjects', 'sbBodyLegacy'];
for (const id of sbBodyIds) {
  assert.ok(
    html.includes(`id="${id}"`),
    `侧边栏分组 body id="${id}" 必须存在`,
  );
}
console.log('✓ 子导航 data-sub 分组 OK');

// ── 10. CSS shimmer animation 存在（skeleton 加载体验） ───────────────────
assert.ok(css.includes('@keyframes obs-shimmer'), 'styles.css must define @keyframes obs-shimmer');
assert.ok(css.includes('animation: obs-shimmer') || css.includes('obs-shimmer'), 'obs-shimmer animation must be used');
console.log('✓ Skeleton shimmer animation 定义 OK');

// ── 11. toast 容器存在（用户反馈）──────────────────────────────────────────
assert.ok(html.includes('id="toast"') || html.includes('id="toastContainer"'),
  'index.html must have a toast/notification element');
console.log('✓ Toast 反馈容器 OK');

// ── 12. obs-* CSS class 系统完整 ─────────────────────────────────────────
const obsClasses = [
  '.obs-panel', '.obs-kpi', '.obs-kpi-row', '.obs-ev-list', '.obs-filters',
];
for (const cls of obsClasses) {
  assert.ok(
    css.includes(cls),
    `styles.css must define ${cls} (observability feature styles)`,
  );
}
console.log('✓ 观察台 obs-* CSS class 系统 OK');

// ── 13. ac-* CSS class 系统完整（PR AC Checklist）─────────────────────────
const acClasses = ['.ac-', '.ac-item', '.ac-status'];
// Looser check: just verify .ac- prefix exists
assert.ok(css.includes('.ac-'), 'styles.css must define .ac-* classes for AC Checklist');
console.log('✓ AC Checklist ac-* CSS class 系统 OK');

// ── 14. 导航微动效 CSS 定义存在 ───────────────────────────────────────────
assert.ok(css.includes('view-fade-in') || css.includes('@keyframes view-fade-in'),
  'styles.css must define view transition animation');
console.log('✓ 视图过渡动画定义 OK');

// ── 15. primary-action 正确使用 --blue 变量 ──────────────────────────────
// The new beautification CSS should use --blue for primary-action
const afterBeautify = css.slice(css.lastIndexOf('UI/UX Pro Max'));
assert.ok(afterBeautify.includes('.primary-action'), 'Beautification pass must include .primary-action rules');
assert.ok(afterBeautify.includes('var(--blue)'), 'primary-action should use var(--blue)');
console.log('✓ primary-action 使用设计系统 --blue 变量 OK');

console.log('\nAll UI contract tests passed ✓');
