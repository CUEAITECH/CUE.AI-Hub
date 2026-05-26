import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

assert.match(
  appSource,
  /state\.pulls\s*=\s*payload\.pulls\s*\|\|\s*\[\]/,
  'loadState should hydrate state.pulls from the project state payload'
);
assert.match(
  appSource,
  /container\.innerHTML\s*=\s*`<div class="empty-hint error">PR 加载失败/,
  'fetchAndRenderPulls catch block should render an error instead of leaving the initial loading state'
);

console.log('PR page loading state OK');
