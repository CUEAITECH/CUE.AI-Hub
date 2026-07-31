/**
 * test-gap-analyzer.mjs — L4-c PR 业务缺口分析（SPEC-L4c）业务级测试
 *
 * 注入假 callClaude / fetchPRDiff，全内存 store，不依赖网络/LLM/SQLite。
 *
 * AC-L4c-001/002: 有 AC + diff → 写出含 covered/missing/riskLevel/reasoning 的记录
 * AC-L4c-003:     无 taskId / 无 acceptance → 跳过，不写记录
 * AC-L4c-004:     callClaude 返回 null → riskLevel='unknown'，不抛错
 * AC-L4c-006:     发给 LLM 的 prompt 同时包含 acceptance 与 diff
 */
import assert from 'node:assert/strict';
import { analyzeGap, buildUserPrompt } from '../server/services/gapAnalyzer.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { console.log(`  ✅ ${name}`); passed++; })
              .catch((err) => { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; });
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err.message}`);
    failed++;
  }
}

function createMemoryStore(tasks = []) {
  let snapshot = { tasks, pulls: [], projects: [], gapAnalyses: {} };
  return {
    store: snapshot,
    async updateStore(mutator) {
      snapshot = mutator(structuredClone(snapshot)) || snapshot;
      return snapshot;
    },
    getSnapshot: () => snapshot,
  };
}

const TASK = {
  id: 'task_demo',
  title: '登录限流',
  acceptance: '1. 连续 5 次失败后锁定 15 分钟；2. 锁定期间返回 429；3. 有单测覆盖',
};
const PULL = {
  id: 'pull_12_proj1',
  number: 12,
  prNumber: 12,
  repo: 'cueai/hub',
  projectId: 'proj1',
  taskId: 'task_demo',
};

// ── AC-L4c-006: prompt 同时包含 acceptance 与 diff ──────────────────────────
await test('buildUserPrompt 同时包含 acceptance 文本与 diff', () => {
  const p = buildUserPrompt('锁定 15 分钟', '@@ -1 +1 @@ +rate limit');
  assert.ok(p.includes('锁定 15 分钟'), 'prompt 应含 acceptance');
  assert.ok(p.includes('rate limit'), 'prompt 应含 diff');
});

// ── AC-L4c-001/002/006: LLM 成功路径 ────────────────────────────────────────
await test('有 AC+diff → 写出 covered/missing/riskLevel/reasoning 记录', async () => {
  const mem = createMemoryStore([TASK]);
  let seenSystem = '';
  let seenUser = '';

  const deps = {
    fetchPRDiff: async () => '@@ login.js @@ +if (fails>=5) lock(15min); return 429;',
    callClaude: async (system, user) => {
      seenSystem = system; seenUser = user;
      return JSON.stringify({
        covered: ['锁定 15 分钟', '返回 429'],
        missing: ['单测覆盖'],
        riskLevel: 'medium',
        reasoning: '核心限流实现了，但缺单测',
      });
    },
  };

  const { analysis } = await analyzeGap(PULL, mem.store, mem.updateStore, 'default', deps);

  // 返回结构
  assert.equal(analysis.riskLevel, 'medium');
  assert.deepEqual(analysis.missing, ['单测覆盖']);
  assert.equal(analysis.covered.length, 2);
  assert.equal(analysis.source, 'llm');
  assert.equal(analysis.taskId, 'task_demo');
  // 写入 store
  const stored = mem.getSnapshot().gapAnalyses['pull_12_proj1'];
  assert.ok(stored, '应写入 store.gapAnalyses[pullId]');
  assert.equal(stored.riskLevel, 'medium');
  // prompt 含 AC + diff（AC-L4c-006）
  assert.ok(seenUser.includes('锁定 15 分钟'), 'userPrompt 应含 acceptance');
  assert.ok(seenUser.includes('return 429'), 'userPrompt 应含 diff');
  // system prompt 不含会变内容（cache 友好）
  assert.ok(!seenSystem.includes('锁定 15 分钟'), 'systemPrompt 不应含 acceptance');
});

// ── AC-L4c-004: callClaude 返回 null → 降级 unknown，不抛错 ──────────────────
await test('callClaude 返回 null → riskLevel=unknown 且不抛错', async () => {
  const mem = createMemoryStore([TASK]);
  const deps = {
    fetchPRDiff: async () => 'some diff',
    callClaude: async () => null,
  };
  const { analysis } = await analyzeGap(PULL, mem.store, mem.updateStore, 'default', deps);
  assert.equal(analysis.riskLevel, 'unknown');
  assert.equal(analysis.source, 'fallback');
  assert.deepEqual(analysis.missing, []);
  assert.ok(mem.getSnapshot().gapAnalyses['pull_12_proj1'], '降级也应落库');
});

// ── AC-L4c-004b: 解析失败（非 JSON）→ 同样降级 ──────────────────────────────
await test('callClaude 返回非 JSON → 降级 unknown', async () => {
  const mem = createMemoryStore([TASK]);
  const deps = {
    fetchPRDiff: async () => 'diff',
    callClaude: async () => '这不是 JSON，是一段闲聊',
  };
  const { analysis } = await analyzeGap(PULL, mem.store, mem.updateStore, 'default', deps);
  assert.equal(analysis.riskLevel, 'unknown');
  assert.equal(analysis.source, 'fallback');
});

// ── AC-L4c-003: 无 taskId → 跳过，不写记录、不调 LLM ────────────────────────
await test('pull 无 taskId → skipped，不写记录、不调 callClaude/fetchPRDiff', async () => {
  const mem = createMemoryStore([TASK]);
  let called = false;
  const deps = {
    fetchPRDiff: async () => { called = true; return 'x'; },
    callClaude: async () => { called = true; return '{}'; },
  };
  const noTask = { ...PULL, taskId: null, linkedTaskIds: [] };
  const res = await analyzeGap(noTask, mem.store, mem.updateStore, 'default', deps);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'no-task');
  assert.equal(called, false, '跳过路径不应触发 LLM/diff 拉取');
  assert.deepEqual(mem.getSnapshot().gapAnalyses, {}, '不应写记录');
});

// ── AC-L4c-003b: 任务无 acceptance → 跳过 ───────────────────────────────────
await test('任务存在但无 acceptance → skipped(no-acceptance)', async () => {
  const mem = createMemoryStore([{ id: 'task_demo', title: 'x', acceptance: '' }]);
  const deps = { fetchPRDiff: async () => 'd', callClaude: async () => '{}' };
  const res = await analyzeGap(PULL, mem.store, mem.updateStore, 'default', deps);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'no-acceptance');
});

// ── linkedTaskIds 回退：pull.taskId 缺失时用 linkedTaskIds[0] ────────────────
await test('pull.taskId 缺失时回退 linkedTaskIds[0]', async () => {
  const mem = createMemoryStore([TASK]);
  const deps = {
    fetchPRDiff: async () => 'diff',
    callClaude: async () => JSON.stringify({ covered: [], missing: [], riskLevel: 'low', reasoning: 'ok' }),
  };
  const pull = { ...PULL, taskId: undefined, linkedTaskIds: ['task_demo'] };
  const { analysis } = await analyzeGap(pull, mem.store, mem.updateStore, 'default', deps);
  assert.equal(analysis.taskId, 'task_demo');
  assert.equal(analysis.riskLevel, 'low');
});

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} 个测试，${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
