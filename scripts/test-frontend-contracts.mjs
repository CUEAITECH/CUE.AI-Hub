import assert from 'node:assert/strict';
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
