export function resolveInitialProjectId(storedProjectId, projects = []) {
  if (storedProjectId && projects.some((project) => project.id === storedProjectId)) {
    return storedProjectId;
  }
  return projects[0]?.id || '';
}

export function selectProject(state, projectId) {
  return {
    ...state,
    currentProjectId: resolveInitialProjectId(projectId, state.projects || []),
  };
}
