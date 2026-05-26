export function mergeTask(tasks = [], task) {
  if (!task?.id) return tasks;
  const exists = tasks.some((item) => item.id === task.id);
  if (!exists) return [...tasks, task];
  return tasks.map((item) => (item.id === task.id ? { ...item, ...task } : item));
}

export function upsertTasks(tasks = [], nextTasks = []) {
  return nextTasks.reduce((acc, task) => mergeTask(acc, task), [...tasks]);
}
