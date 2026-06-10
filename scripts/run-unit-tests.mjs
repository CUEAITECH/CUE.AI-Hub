/**
 * run-unit-tests.mjs
 * 自动找到 scripts/test-*.mjs 并依次运行，替代在 package.json 里手写每个文件名。
 * 新增测试文件后无需修改任何配置。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const TEST_FILE_RUNNER = fileURLToPath(new URL('./run-test-file.mjs', import.meta.url));
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 90000);
const RUN_HEAVY_UNIT_TESTS = process.env.RUN_HEAVY_UNIT_TESTS === '1';

const heavyUnitTests = new Set([
  'test-agentic-sdlc-phase1.mjs',
  'test-prompt-loader.mjs',
  'test-agent-e2e.mjs',
  'test-event-replay.mjs',
  'test-invariants.mjs',
  'test-llm-circuit-breaker.mjs',
  'test-llm-observability-ledger.mjs',
  'test-v2-session-observability.mjs',
  'test-w5-memory-pr.mjs',
  'test-w6-reviewer.mjs',
  'test-w7-recommender.mjs',
  'test-w8-sync-broker.mjs',
  'test-w9-outcome-ledger.mjs',
  'test-w10-active-learning.mjs',
  'test-w11-space-risk.mjs',
  'test-w12-runbook.mjs',
  'test-w13-weekly-learning.mjs',
  'test-w14-autonomy.mjs',
  'test-w15-adapters.mjs',
  'test-w16-api-gateway.mjs',
  'test-wecom-webhook-routing.mjs',
]);

// 找出所有 test-*.mjs，按文件名排序（排除自身）
const allTestFiles = readdirSync(SCRIPTS_DIR)
  .filter(f => f.startsWith('test-') && f.endsWith('.mjs'))
  .sort();
const skippedHeavyFiles = RUN_HEAVY_UNIT_TESTS
  ? []
  : allTestFiles.filter((f) => heavyUnitTests.has(f));
const testFiles = allTestFiles
  .filter((f) => RUN_HEAVY_UNIT_TESTS ? heavyUnitTests.has(f) : !heavyUnitTests.has(f))
  .map(f => join(SCRIPTS_DIR, f));

if (testFiles.length === 0) {
  console.log('未找到测试文件');
  process.exit(0);
}

console.log(`运行 ${testFiles.length} 个${RUN_HEAVY_UNIT_TESTS ? ' heavy' : ''}单元测试...（单文件超时 ${TEST_TIMEOUT_MS}ms）\n`);
if (skippedHeavyFiles.length) {
  console.log(`跳过 ${skippedHeavyFiles.length} 个 heavy 单元测试（由 npm run test:heavy 负责）：`);
  for (const name of skippedHeavyFiles) console.log(`  - ${name}`);
  console.log('');
}

let passed = 0;
let failed = 0;
const failures = [];

for (const file of testFiles) {
  const name = basename(file);
  console.log(`  ▶ ${name}`);
  const result = spawnSync(process.execPath, [TEST_FILE_RUNNER, file], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (result.status === 0) {
    // 取第一行输出作为摘要（通常是 "XX OK"）
    const summary = result.stdout.trim().split('\n')[0] || name;
    console.log(`  ✓ ${summary}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    if (result.error?.code === 'ETIMEDOUT') {
      console.error(`    timed out after ${TEST_TIMEOUT_MS}ms`);
    }
    const detail = (result.stderr || result.stdout || '').trim();
    if (detail) console.error(`    ${detail.split('\n').join('\n    ')}`);
    failures.push(name);
    failed++;
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  console.error(`\n失败的测试：\n${failures.map(f => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
