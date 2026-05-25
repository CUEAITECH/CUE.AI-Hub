import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

assert.doesNotMatch(appSource, /fetch\s*\(\s*['"`]\/api/, 'src/app.js must not call legacy /api with raw fetch');

[
  './api/authApi.js',
  './api/projectsApi.js',
  './api/appStateApi.js',
  './api/pullsApi.js',
  './api/eventsApi.js',
  './api/observabilityApi.js'
].forEach((modulePath) => {
  assert.match(appSource, new RegExp(`from ['"]${modulePath.replaceAll('.', '\\.')}['"]`), `src/app.js must import ${modulePath}`);
});

assert.doesNotMatch(appSource, /fetch\s*\(\s*['"`]\/v2\/observability/, 'observability calls must go through observabilityApi');
assert.doesNotMatch(appSource, /fetch\s*\(\s*['"`]\/v2\/space/, 'space calls must go through observabilityApi');

console.log('frontend contract tests OK');

// PR Pipeline: feature 模块不直接调用 fetch() 或引用 /api/ 端点路径
for (const featureFile of [
  'src/features/pr-pipeline/renderPullList.js',
  'src/features/pr-pipeline/PullDrawer.js',
]) {
  const src = readFileSync(new URL(`../${featureFile}`, import.meta.url), 'utf8');
  // Strip single-line comments before checking to avoid false positives from documentation
  const srcNoComments = src.replace(/\/\/[^\n]*/g, '');
  const hasFetch = /\bfetch\s*\(/.test(srcNoComments);
  // Allow import paths like ../../api/pullsApi.js; only flag hardcoded /api/ endpoint strings
  const hasApiEndpoint = /['"`]\/api\//.test(srcNoComments);
  assert(!hasFetch,       `${featureFile} must not call fetch() directly — use pullsApi`);
  assert(!hasApiEndpoint, `${featureFile} must not hardcode /api/ endpoint paths`);
}
console.log('PR Pipeline contract tests OK');

// Work Graph: feature 模块不直接调用 fetch()，不硬编码 /api/ 端点路径
for (const featureFile of [
  'src/features/work-graph/renderTaskTable.js',
  'src/features/work-graph/renderTaskDetail.js',
]) {
  const src = readFileSync(new URL(`../${featureFile}`, import.meta.url), 'utf8');
  // Strip line comments to avoid false positives from documentation mentioning fetch
  const srcNoComments = src.replace(/\/\/.*$/gm, '');
  const hasFetch = /\bfetch\s*\(/.test(srcNoComments);
  const hasApiEndpoint = /['"`]\/api\//.test(srcNoComments);
  assert(!hasFetch,       `${featureFile} must not call fetch() directly`);
  assert(!hasApiEndpoint, `${featureFile} must not hardcode /api/ endpoint paths`);
}
console.log('Work Graph contract tests OK');
