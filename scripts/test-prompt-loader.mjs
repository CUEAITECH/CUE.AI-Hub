#!/usr/bin/env node
// scripts/test-prompt-loader.mjs — promptLoader 单元 + 集成 + 业务测试
//
// 单元：loadPrompt / getSystemPrompt 的加载、校验、缓存行为
// 集成：docsManager 能通过 promptLoader 拿到正确 prompt
// 业务：sync-docs 流程在 callClaude 降级时正常返回空任务列表（不崩溃）

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok  ${name}`);
    pass++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(`     ${err.message}`);
    fail++;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 单元测试：promptLoader
// ═══════════════════════════════════════════════════════════════════

const { loadPrompt, getSystemPrompt } = await import('../server/services/promptLoader.js');

await test('loadPrompt：能加载 parse-docs prompt 文件', () => {
  const p = loadPrompt('parse-docs');
  assert.ok(p, 'loadPrompt 返回了空值');
  assert.equal(typeof p.id, 'string');
  assert.equal(typeof p.version, 'string');
  assert.ok(p.prompts?.system, '缺少 prompts.system 字段');
});

await test('loadPrompt：能加载 parse-phases prompt 文件', () => {
  const p = loadPrompt('parse-phases');
  assert.ok(p, 'loadPrompt 返回了空值');
  assert.ok(p.prompts?.system, '缺少 prompts.system 字段');
});

await test('loadPrompt：相同 id 返回同一对象（模块缓存）', () => {
  const a = loadPrompt('parse-docs');
  const b = loadPrompt('parse-docs');
  assert.equal(a, b, '两次调用返回了不同对象');
});

await test('loadPrompt：不存在的 id 抛出 Error', () => {
  assert.throws(
    () => loadPrompt('nonexistent-prompt'),
    /nonexistent-prompt/,
    '应该抛出含 id 的错误'
  );
});

await test('getSystemPrompt：返回非空字符串', () => {
  const sys = getSystemPrompt('parse-docs');
  assert.equal(typeof sys, 'string');
  assert.ok(sys.length > 100, '系统 prompt 过短，可能读错了');
});

await test('getSystemPrompt：parse-docs 包含关键约束词', () => {
  const sys = getSystemPrompt('parse-docs');
  assert.ok(sys.includes('acceptance'), '缺少 acceptance 字段说明');
  assert.ok(sys.includes('businessNote'), '缺少 businessNote 字段说明');
  assert.ok(sys.includes('dependencies'), '缺少 dependencies 字段说明');
});

await test('getSystemPrompt：parse-phases 包含关键约束词', () => {
  const sys = getSystemPrompt('parse-phases');
  assert.ok(sys.includes('phases'), '缺少 phases 字段说明');
  assert.ok(sys.includes('phaseId'), '缺少 phaseId 字段说明');
  assert.ok(sys.includes('productKeywords'), '缺少 productKeywords 字段说明');
});

// ═══════════════════════════════════════════════════════════════════
// 集成测试：JSON 文件内容完整性
// ═══════════════════════════════════════════════════════════════════

await test('parse-docs.json：JSON 格式合法', () => {
  const raw = readFileSync(resolve(ROOT, 'server/prompts/parse-docs.json'), 'utf-8');
  assert.doesNotThrow(() => JSON.parse(raw), 'JSON.parse 失败');
});

await test('parse-phases.json：JSON 格式合法', () => {
  const raw = readFileSync(resolve(ROOT, 'server/prompts/parse-phases.json'), 'utf-8');
  assert.doesNotThrow(() => JSON.parse(raw), 'JSON.parse 失败');
});

await test('parse-docs.json：schema 完整（id/version/description/prompts.system）', () => {
  const d = JSON.parse(readFileSync(resolve(ROOT, 'server/prompts/parse-docs.json'), 'utf-8'));
  assert.ok(d.id, 'missing id');
  assert.ok(d.version, 'missing version');
  assert.ok(d.description, 'missing description');
  assert.ok(d.prompts?.system?.length > 100, 'prompts.system 太短或缺失');
});

await test('parse-docs.json：system prompt 与旧常量行为等价（含 Task v2 关键字段）', () => {
  const d = JSON.parse(readFileSync(resolve(ROOT, 'server/prompts/parse-docs.json'), 'utf-8'));
  const sys = d.prompts.system;
  // 这些字段是 parseDocsForTasks 输出结构的核心——丢了 LLM 就不会输出正确格式
  for (const keyword of ['businessNote', 'acceptance', 'dependencies', 'deliverableTitle', 'requirementRefs']) {
    assert.ok(sys.includes(keyword), `system prompt 缺少关键字段: ${keyword}`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 业务测试：docsManager 使用外部 prompt 时降级路径正常
// ═══════════════════════════════════════════════════════════════════

await test('业务：parseDocsForTasks 在 callClaude 返回 null 时返回空数组（不崩溃）', async () => {
  // 不需要真实 API key：callClaude 在无 key 时返回 null，降级路径应返回 []
  const { parseDocsForTasks } = await import('../server/services/docsManager.js');
  const result = await parseDocsForTasks([
    { path: 'docs/当前开发计划.md', name: '当前开发计划.md', content: '## 任务\n- 配置本地环境\n' }
  ]);
  assert.ok(Array.isArray(result), 'parseDocsForTasks 应返回数组');
});

// ─── 汇总 ────────────────────────────────────────────────────────

console.log('');
console.log(`${pass + fail} tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
