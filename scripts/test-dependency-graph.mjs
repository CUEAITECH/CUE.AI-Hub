#!/usr/bin/env node
// scripts/test-dependency-graph.mjs — dependencyGraph.js 单元测试
//
// 覆盖：
//   1. isCircularDependency — 环检测（DFS chain 路径算法）
//   2. validateTaskDependencies — 校验：自引用、孤儿、环
//   3. healDependencies — 自动修复：去重、删自引用、删孤儿、断环
//   4. edge cases: 空数组、单节点、ID 类型混用（string/number）

import assert from 'node:assert/strict';
import {
  isCircularDependency,
  validateTaskDependencies,
  healDependencies,
} from '../server/services/dependencyGraph.js';

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

// ─── 辅助：构造最小 task 对象 ────────────────────────────────────

function t(id, deps = []) {
  return { id, title: `Task ${id}`, dependencies: deps, status: 'pending' };
}

// ═══════════════════════════════════════════════════════════════════
// 1. isCircularDependency
// ═══════════════════════════════════════════════════════════════════

await test('无依赖任务：无环', () => {
  const tasks = [t('a'), t('b')];
  assert.equal(isCircularDependency(tasks, 'a'), false);
});

await test('线性链 A→B→C：无环', () => {
  const tasks = [t('a', ['b']), t('b', ['c']), t('c')];
  assert.equal(isCircularDependency(tasks, 'a'), false);
});

await test('直接自引用 A→A：有环', () => {
  const tasks = [t('a', ['a'])];
  assert.equal(isCircularDependency(tasks, 'a'), true);
});

await test('双节点互引 A→B→A：有环', () => {
  const tasks = [t('a', ['b']), t('b', ['a'])];
  assert.equal(isCircularDependency(tasks, 'a'), true);
});

await test('三节点环 A→B→C→A：有环', () => {
  const tasks = [t('a', ['b']), t('b', ['c']), t('c', ['a'])];
  assert.equal(isCircularDependency(tasks, 'a'), true);
});

await test('两条链共享一个终点（非环）：无环', () => {
  // A→C, B→C — C 被两条路径访问，但不是环
  const tasks = [t('a', ['c']), t('b', ['c']), t('c')];
  assert.equal(isCircularDependency(tasks, 'a'), false);
  assert.equal(isCircularDependency(tasks, 'b'), false);
});

await test('依赖不存在的任务 ID：不误判为环', () => {
  const tasks = [t('a', ['nonexistent'])];
  assert.equal(isCircularDependency(tasks, 'a'), false);
});

await test('string ID 与 number ID 混用：统一归一化，正确检测环', () => {
  // LLM 可能吐数字，我们存字符串
  const tasks = [
    { id: 'task_001', dependencies: ['task_002'] },
    { id: 'task_002', dependencies: ['task_001'] },
  ];
  assert.equal(isCircularDependency(tasks, 'task_001'), true);
});

// ═══════════════════════════════════════════════════════════════════
// 2. validateTaskDependencies
// ═══════════════════════════════════════════════════════════════════

await test('合法任务列表：valid=true，无 issues', () => {
  const tasks = [t('a', ['b']), t('b', ['c']), t('c')];
  const result = validateTaskDependencies(tasks);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

await test('自引用：报告 type=self', () => {
  const tasks = [t('a', ['a']), t('b')];
  const result = validateTaskDependencies(tasks);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.type === 'self' && i.taskId === 'a'));
});

await test('孤儿依赖：报告 type=missing', () => {
  const tasks = [t('a', ['ghost']), t('b')];
  const result = validateTaskDependencies(tasks);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.type === 'missing' && i.taskId === 'a'));
});

await test('循环依赖：报告 type=circular', () => {
  const tasks = [t('a', ['b']), t('b', ['a'])];
  const result = validateTaskDependencies(tasks);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.type === 'circular'));
});

await test('空 dependencies 数组：视为合法', () => {
  const tasks = [t('a', []), t('b', [])];
  const result = validateTaskDependencies(tasks);
  assert.equal(result.valid, true);
});

await test('tasks 为空数组：valid=true', () => {
  const result = validateTaskDependencies([]);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
// 3. healDependencies — 自动修复管线
// ═══════════════════════════════════════════════════════════════════

await test('heal：去除重复依赖', () => {
  const tasks = [t('a', ['b', 'b', 'b']), t('b')];
  const healed = healDependencies(tasks);
  const a = healed.find(x => x.id === 'a');
  assert.deepEqual(a.dependencies, ['b']);
});

await test('heal：删除自引用', () => {
  const tasks = [t('a', ['a', 'b']), t('b')];
  const healed = healDependencies(tasks);
  const a = healed.find(x => x.id === 'a');
  assert.ok(!a.dependencies.includes('a'));
  assert.ok(a.dependencies.includes('b'));
});

await test('heal：删除孤儿依赖（引用不存在的 ID）', () => {
  const tasks = [t('a', ['ghost', 'b']), t('b')];
  const healed = healDependencies(tasks);
  const a = healed.find(x => x.id === 'a');
  assert.ok(!a.dependencies.includes('ghost'));
  assert.ok(a.dependencies.includes('b'));
});

await test('heal：断开循环（修复后 validateTaskDependencies 通过）', () => {
  const tasks = [t('a', ['b']), t('b', ['a'])];
  const healed = healDependencies(tasks);
  const result = validateTaskDependencies(healed);
  assert.equal(result.valid, true, `仍有环: ${JSON.stringify(result.issues)}`);
});

await test('heal：三节点环修复后通过校验', () => {
  const tasks = [t('a', ['b']), t('b', ['c']), t('c', ['a'])];
  const healed = healDependencies(tasks);
  const result = validateTaskDependencies(healed);
  assert.equal(result.valid, true, `仍有环: ${JSON.stringify(result.issues)}`);
});

await test('heal：不破坏合法依赖', () => {
  const tasks = [t('a', ['b']), t('b', ['c']), t('c')];
  const healed = healDependencies(tasks);
  const a = healed.find(x => x.id === 'a');
  const b = healed.find(x => x.id === 'b');
  assert.deepEqual(a.dependencies, ['b']);
  assert.deepEqual(b.dependencies, ['c']);
});

await test('heal：返回新数组，不修改原始输入', () => {
  const tasks = [t('a', ['a'])];
  const orig = JSON.stringify(tasks);
  healDependencies(tasks);
  assert.equal(JSON.stringify(tasks), orig);
});

await test('heal：空任务列表安全返回', () => {
  const healed = healDependencies([]);
  assert.deepEqual(healed, []);
});

// ─── 汇总 ────────────────────────────────────────────────────────

console.log('');
console.log(`${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
