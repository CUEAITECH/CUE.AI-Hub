// server/services/dependencyGraph.js
//
// 依赖图校验与自动修复管线。
// 算法借鉴 Taskmaster (eyaltoledano/claude-task-master) dependency-manager.js，
// 适配 CUE string task ID 体系（无数字自增 ID，无子任务 dot-notation）。
//
// 导出：
//   isCircularDependency(tasks, taskId)       → boolean（按 task.id 匹配）
//   validateTaskDependencies(tasks)           → { valid, issues[] }（按 task.id 匹配）
//   healDependencies(tasks)                   → tasks（deps 存 ID 时用，原始输入不可变）
//   healDependenciesByTitle(tasks)            → tasks（deps 存标题时用，CUE 实际场景）
//
// heal 管线（顺序不可调换）：
//   1. 去重
//   2. 删自引用（dep === 自身 key）
//   3. 删孤儿（dep 找不到对应 task）
//   4. 断环（DFS 找环 → 删最后一条成环边）

// ─── 内部工具 ────────────────────────────────────────────────────

function sid(v) {
  return String(v ?? '');
}

// ─── isCircularDependency ────────────────────────────────────────
//
// DFS chain（路径追踪）算法：chain 保存当前路径，不是全局 visited 集，
// 从而区分"两条路径汇聚到同一节点"（非环）和"路径上出现重复节点"（环）。
// getKey: task => string，默认取 task.id

function _isCircular(tasks, taskKey, chain, getKey) {
  if (chain.some(k => k === taskKey)) return true;
  const task = tasks.find(t => getKey(t) === taskKey);
  if (!task || !task.dependencies?.length) return false;
  const next = [...chain, taskKey];
  return task.dependencies.some(dep => _isCircular(tasks, sid(dep), next, getKey));
}

export function isCircularDependency(tasks, taskId, chain = []) {
  return _isCircular(tasks, sid(taskId), chain, t => sid(t.id));
}

// ─── validateTaskDependencies ────────────────────────────────────

export function validateTaskDependencies(tasks) {
  const issues = [];
  const getKey = t => sid(t.id);

  for (const task of tasks) {
    const tid = getKey(task);
    if (!Array.isArray(task.dependencies)) continue;

    for (const dep of task.dependencies) {
      const did = sid(dep);
      if (did === tid) {
        issues.push({ type: 'self', taskId: tid, message: `Task ${tid} depends on itself` });
        continue;
      }
      if (!tasks.some(t => getKey(t) === did)) {
        issues.push({ type: 'missing', taskId: tid, dependencyId: did, message: `Task ${tid} depends on non-existent task ${did}` });
      }
    }

    if (_isCircular(tasks, tid, [], getKey)) {
      if (!issues.some(i => i.type === 'circular' && i.taskId === tid)) {
        issues.push({ type: 'circular', taskId: tid, message: `Task ${tid} is part of a circular dependency chain` });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// ─── 共有 heal 管线 ─────────────────────────────────────────────
//
// getKey(task): 从 task 提取唯一标识，用于自引用检测和孤儿检测。
// 对 ID-based deps: getKey = t => t.id
// 对 title-based deps: getKey = t => t.title

function _heal(tasks, getKey) {
  let healed = JSON.parse(JSON.stringify(tasks));

  // 1. 去重
  healed = healed.map(task => ({
    ...task,
    dependencies: Array.isArray(task.dependencies)
      ? [...new Set(task.dependencies.map(sid))]
      : [],
  }));

  // 2. 删自引用
  healed = healed.map(task => ({
    ...task,
    dependencies: task.dependencies.filter(dep => sid(dep) !== sid(getKey(task))),
  }));

  // 3. 删孤儿
  healed = healed.map(task => ({
    ...task,
    dependencies: task.dependencies.filter(dep =>
      healed.some(t => sid(getKey(t)) === sid(dep))
    ),
  }));

  // 4. 断环：只处理确实在环中的任务，逐边试删，找到成环边就断掉
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (const task of healed) {
      const key = sid(getKey(task));
      if (!_isCircular(healed, key, [], getKey)) continue;

      for (let i = 0; i < task.dependencies.length; i++) {
        const withoutEdge = task.dependencies.filter((_, j) => j !== i);
        const candidate = healed.map(t =>
          sid(getKey(t)) === key ? { ...t, dependencies: withoutEdge } : t
        );
        if (!_isCircular(candidate, key, [], getKey)) {
          task.dependencies = withoutEdge;
          changed = true;
          break outer;
        }
      }
    }
  }

  return healed;
}

// ─── 公开导出 ────────────────────────────────────────────────────

// deps 存 task.id 时使用（单元测试、未来 E4 ID 化场景）
export function healDependencies(tasks) {
  return _heal(tasks, t => t.id);
}

// deps 存 task.title 时使用（CUE 实际存储格式：LLM 输出标题依赖）
export function healDependenciesByTitle(tasks) {
  return _heal(tasks, t => t.title);
}
