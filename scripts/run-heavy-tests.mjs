import { spawnSync } from 'node:child_process';

const HEAVY_TEST_TIMEOUT_MS = Number(process.env.HEAVY_TEST_TIMEOUT_MS || 180000);
const TEST_FILE_RUNNER = 'scripts/run-test-file.mjs';

const suites = [
  ['heavy unit tests', ['scripts/run-unit-tests.mjs'], { env: { RUN_HEAVY_UNIT_TESTS: '1', TEST_TIMEOUT_MS: '90000' } }],
  ['legacy regression', [TEST_FILE_RUNNER, 'scripts/regression-tests.mjs']],
  ['v2 regression', [TEST_FILE_RUNNER, 'scripts/v2-regression-tests.mjs']],
];

let failed = 0;

console.log(`运行 ${suites.length} 个重型测试套件...（单套件超时 ${HEAVY_TEST_TIMEOUT_MS}ms）\n`);

for (const [name, args, options = {}] of suites) {
  console.log(`▶ ${name}: node ${args.join(' ')}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    timeout: HEAVY_TEST_TIMEOUT_MS,
    env: { ...process.env, ...(options.env || {}) },
  });
  const elapsed = Date.now() - started;

  if (result.status === 0) {
    console.log(`✓ ${name} passed (${elapsed}ms)\n`);
    continue;
  }

  failed++;
  if (result.error?.code === 'ETIMEDOUT') {
    console.error(`✗ ${name} timed out after ${HEAVY_TEST_TIMEOUT_MS}ms\n`);
  } else {
    console.error(`✗ ${name} failed with status ${result.status ?? 'unknown'} (${elapsed}ms)\n`);
  }
}

if (failed > 0) {
  console.error(`重型测试失败：${failed}/${suites.length}`);
  process.exit(1);
}

console.log('重型测试全部通过');
