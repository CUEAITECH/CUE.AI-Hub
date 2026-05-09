const DEFAULT_PROJECT_ID = 'cue_ai_classroom';

export function textIncludesAny(text, keywords = []) {
  const normalized = String(text || '').toLowerCase();
  return (keywords || []).some((keyword) => {
    const value = String(keyword || '').toLowerCase().trim();
    return value.length > 0 && normalized.includes(value);
  });
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function activityText(activity = {}) {
  return normalize([
    activity.id,
    activity.sha,
    activity.shortSha,
    activity.title,
    activity.branch,
    activity.repo,
    ...(activity.files || [])
  ].join(' '));
}

function taskSignals(task = {}) {
  return [
    task.id,
    task.title,
    task.acceptance,
    ...(task.linkedRefs || [])
  ].map(normalize).filter((value) => value.length >= 4);
}

function deliverableSignals(deliverable = {}) {
  return [
    deliverable.id,
    deliverable.title,
    deliverable.acceptance,
    ...(deliverable.keywords || [])
  ].map(normalize).filter((value) => value.length >= 3);
}

export function findDeliverableForTaskText(task, deliverables = []) {
  const text = normalize([
    task?.id,
    task?.title,
    task?.description,
    task?.acceptance,
    task?.sourceDoc,
    task?.signal
  ].join(' '));
  if (!text) return null;
  return deliverables.find((deliverable) => (
    (deliverable.taskIds || []).includes(task?.id)
    || deliverableSignals(deliverable).some((signal) => text.includes(signal))
  )) || null;
}

export function findTaskForActivity(activity, tasks = []) {
  const explicit = tasks.find((task) => task.id && task.id === activity?.taskId);
  if (explicit) return explicit;

  const text = activityText(activity);
  if (!text) return null;
  return tasks.find((task) => taskSignals(task).some((signal) => text.includes(signal))) || null;
}

export function findDeliverableForTask(task, deliverables = []) {
  if (!task) return null;
  const explicit = deliverables.find((deliverable) => deliverable.id && deliverable.id === task.deliverableId);
  if (explicit) return explicit;
  return findDeliverableForTaskText(task, deliverables);
}

export function findDeliverableForActivity(activity, deliverables = []) {
  const explicit = deliverables.find((deliverable) => deliverable.id && deliverable.id === activity?.deliverableId);
  if (explicit) return explicit;

  const text = activityText(activity);
  if (!text) return null;
  return deliverables.find((deliverable) => deliverableSignals(deliverable).some((signal) => text.includes(signal))) || null;
}

export function bindActivityToExplicitRefs(activity, store = {}) {
  const tasks = store.tasks || [];
  const deliverables = store.deliverables || [];
  const task = findTaskForActivity(activity, tasks);
  const deliverable = findDeliverableForTask(task, deliverables)
    || findDeliverableForActivity(activity, deliverables);
  return {
    ...activity,
    projectId: activity.projectId || task?.projectId || deliverable?.projectId || DEFAULT_PROJECT_ID,
    taskId: task?.id || activity.taskId || null,
    deliverableId: deliverable?.id || task?.deliverableId || activity.deliverableId || null
  };
}

export function bindTaskToExplicitRefs(task, store = {}) {
  const deliverables = store.deliverables || [];
  const deliverable = findDeliverableForTask(task, deliverables);
  return {
    ...task,
    projectId: task.projectId || deliverable?.projectId || DEFAULT_PROJECT_ID,
    deliverableId: task.deliverableId || deliverable?.id || null
  };
}

export function bindAssignmentToExplicitRefs(assignment, store = {}) {
  const tasks = store.tasks || [];
  const deliverables = store.deliverables || [];
  const task = tasks.find((item) => item.id && item.id === assignment?.taskId)
    || tasks.find((item) => normalize(item.title) && normalize(item.title) === normalize(assignment?.taskTitle))
    || null;
  const deliverable = findDeliverableForTask(task, deliverables);
  return {
    ...assignment,
    projectId: assignment.projectId || task?.projectId || deliverable?.projectId || DEFAULT_PROJECT_ID,
    taskId: assignment.taskId || task?.id || '',
    taskTitle: assignment.taskTitle || task?.title || assignment.taskId || '临时任务',
    deliverableId: assignment.deliverableId || deliverable?.id || task?.deliverableId || null
  };
}

export function rebindStoreExplicitRefs(store = {}) {
  const draft = { ...store };
  const taskStore = { ...draft, tasks: draft.tasks || [], deliverables: draft.deliverables || [] };
  draft.tasks = taskStore.tasks.map((task) => bindTaskToExplicitRefs(task, taskStore));
  const enriched = { ...draft, tasks: draft.tasks };
  draft.activities = (draft.activities || []).map((activity) => bindActivityToExplicitRefs(activity, enriched));
  draft.assignments = (draft.assignments || []).map((assignment) => bindAssignmentToExplicitRefs(assignment, enriched));
  return draft;
}
