import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const unitRunner = await readFile(new URL('./run-unit-tests.mjs', import.meta.url), 'utf8');
const heavyRunner = await readFile(new URL('./run-heavy-tests.mjs', import.meta.url), 'utf8');
const testFileRunner = await readFile(new URL('./run-test-file.mjs', import.meta.url), 'utf8').catch(() => '');

assert.ok(packageJson.scripts['test:quick'], 'package.json must expose a fast test:quick script');
assert.ok(packageJson.scripts['test:heavy'], 'package.json must expose a separate test:heavy script for long regressions');
assert.match(packageJson.scripts['test:ci'], /test:quick/, 'test:ci must run the quick gate first');
assert.match(packageJson.scripts['test:ci'], /test:heavy/, 'test:ci must keep heavy regressions as a separate stage');
assert.match(unitRunner, /TEST_TIMEOUT_MS/, 'unit test runner must support a per-file timeout');
assert.match(unitRunner, /RUN_HEAVY_UNIT_TESTS/, 'unit test runner must keep heavy unit tests out of the quick path by default');
assert.match(unitRunner, /run-test-file\.mjs/, 'unit test runner must execute test files through the single-file wrapper');
assert.match(heavyRunner, /run-test-file\.mjs/, 'heavy runner must execute long regression scripts through the single-file wrapper');
assert.match(testFileRunner, /process\.exit\(0\)/, 'single-file wrapper must force-exit after a test module resolves');
assert.match(unitRunner, /timeout/i, 'unit test runner must pass a timeout to child test processes');

console.log('test runner contract tests OK');
