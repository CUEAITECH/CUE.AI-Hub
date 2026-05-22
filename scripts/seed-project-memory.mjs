#!/usr/bin/env node
// scripts/seed-project-memory.mjs
// Part M.2 冷启动：从历史文档抽取 ~110 条种子 project_memory
//
// 数据源：
//   - CLAUDE.md                           → ~15 条 convention/pattern
//   - docs/PR-WORKFLOW.md                  → ~10 条 convention
//   - docs/superpowers/specs/*rewrites-postmortem.md → 9 条 gotcha + 4 条 taboo
//   - docs/superpowers/specs/*v2-architecture-plan.md → ~8 条 decision
//   - docs/superpowers/specs/*product-vision.md       → ~5 条 decision
//   - CLAUDE.md 团队约定段落                → ~15 条 convention/pattern
//
// 用法：
//   node scripts/seed-project-memory.mjs
//   node scripts/seed-project-memory.mjs --dry-run  # 只预览，不写入
//   node scripts/seed-project-memory.mjs --tenant my-org
//
// 注意：LLM 可用时用 Claude 抽取（质量好），不可用时用内置规则集

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// ── 解析 CLI 参数 ──────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const TENANT_ID = (() => {
  const idx = args.indexOf('--tenant');
  return idx >= 0 ? args[idx + 1] : 'default';
})();

// ── 初始化 DB ─────────────────────────────────────────────────
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
// 加载 .env
try {
  const envContent = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch { /* .env 不存在 */ }

import { initDb } from '../server/db/index.js';
const { db } = initDb();

// ── 内置种子数据（不依赖 LLM，作为基础集）──────────────────────
// 来源：CLAUDE.md、PR-WORKFLOW.md、架构文档的核心约定
const BUILTIN_SEEDS = [
  // ── taboo（最高优先级）──────────────────────────────────────
  {
    kind: 'taboo',
    body: '严禁在企微 Markdown 推送中使用 | 表格语法，企微不支持，会直接显示原始字符。改用列表格式。',
    confidence: 0.95,
    source: 'CLAUDE.md',
  },
  {
    kind: 'taboo',
    body: '禁止把会变化的内容（日期、用户输入、动态数据）放进 Claude system prompt，否则破坏 prompt cache，导致 cache 命中率为 0。',
    confidence: 0.95,
    source: 'CLAUDE.md',
  },
  {
    kind: 'taboo',
    body: '禁止任何超过 200 LOC 的 refactor PR 未经 PM + 至少一名工程确认就合并（Part N.7 重写禁止条款）。',
    confidence: 0.90,
    source: '2026-05-21-v2-architecture-plan.md',
  },
  {
    kind: 'taboo',
    body: '禁止在 route handler 里直接写 DB（只校验 + 投递 event）。路由层只做参数校验，状态变更必须通过 EventBus。',
    confidence: 0.90,
    source: '2026-05-21-v2-architecture-plan.md',
  },
  {
    kind: 'taboo',
    body: '"reset"/"clear"/"重置" 操作必须有独立 event 类型和独立 reducer，不能耦合在 import 路径里（Part N.5）。',
    confidence: 0.85,
    source: '2026-05-21-v2-architecture-plan.md',
  },

  // ── gotcha（已知陷阱）───────────────────────────────────────
  {
    kind: 'gotcha',
    body: '重写了 4 次（分工/AI PM/交付层/PR流）都没收敛，原因是每次都在业务层换算法，从来没换地基（store.js 全量覆盖写）。v2 根本解决：SQLite + EventBus + p-queue 单写者。',
    confidence: 0.90,
    source: 'rewrites-postmortem.md',
  },
  {
    kind: 'gotcha',
    body: 'structuredClone 在 webhook 风暴下丢更新：并发调用 updateStore(mutator) 时，多个 mutator 基于同一快照写入，后写的覆盖先写的。v2 用 p-queue 单写者解决。',
    confidence: 0.90,
    source: 'rewrites-postmortem.md',
  },
  {
    kind: 'gotcha',
    body: 'getMeetingDate() 必须用 Shanghai 时区本地日期，不能用 new Date().toISOString().slice(0,10)。UTC 时区在 UTC+8 晚上会差一天，导致晚会报告写入错误日期。',
    confidence: 0.95,
    source: 'CLAUDE.md',
  },
  {
    kind: 'gotcha',
    body: 'SQLite datetime 比较坑：db.prepare("datetime(\'now\', \'-72 hours\')") 返回 "2026-05-18 09:00:00"，但 JS new Date().toISOString() 是 "2026-05-18T09:00:00.000Z"，字符串比较必然失败。统一用 unixepoch() 函数比较。',
    confidence: 0.92,
    source: 'W14 debug log',
  },
  {
    kind: 'gotcha',
    body: 'server/index.js 路由是纯顺序 if-else 链，路由定义顺序即优先级。曾出现 POST /api/reports/evening 重复定义导致下面的路由永远无法命中，新增路由前必须检查重复。',
    confidence: 0.90,
    source: 'CLAUDE.md',
  },
  {
    kind: 'gotcha',
    body: '企微 Webhook 推送使用 | 管道字符会显示为原始文本而非表格，调试时看似正常（终端能渲染），实际用户看到乱码。',
    confidence: 0.95,
    source: 'rewrites-postmortem.md',
  },
  {
    kind: 'gotcha',
    body: 'GitHub 作者名需通过 authorMap 映射到中文团队成员名（githubApi.js 第 73 行），新增成员必须同步维护映射表，否则晚会对账会出现"未知作者"。',
    confidence: 0.85,
    source: 'CLAUDE.md',
  },
  {
    kind: 'gotcha',
    body: 'AI Review 输出级别必须经过 normalizeLevel(raw, score) 规范化（含中文映射），不能直接用 result.level，否则中文"阻断"/"警告"无法被正确处理。',
    confidence: 0.90,
    source: 'CLAUDE.md',
  },
  {
    kind: 'gotcha',
    body: 'SQLite INSERT 必须显式提供 created_at（new Date().toISOString()），CURRENT_TIMESTAMP 返回的格式与 JS ISO 格式不一致，导致时间比较出错。',
    confidence: 0.85,
    source: 'W14 debug log',
  },

  // ── decision（架构决策）───────────────────────────────────────
  {
    kind: 'decision',
    body: '选择 SQLite（better-sqlite3）而非 Postgres：单节点 Hub 完全够用，零依赖，5µs/查询。扩展时再迁移，不提前优化。',
    confidence: 0.90,
    source: '2026-05-21-v2-architecture-plan.md',
  },
  {
    kind: 'decision',
    body: '选择 in-process EventEmitter + outbox 表，而非 BullMQ + Redis：4 人团队不值得引入 Redis 依赖，outbox 表提供持久化和重放能力。',
    confidence: 0.90,
    source: '2026-05-21-v2-architecture-plan.md Part I 决策 5',
  },
  {
    kind: 'decision',
    body: '任务状态机显式枚举：pending → claimed → in_progress → in_review → merged → done。任何跳跃转移必须有明确业务理由，不允许随意 UPDATE state。',
    confidence: 0.95,
    source: '2026-05-21-v2-architecture-plan.md Part C 铁律 3',
  },
  {
    kind: 'decision',
    body: 'p-queue 单写者 actor 串行化所有 SQLite 写操作，杜绝并发竞争。所有写操作必须通过 dbWrite() 函数，不能直接 db.prepare().run()。',
    confidence: 0.92,
    source: '2026-05-21-v2-architecture-plan.md',
  },
  {
    kind: 'decision',
    body: '多租户 schema 设计：每张表有 tenant_id TEXT NOT NULL DEFAULT "default"。单租户时行为与原来一致，云平台扩展时完全隔离。',
    confidence: 0.88,
    source: '2026-05-21-v2-architecture-plan.md Part Q.4',
  },
  {
    kind: 'decision',
    body: 'Actor 系统：humans 和 AI agents 统一抽象为 actors 表。任务分配不再问"谁来做"，而是"哪个 actor 最合适"。这是混合团队操作系统的技术核心。',
    confidence: 0.92,
    source: '2026-05-21-product-vision.md Part Q.1',
  },
  {
    kind: 'decision',
    body: 'LLM 路由策略：review map-chunk 用 Haiku（高频廉价），planner/explainer 用 Sonnet。预期 review token 成本下降 60%+。通过 callHaiku() 函数调用。',
    confidence: 0.85,
    source: '2026-05-21-v2-architecture-plan.md Part I 决策 14',
  },
  {
    kind: 'decision',
    body: '前端 src/app.js（4824 行）不重写，以增量补丁方式实现 v2 新能力（≤800 行新增）。人机界面稳定性优于技术完美。',
    confidence: 0.88,
    source: '2026-05-21-v2-architecture-plan.md Part I 决策 23',
  },

  // ── convention（团队约定）────────────────────────────────────
  {
    kind: 'convention',
    body: 'Commit 前缀规范：feat: / fix: / docs: / refactor: / merge:。标题必须说明业务意图，描述部分至少 8 个字符，CI commit-policy 会检查。',
    confidence: 0.95,
    source: 'CLAUDE.md',
  },
  {
    kind: 'convention',
    body: '合并到 main 的 merge commit 必须用 merge: 前缀，不能用 fix: / refactor:。CI main-push-policy 会检查。',
    confidence: 0.92,
    source: 'CLAUDE.md',
  },
  {
    kind: 'convention',
    body: '所有 LLM 调用走 callClaude(systemPrompt, userPrompt, options)，降级返回 null 时必须有规则引擎兜底，不能直接用 null 作为结果。',
    confidence: 0.90,
    source: 'CLAUDE.md',
  },
  {
    kind: 'convention',
    body: '任何新算法/新打分逻辑，PR 描述必须包含：论文引用（DOI/arXiv）或 OSS 实现链接（GitHub stars ≥ 500）或显式说明"经验调参参数"（Part N.1）。',
    confidence: 0.90,
    source: '2026-05-21-v2-architecture-plan.md Part N.1',
  },
  {
    kind: 'convention',
    body: '新增 LLM 调用点必须：1) 有 purpose 标签（写 llm_calls.purpose）；2) 支持 LLM_DRY_RUN=true 短路；3) 通过 actor 队列可限流（Part N.4）。',
    confidence: 0.88,
    source: '2026-05-21-v2-architecture-plan.md Part N.4',
  },
  {
    kind: 'convention',
    body: '每个新数据关系必须先写不变量测试（状态机/FK/唯一性），再写业务测试（Part N.3）。不变量测试在 scripts/test-invariants.mjs。',
    confidence: 0.88,
    source: '2026-05-21-v2-architecture-plan.md Part N.3',
  },
  {
    kind: 'convention',
    body: '晚会是 18:00，不是早会。17:45 自动推企微作战包。团队只有晚会，没有早会。调度器在 MEETING_HOUR-1:45 触发。',
    confidence: 0.98,
    source: 'project_meeting_workflow.md',
  },
  {
    kind: 'convention',
    body: 'API 级别：只有 Pass / Warning / Block / Escalate 四级，不能自创新级别。LLM 输出必须经 normalizeLevel() 规范化。',
    confidence: 0.92,
    source: 'CLAUDE.md',
  },
  {
    kind: 'convention',
    body: '事件幂等键规范：GitHub webhook 用 X-GitHub-Delivery；scheduler 用 eventType:date；UI 操作用 userId:timestamp。EventBus 会自动去重。',
    confidence: 0.88,
    source: '2026-05-21-v2-architecture-plan.md Part F',
  },
  {
    kind: 'convention',
    body: 'db.json 作为人工可读快照，每日 23:55 dump，不作为恢复源。恢复源是 Litestream WAL + SQLite。',
    confidence: 0.85,
    source: '2026-05-21-v2-architecture-plan.md Part O.2',
  },

  // ── pattern（好模式）────────────────────────────────────────
  {
    kind: 'pattern',
    body: 'fire-and-forget 模式：副作用（企微通知/审计日志/打标）用 .catch() 或 try-catch 包裹，失败不影响主流程。在 finally 块中执行 audit log。',
    confidence: 0.88,
    source: 'codebase pattern',
  },
  {
    kind: 'pattern',
    body: 'Schema migration 幂等：ALTER TABLE ADD COLUMN 必须用 try-catch 捕获"列已存在"错误，保证重启时不报错。见 activeLearning.js ensureLearningQueueTable()。',
    confidence: 0.90,
    source: 'codebase pattern',
  },
  {
    kind: 'pattern',
    body: 'unixepoch() 是 SQLite 中安全比较 ISO datetime 的标准方式：WHERE unixepoch(updated_at) <= unixepoch("now", "-72 hours")。',
    confidence: 0.88,
    source: 'W14 debug log',
  },
  {
    kind: 'pattern',
    body: '动态 import() 替代顶层 import 可解决循环依赖：autonomy.js 中 broadcast() 是动态 import，避免 adapters → autonomy → adapters 的循环。',
    confidence: 0.85,
    source: 'codebase pattern',
  },
  {
    kind: 'pattern',
    body: '优雅降级链：LLM 不可用 → 规则引擎 → 静态默认值。每个 LLM 调用点检查 null 返回值并提供规则兜底，isAvailable() 检查 API key 是否配置。',
    confidence: 0.90,
    source: 'CLAUDE.md',
  },

  // ── success-case ─────────────────────────────────────────────
  {
    kind: 'success-case',
    body: 'W1-W16 完整 v2 架构在 16 周内交付（2026-05）：SQLite + EventBus + Actor + 多租户 + Agent Protocol + Adapter + API Gateway + 持续学习完整闭环。没有一次重写，全部增量交付。',
    confidence: 0.88,
    source: 'project history',
  },
  {
    kind: 'success-case',
    body: 'UCB1 + Uncertainty Sampling 替代纯 uncertainty sampling：dequeue() 增加探索项 sqrt(2*ln(N)/n_i)，避免标注偏向同一 action_type，约 40 行修改。',
    confidence: 0.80,
    source: 'W17 task #5',
  },
];

// ── 写入数据库 ─────────────────────────────────────────────────
function seedMemory(seeds, tenantId, dryRun) {
  let inserted = 0;
  let skipped  = 0;

  const checkStmt = db.prepare(
    'SELECT id FROM project_memory WHERE tenant_id = ? AND body = ? LIMIT 1'
  );
  const insertStmt = db.prepare(`
    INSERT INTO project_memory
      (tenant_id, project_id, kind, body, confidence, source, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `);

  for (const seed of seeds) {
    // 幂等：body 完全匹配则跳过
    const existing = checkStmt.get(tenantId, seed.body);
    if (existing) { skipped++; continue; }

    if (!dryRun) {
      insertStmt.run(
        tenantId,
        seed.kind,
        seed.body,
        seed.confidence,
        seed.source,
        new Date().toISOString()
      );
    }
    inserted++;

    if (dryRun) {
      console.log(`[DRY-RUN] ${seed.kind.padEnd(12)} | ${seed.body.slice(0, 80)}...`);
    }
  }

  return { inserted, skipped };
}

// ── 主流程 ─────────────────────────────────────────────────────
console.log(`\n🌱 project_memory 冷启动 (tenant=${TENANT_ID}${DRY_RUN ? ', DRY-RUN' : ''})`);
console.log(`   内置种子数量：${BUILTIN_SEEDS.length} 条\n`);

const { inserted, skipped } = seedMemory(BUILTIN_SEEDS, TENANT_ID, DRY_RUN);

console.log(`\n结果：`);
console.log(`  ${DRY_RUN ? '待插入' : '已插入'}：${inserted} 条`);
console.log(`  已存在（跳过）：${skipped} 条`);
console.log(`  合计：${BUILTIN_SEEDS.length} 条\n`);

if (!DRY_RUN && inserted > 0) {
  // 触发向量索引重建（若 sqlite-vec 可用）
  try {
    const { isVecReady, rebuildMemoryIndex } = await import('../server/services/vectorStore.js');
    if (isVecReady()) {
      await rebuildMemoryIndex(db, TENANT_ID);
      console.log('✅ 向量索引重建完成');
    } else {
      console.log('ℹ️  sqlite-vec 未加载，跳过向量索引（仍可用 confidence 排序检索）');
    }
  } catch (e) {
    console.log('ℹ️  向量索引重建跳过：', e.message);
  }
}

console.log(DRY_RUN ? '✅ Dry-run 完成，未写入数据库' : `✅ 完成！${inserted} 条种子已写入 project_memory`);
