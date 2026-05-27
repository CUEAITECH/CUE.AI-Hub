import { httpClient } from './httpClient.js';

export function createTasksApi(client = httpClient) {
  return {
    createTask(body) {
      return client.request('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    },
    updateTask(id, body) {
      return client.request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    deleteTask(id) {
      return client.request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    generateAssignmentBrief(assignmentId) {
      return client.request(`/api/assignments/${encodeURIComponent(assignmentId)}/brief`, { method: 'POST' });
    },
    refreshRecommendations(body = {}) {
      return client.request('/api/recommendations/refresh', { method: 'POST', body: JSON.stringify(body) });
    },
    getTaskExplanation(taskId, tenantId = 'default') {
      return client.request(`/v2/tasks/${encodeURIComponent(taskId)}/explanation`, {
        headers: tenantId ? { 'X-Tenant-Id': tenantId } : {},
      });
    },
    createPr(taskId) {
      return client.request(`/api/tasks/${encodeURIComponent(taskId)}/create-pr`, { method: 'POST' });
    },
  };
}

export const tasksApi = createTasksApi();
