/**
 * scripts/rag-cold-start.mjs
 * W5-T2: RAG 冷启动 — 从 docs/*.md 批量提取 convention/decision/gotcha/taboo 写入 project_memory
 *
 * 设计：
 *   - 遍历指定 docs 目录，读取 .md 文件（跳过商业计划、用户场景等非技术文档）
 *   - LLM 提取结构化 memory 条目（按 kind 分类）
 *   - 写入 project_memory 表，source = 'rag-cold-start'
 *   - 幂等：通过 evidence_refs 字段存文件名，避免重复导入
 *
 * 用法：
 *   node scripts/rag-cold-start.mjs [--docs ./docs] [--project proj_xxx] [--tenant default] [--dry-run]
 *
 * 环境变量：
 *   ANTHROPIC_API_KEY  — 未设置时仅做规则提取（关键词扫描）
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { initDb, getDb } from '../server/db/index.js';
import { dbWrite } from '../server/db/actor.js';
import { callClaude } from '../server/services/claude.js';

// ── CLI 参数 ─────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    docs:    { type: 'string', default: './docs' },
    project: { type: 'string', default: '' },
    tenant:  { type: 'string', default: 'default' },
    'dry-run': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
  strict: false,
});

const DOCS_DIR  = path.resolve(args.docs);
const PROJECT_ID = args.project || null;
const TENANT_ID  = args.tenant;
const DRY_RUN    = args['dry-run'];
const VERBOSE    = args.verbose;

// 跳过的文档（产品/业务文档，不含技术约定）
const SKIP_PATTERNS = [
  /商业计划/, /用户场景/, /核心指标/, /技术选型/,
  /功能优先级/, /产品路线图/, /市场/, /融资/,
  /README/i,
];

// ── 颜色输出 ─────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;
const D = s => `\x1b[90m${s}\x1b[0m`;

// ── 初始化 ────────────────────────────────────────────────────
initDb();
const db = getDb();

console.log(B('╔══════════════════════════════════════════════╗'));
console.log(B('║   RAG 冷启动 — project_memory 填充工具        ║'));
console.log(B('╚══════════════════════════════════════════════╝'));
console.log(`  docs 目录 : ${DOCS_DIR}`);
console.log(`  project  : ${PROJECT_ID || '(全局)'}`);
console.log(`  tenant   : ${TENANT_ID}`);
console.log(`  dry-run  : ${DRY_RUN ? Y('是') : '否'}`);
console.log('');

// ── 1. 扫描 docs 目录 ─────────────────────────────────────────
function collectMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    console.warn(`[rag] docs 目录不存在: ${dir}`);
    return results;
  }
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        const shouldSkip = SKIP_PATTERNS.some(p => p.test(entry.name) || p.test(fullPath));
        if (!shouldSkip) {
          results.push(fullPath);
        } else if (VERBOSE) {
          console.log(D(`  [skip] ${entry.name}`));
        }
      }
    }
  }
  walk(dir);
  return results;
}

const mdFiles = collectMarkdownFiles(DOCS_DIR);
console.log(`找到 ${G(mdFiles.length)} 个 Markdown 文件（已跳过非技术文档）`);
if (mdFiles.length === 0) {
  console.log('没有需要处理的文档，退出。');
  process.exit(0);
}

// ── 2. LLM 提取 ──────────────────────────────────────────────
const SYSTEM_PROMPT = `你是一个技术文档分析器，专门从开发文档中提取团队约定和工程决策。

从给定文档中提取以下类型的记忆条目（memory entries）：
- convention: 代码风格、命名规范、目录约定等
- decision: 明确的架构决策（为什么选 A 不选 B）
- gotcha: 踩过的坑、容易犯的错误、需要特别注意的地方
- taboo: 明确禁止的做法（安全、数据、性能红线）
- pattern: 推荐的设计模式、工具使用方式

输出 JSON 数组，每条格式：
{
  "kind": "convention|decision|gotcha|taboo|pattern",
  "body": "简洁陈述（50-150字，直接可用，不要说"在此文档中..."）",
  "confidence": 0.5-1.0
}

只提取明确的、可操作的条目。模糊的描述、背景介绍、功能说明不要提取。
如果文档中没有符合条件的内容，返回空数组 []。`;

async function extractMemoryFromDoc(filePath, content) {
  const relPath = path.relative(process.cwd(), filePath);

  // 检查是否已处理（通过 evidence_refs）
  const existing = db.prepare(`
    SELECT COUNT(*) as c FROM project_memory
    WHERE tenant_id = ? AND evidence_refs LIKE ?
  `).get(TENANT_ID, `%${relPath}%`).c;

  if (existing > 0) {
    console.log(D(`  [已处理] ${path.basename(filePath)} (${existing} 条记录已存在)`));
    return [];
  }

  // 截断过长文档（避免超出 LLM context）
  const truncated = content.length > 12000 ? content.slice(0, 12000) + '\n\n[文档已截断...]' : content;

  console.log(`  ${Y('→')} 处理 ${path.basename(filePath)} (${Math.ceil(content.length / 1000)}k 字符)`);

  // LLM 提取
  const result = await callClaude(SYSTEM_PROMPT, `文档路径：${relPath}\n\n${truncated}`);

  if (!result) {
    // LLM 不可用，规则降级
    console.log(D(`    [降级] LLM 不可用，改用关键词扫描`));
    return ruleBasedExtract(content, relPath);
  }

  // 解析 JSON
  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const items = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(items)) return [];

    const valid = items.filter(item =>
      ['convention', 'decision', 'gotcha', 'taboo', 'pattern'].includes(item.kind) &&
      typeof item.body === 'string' && item.body.length >= 10
    );
    console.log(G(`    ✓ 提取 ${valid.length} 条`));
    return valid.map(item => ({ ...item, evidenceRef: relPath }));
  } catch {
    console.warn(`    [warn] JSON 解析失败，使用规则降级`);
    return ruleBasedExtract(content, relPath);
  }
}

/**
 * 规则降级提取（LLM 不可用时）
 * 扫描常见模式：NOTE:/禁止/约定/决策/规范 等关键词
 */
function ruleBasedExtract(content, relPath) {
  const results = [];
  const lines = content.split('\n');

  const GOTCHA_PATTERN = /\b(注意|警告|坑|禁止|不要|never|WARN|WARNING|⚠️|🚨)/i;
  const DECISION_PATTERN = /\b(决策|选型|为什么|之所以|原因是|因此选择|改为|替换)/;
  const TABOO_PATTERN = /\b(严禁|禁止|红线|不允许|must not|never use)/i;
  const CONVENTION_PATTERN = /\b(命名|规范|约定|格式|风格|统一用|所有.*必须)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 20 || line.startsWith('#')) continue;

    let kind = null;
    if (TABOO_PATTERN.test(line)) kind = 'taboo';
    else if (GOTCHA_PATTERN.test(line)) kind = 'gotcha';
    else if (DECISION_PATTERN.test(line)) kind = 'decision';
    else if (CONVENTION_PATTERN.test(line)) kind = 'convention';

    if (kind) {
      const body = line.replace(/^[-*>]\s*/, '').slice(0, 150);
      results.push({ kind, body, confidence: 0.5, evidenceRef: relPath });
    }
  }

  // 去重（相似 body）
  const seen = new Set();
  return results.filter(r => {
    const key = r.body.slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 3. 批量处理 ──────────────────────────────────────────────
let totalNew = 0;
let totalFiles = 0;
const stats = { convention: 0, decision: 0, gotcha: 0, taboo: 0, pattern: 0 };

for (const filePath of mdFiles) {
  const content = fs.readFileSync(filePath, 'utf8');
  const items = await extractMemoryFromDoc(filePath, content);

  if (items.length === 0) continue;
  totalFiles++;

  if (!DRY_RUN) {
    await dbWrite('rag-cold-start', (db) => {
      const now = new Date().toISOString();
      for (const item of items) {
        // INSERT OR IGNORE：evidence_refs + body 的组合不重复插入
        try {
          db.prepare(`
            INSERT INTO project_memory
              (tenant_id, project_id, kind, body, confidence, source, evidence_refs, created_at)
            VALUES (?, ?, ?, ?, ?, 'rag-cold-start', ?, ?)
          `).run(
            TENANT_ID,
            PROJECT_ID,
            item.kind,
            item.body,
            item.confidence ?? 0.6,
            item.evidenceRef,
            now
          );
          stats[item.kind] = (stats[item.kind] || 0) + 1;
          totalNew++;
        } catch (err) {
          if (!err.message.includes('UNIQUE')) {
            console.warn(`[rag] insert error:`, err.message);
          }
        }
      }
    });
  } else {
    // dry-run 仅打印
    for (const item of items) {
      console.log(D(`    [${item.kind}] (${item.confidence}) ${item.body.slice(0, 80)}...`));
      stats[item.kind] = (stats[item.kind] || 0) + 1;
      totalNew++;
    }
  }
}

// ── 4. 汇总 ──────────────────────────────────────────────────
console.log('');
console.log(B('══════════════════════════════════════════════'));
console.log(`  RAG 冷启动${DRY_RUN ? ' [DRY RUN]' : ''} 完成`);
console.log(`  处理文档 : ${G(totalFiles)} 个`);
console.log(`  写入条目 : ${G(totalNew)} 条`);
console.log('  按类型分布:');
for (const [kind, count] of Object.entries(stats)) {
  if (count > 0) console.log(`    ${kind.padEnd(12)} ${G(count)}`);
}

// 验证写入
if (!DRY_RUN && totalNew > 0) {
  const dbCount = db.prepare('SELECT COUNT(*) as c FROM project_memory WHERE tenant_id = ? AND source = ?')
    .get(TENANT_ID, 'rag-cold-start').c;
  console.log(`  DB 验证  : ${G(dbCount)} 条已持久化`);
}

console.log(B('══════════════════════════════════════════════'));
process.exit(0);
