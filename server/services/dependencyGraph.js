// server/services/dependencyGraph.js
//
// 依赖图校验与自动修复管线。
// 算法借鉴 Taskmaster (eyaltoledano/claude-task-master) dependency-manager.js，
// 适配 CUE string task ID 体系（无数字自增 ID，无子任务 dot-notation）。
//
// 三个核心导出：
//   isCircularDependency(tasks, taskId)       → boolean
//   validateTaskDependencies(tasks)           → { valid, issues[] }
//   healDependencies(tasks)                   → tasks（新数组，原始输入不可变）
//
// heal 管线（顺序不可调换）：
//   1. 去重
//   2. 删自引用
//   3. 删孤儿（指向不存在 ID 的依赖）
//   4. 断环（DFS 找环 → 删最后一条边）

// ─── 内部工具 ────────────────────────────────────────────────────

function sid(id) {
  return String(id ?? '');
}

function taskExists(tasks, id) {
  const target = sid(id);
  return tasks.some(t => sid(t.id) === target);
}

// ─── isCircularDependency ────────────────────────────────────────
//
// DFS chain（路径追踪）算法：
//   chain 保存当前递归路径，不是全局 visited 集。
//   这样才能区分"两条路径汇聚到同一节点"（非环）和"路径上出现重复节点"（环）。

export function isCircularDependency(tasks, taskId, chain = []) {
  const id = sid(taskId);

  if (chain.some(cid => cid === id)) return true;

  const task = tasks.find(t => sid(t.id) === id);
  if (!task || !task.dependencies?.length) return false;

  const next = [...chain, id];
  return task.dependencies.some(dep => isCircularDependency(tasks, dep, next));
}

// ─── validateTaskDependencies ────────────────────────────────────

export function validateTaskDependencies(tasks) {
  const issues = [];

  for (const task of tasks) {
    const tid = sid(task.id);
    if (!Array.isArray(task.dependencies)) continue;

    for (const dep of task.dependencies) {
      const did = sid(dep);

      if (did === tid) {
        issues.push({ type: 'self', taskId: tid, message: `Task ${tid} depends on itself` });
        continue;
      }

      if (!taskExists(tasks, dep)) {
        issues.push({ type: 'missing', taskId: tid, dependencyId: did, message: `Task ${tid} depends on non-existent task ${did}` });
      }
    }

    if (isCircularDependency(tasks, tid)) {
      if (!issues.some(i => i.type === 'circular' && i.taskId === tid)) {
        issues.push({ type: 'circular', taskId: tid, message: `Task ${tid} is part of a circular dependency chain` });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// ─── healDependencies ────────────────────────────────────────────
//
// 不拒绝 LLM 的烂输出，自动修复后返回干净结构。
// heal 后调用 validateTaskDependencies 应始终 valid=true。

export function healDependencies(tasks) {
  // 深拷贝，保证不可变
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
    dependencies: task.dependencies.filter(dep => sid(dep) !== sid(task.id)),
  }));

  // 3. 删孤儿
  healed = healed.map(task => ({
    ...task,
    dependencies: task.dependencies.filter(dep => taskExists(healed, dep)),
  }));

  // 4. 断环：只处理真正在环中的任务，逐边试删，找到成环的边就断掉
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (const task of healed) {
      // 先确认这个任务确实在某个环中，再动它的依赖
      if (!isCircularDependency(healed, sid(task.id))) continue;

      for (let i = 0; i < task.dependencies.length; i++) {
        const withoutEdge = task.dependencies.filter((_, j) => j !== i);
        const candidate = healed.map(t =>
          sid(t.id) === sid(task.id) ? { ...t, dependencies: withoutEdge } : t
        );
        // 移除这条边后此任务不再处于环中 → 就是成环边，断掉
        if (!isCircularDependency(candidate, sid(task.id))) {
          task.dependencies = withoutEdge;
          changed = true;
          break outer;
        }
      }
    }
  }

  return healed;
}
