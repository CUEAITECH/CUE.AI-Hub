// server/services/semgrepFilter.js
// W6: Semgrep 静态分析预过滤器
//
// 在 mapReduceReviewer 的 Map 阶段之前运行 Semgrep，快速扫描已知漏洞模式。
// 优势：
//   1. 比 LLM 便宜 100x（静态规则，< 1s）
//   2. 已发现的 critical issue 不再喂给 LLM，省 token + 提高精度
//   3. 使用 semgrep --config=auto（官方规则库，持续更新）
//
// 优雅降级：semgrep 不在 PATH 时静默跳过（返回空数组），不影响 reviewer 主流程
//
// 运行前提：
//   - `npm install`（无需额外包，只需 semgrep CLI）
//   - brew install semgrep（macOS）或 pip install semgrep（通用）

import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SEMGREP_TIMEOUT_MS = 30_000;

// 从 diff 中提取新增行，写入临时文件供 Semgrep 分析
function extractAddedLines(fileDiff) {
  return fileDiff.diffText
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1)) // 去掉 '+' 前缀
    .join('\n');
}

/**
 * 运行 Semgrep 静态分析（subprocess）
 *
 * @param {object[]} fileDiffs   - diffAnalyzer 返回的 FileDiff 数组
 * @param {object}  [opts]
 * @param {string}  [opts.config='auto']  - semgrep config（'auto' 用官方规则库）
 * @param {number}  [opts.timeoutMs]      - 超时（默认 30s）
 * @returns {Promise<SemgrepIssue[]>}     - 格式化的 issues，结构与 mapReduceReviewer 一致
 */
export async function runSemgrepOnDiff(fileDiffs, opts = {}) {
  const config    = opts.config    || 'auto';
  const timeoutMs = opts.timeoutMs || SEMGREP_TIMEOUT_MS;

  // 1. 快速检查 semgrep 是否可用
  const available = await isSemgrepAvailable();
  if (!available) {
    return { issues: [], skipped: true, reason: 'semgrep not in PATH' };
  }

  // 2. 写临时文件（每个 fileDiff 一个文件）
  let tmpDir;
  const tmpFiles = [];
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'cue-semgrep-'));

    for (const diff of fileDiffs) {
      const content = extractAddedLines(diff);
      if (!content.trim()) continue;

      // 从原始文件路径推断扩展名（确保 semgrep 知道语言）
      const ext  = diff.path.split('.').pop() || 'js';
      const safe = diff.path.replace(/[^a-zA-Z0-9_.]/g, '_');
      const tmp  = join(tmpDir, `${safe}.${ext}`);
      await writeFile(tmp, content, 'utf8');
      tmpFiles.push({ tmp, originalPath: diff.path });
    }

    if (tmpFiles.length === 0) {
      return { issues: [], skipped: false, filesScanned: 0 };
    }

    // 3. 运行 semgrep
    const rawResults = await spawnSemgrep({
      files: tmpFiles.map(f => f.tmp),
      config,
      timeoutMs,
    });

    // 4. 将结果映射回原始文件路径
    const tmpToOriginal = Object.fromEntries(tmpFiles.map(f => [f.tmp, f.originalPath]));

    const issues = (rawResults.results || []).map(r => {
      const file = tmpToOriginal[r.path] || r.path;
      const sev  = mapSemgrepSeverity(r.extra?.severity || r.severity || 'WARNING');

      return {
        file,
        severity:    sev,
        header:      `[Semgrep] ${r.check_id?.split('.').pop() || 'rule'}`,
        description: r.extra?.message || r.message || '静态分析发现潜在问题',
        startLine:   r.start?.line || null,
        endLine:     r.end?.line   || null,
        ruleId:      r.check_id,
        source:      'semgrep',
      };
    });

    return {
      issues,
      skipped:      false,
      filesScanned: tmpFiles.length,
      rulesMatched: issues.length,
    };
  } finally {
    // 清理临时文件
    for (const { tmp } of tmpFiles) {
      await unlink(tmp).catch(() => {});
    }
    if (tmpDir) {
      import('node:fs/promises').then(({ rmdir }) =>
        rmdir(tmpDir).catch(() => {})
      );
    }
  }
}

// ── 内部工具 ────────────────────────────────────────────────────

let _semgrepAvailable = null; // 缓存检查结果（进程级）

async function isSemgrepAvailable() {
  if (_semgrepAvailable !== null) return _semgrepAvailable;

  return new Promise((resolve) => {
    const proc = spawn('semgrep', ['--version'], { stdio: 'pipe' });
    proc.on('error', () => { _semgrepAvailable = false; resolve(false); });
    proc.on('close', (code) => { _semgrepAvailable = (code === 0); resolve(_semgrepAvailable); });
    setTimeout(() => { proc.kill(); _semgrepAvailable = false; resolve(false); }, 3000);
  });
}

function spawnSemgrep({ files, config, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--config', config,
      '--json',
      '--quiet',
      '--no-git-ignore',
      `--timeout=${Math.ceil(timeoutMs / 1000)}`,
      ...files,
    ];

    const proc = spawn('semgrep', args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`semgrep timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // semgrep exit code: 0 = OK, 1 = found issues, 2 = error
      try {
        resolve(stdout ? JSON.parse(stdout) : { results: [] });
      } catch {
        if (code === 2) reject(new Error(`semgrep error: ${stderr.slice(0, 200)}`));
        else resolve({ results: [] }); // exit 1（有 findings）但 JSON 解析失败
      }
    });

    proc.on('error', reject);
  });
}

function mapSemgrepSeverity(semgrepSev) {
  const s = (semgrepSev || '').toUpperCase();
  if (s === 'ERROR')   return 'critical';
  if (s === 'WARNING') return 'major';
  return 'minor';
}
