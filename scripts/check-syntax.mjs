/**
 * check-syntax.mjs
 * 自动扫描 server/ src/ scripts/ 下所有 .js / .mjs 文件并做语法检查。
 * 替代在 package.json 里手写每个文件路径的做法。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过 node_modules 和隐藏目录
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, exts, out);
    } else if (exts.some(e => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...walk(join(ROOT, 'server'),  ['.js']),
  ...walk(join(ROOT, 'src'),     ['.js']),
  ...walk(join(ROOT, 'scripts'), ['.mjs', '.js']),
];

let failed = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  if (result.status !== 0) {
    process.stderr.write(`✗ ${rel}\n${result.stderr.toString()}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n语法检查失败：${failed} 个文件有错误`);
  process.exit(1);
} else {
  console.log(`✓ 语法检查通过（${files.length} 个文件）`);
}
