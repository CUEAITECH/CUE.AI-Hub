import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile('.github/workflows/auto-assign.yml', 'utf8');

assert.match(workflow, /issues:\s*\n\s+types:\s*\[opened\]/, 'auto-assign workflow must run for opened issues');
assert.doesNotMatch(
  workflow,
  /pull_request:/,
  'auto-assign-issue cannot run on pull_request events because it requires issue context'
);
assert.match(workflow, /pozil\/auto-assign-issue@v1/, 'auto-assign workflow should keep the issue assignment action');

console.log('auto-assign workflow config OK');
