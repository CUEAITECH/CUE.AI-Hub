// server/services/diffAnalyzer.js
// W6-T1: PR Diff 拉取与文件分块
//
// 职责：
//   1. 通过 Octokit 拉取 PR 的 unified diff（application/vnd.github.v3.diff）
//   2. 用 parse-diff 解析成 FileDiff 数组
//   3. 按文件过滤（跳过二进制/lockfile/generated）
//   4. 截断每个文件的 chunk 字符数，适配 LLM context
//
// 输出供 mapReduceReviewer.js 的 Map 阶段消费

import parseDiff from 'parse-diff';
import { getOctokit } from './githubClient.js';
import * as acorn from 'acorn';

// 跳过 review 意义不大的文件
const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /dist\//,
  /build\//,
  /\.generated\./,
  /node_modules\//,
  /^\.github\/workflows\//,   // CI 配置（W6 先跳过，后续专项）
];

// 每个文件 chunk 合并后的字符上限（控制 Map LLM 输入大小）
const MAX_FILE_DIFF_CHARS = 6000;

// JS/TS 文件扩展名正则
const JS_TS_RE = /\.(js|mjs|cjs|ts|tsx|jsx)$/;

/**
 * 智能截断：在空行处截断，避免截断在行中间
 */
function smartTruncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cutPoint = text.lastIndexOf('\n\n', maxChars);
  if (cutPoint > maxChars * 0.5) {
    return text.slice(0, cutPoint) + '\n[diff truncated at function boundary...]';
  }
  return text.slice(0, maxChars) + '\n[diff truncated...]';
}

/**
 * 对 JS/TS 文件，用 acorn 解析 diff 中提取的新版代码，
 * 找出包含变更行的顶层函数/类节点，只返回那些语义单元。
 * 其他文件类型降级为 smartTruncate。
 *
 * @param {string} filePath - 文件路径（用于判断扩展名）
 * @param {string} diffText - 完整 diff 文本
 * @param {number} maxChars - 字符上限
 * @returns {string}
 */
function extractChangedFunctions(filePath, diffText, maxChars) {
  if (!JS_TS_RE.test(filePath)) {
    return smartTruncate(diffText, maxChars);
  }

  try {
    const lines = diffText.split('\n');
    const changedLineNums = new Set();
    const contentLines = [];
    let lineNum = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) lineNum = parseInt(m[1], 10) - 1;
        contentLines.push('');  // placeholder so line numbers align
      } else if (line.startsWith('+')) {
        lineNum++;
        changedLineNums.add(lineNum);
        contentLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        contentLines.push('');  // placeholder to keep line count stable
      } else if (line.startsWith(' ')) {
        lineNum++;
        contentLines.push(line.slice(1));
      } else {
        contentLines.push(line);
      }
    }

    const source = contentLines.join('\n');

    const ast = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: 'module',
      allowHashBang: true,
      allowImportExportEverywhere: true,
    });

    const selectedNodes = [];
    for (const node of ast.body) {
      const startLine = source.slice(0, node.start).split('\n').length;
      const endLine = source.slice(0, node.end).split('\n').length;
      const overlaps = [...changedLineNums].some(l => l >= startLine && l <= endLine);
      if (overlaps) {
        selectedNodes.push({ startLine, endLine, text: source.slice(node.start, node.end) });
      }
    }

    if (selectedNodes.length === 0) {
      return smartTruncate(diffText, maxChars);
    }

    const joined = selectedNodes.map(n => n.text).join('\n\n');
    const prefix = `// [AST-sliced: showing ${selectedNodes.length} changed function(s)]\n`;
    const result = prefix + joined;
    return result.length > maxChars
      ? result.slice(0, maxChars) + '\n// [truncated]'
      : result;

  } catch {
    return smartTruncate(diffText, maxChars);
  }
}

/**
 * @typedef {object} FileDiff
 * @property {string} path        - 文件路径（新文件名）
 * @property {string} oldPath     - 旧文件名（rename 时有值）
 * @property {'added'|'deleted'|'modified'|'renamed'} changeType
 * @property {number} additions   - 新增行数
 * @property {number} deletions   - 删除行数
 * @property {string} diffText    - 截断后的 diff 文本（供 LLM 读取）
 * @property {boolean} truncated  - 是否被截断
 */

/**
 * 拉取并解析 PR diff
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {object} [params.options]
 * @param {number} [params.options.maxFiles=20]        - 最多处理多少个文件
 * @param {number} [params.options.maxFileDiffChars]   - 单文件 diff 字符上限
 * @returns {Promise<{ files: FileDiff[]; totalAdditions: number; totalDeletions: number; rawStats: object }>}
 */
export async function fetchAndParseDiff({ owner, repo, prNumber, options = {} }) {
  const maxFiles     = options.maxFiles ?? 20;
  const maxDiffChars = options.maxFileDiffChars ?? MAX_FILE_DIFF_CHARS;

  // ── 1. 拉取 raw diff ────────────────────────────────────────
  const octokit = getOctokit();
  const { data: rawDiff } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });

  if (typeof rawDiff !== 'string' || rawDiff.length === 0) {
    return { files: [], totalAdditions: 0, totalDeletions: 0, rawStats: {} };
  }

  // ── 2. parse-diff 解析 ──────────────────────────────────────
  const parsed = parseDiff(rawDiff);

  // ── 3. 过滤 + 转换 ──────────────────────────────────────────
  let totalAdditions = 0;
  let totalDeletions = 0;
  const files = [];

  for (const file of parsed) {
    const filePath = file.to || file.from || '(unknown)';

    // 跳过特定文件
    if (SKIP_PATTERNS.some(p => p.test(filePath))) continue;

    // 计算行数
    let additions = 0;
    let deletions = 0;
    const chunkTexts = [];

    for (const chunk of (file.chunks || [])) {
      for (const change of (chunk.changes || [])) {
        if (change.type === 'add') additions++;
        else if (change.type === 'del') deletions++;
      }
      // 重建 chunk 文本（@@ header + changes）
      const header = `@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@${chunk.content ? ' ' + chunk.content : ''}`;
      const changeLines = (chunk.changes || []).map(c => {
        if (c.type === 'add') return `+${c.content}`;
        if (c.type === 'del') return `-${c.content}`;
        return ` ${c.content}`;
      }).join('\n');
      chunkTexts.push(`${header}\n${changeLines}`);
    }

    totalAdditions += additions;
    totalDeletions += deletions;

    // 跳过无实质变更的文件（只有元数据行）
    if (additions + deletions === 0) continue;

    // 拼接并截断（智能 AST 切片）
    const fullDiff = `--- ${file.from || '/dev/null'}\n+++ ${filePath}\n${chunkTexts.join('\n')}`;
    let diffText = fullDiff;
    let truncated = false;
    if (diffText.length > maxDiffChars) {
      diffText = extractChangedFunctions(filePath, fullDiff, maxDiffChars);
      truncated = diffText.length < fullDiff.length;
    }

    // 判断变更类型
    let changeType = 'modified';
    if (file.new) changeType = 'added';
    else if (file.deleted) changeType = 'deleted';
    else if (file.from !== file.to && file.from && file.to) changeType = 'renamed';

    files.push({
      path: filePath,
      oldPath: file.from !== file.to ? file.from : undefined,
      changeType,
      additions,
      deletions,
      diffText,
      truncated,
    });

    if (files.length >= maxFiles) break;
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
    rawStats: { parsedFiles: parsed.length, filteredFiles: files.length },
  };
}

/**
 * 从 diff 文本直接解析（用于测试或 webhook 传入 diff）
 */
export function parseDiffText(rawDiff, options = {}) {
  const maxDiffChars = options.maxFileDiffChars ?? MAX_FILE_DIFF_CHARS;
  const parsed = parseDiff(rawDiff);
  const files = [];

  for (const file of parsed) {
    const filePath = file.to || file.from || '(unknown)';
    if (SKIP_PATTERNS.some(p => p.test(filePath))) continue;

    let additions = 0, deletions = 0;
    const chunkTexts = [];

    for (const chunk of (file.chunks || [])) {
      for (const change of (chunk.changes || [])) {
        if (change.type === 'add') additions++;
        else if (change.type === 'del') deletions++;
      }
      const header = `@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`;
      const lines = (chunk.changes || []).map(c =>
        c.type === 'add' ? `+${c.content}` : c.type === 'del' ? `-${c.content}` : ` ${c.content}`
      ).join('\n');
      chunkTexts.push(`${header}\n${lines}`);
    }

    if (additions + deletions === 0) continue;

    const fullDiff = `--- ${file.from || '/dev/null'}\n+++ ${filePath}\n${chunkTexts.join('\n')}`;
    let diffText = fullDiff;
    let truncated = false;
    if (fullDiff.length > maxDiffChars) {
      diffText = extractChangedFunctions(filePath, fullDiff, maxDiffChars);
      truncated = diffText.length < fullDiff.length;
    }

    files.push({
      path: filePath,
      changeType: file.new ? 'added' : file.deleted ? 'deleted' : 'modified',
      additions, deletions,
      diffText,
      truncated,
    });
  }

  return files;
}
