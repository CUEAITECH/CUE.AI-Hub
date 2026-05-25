import { httpClient } from './httpClient.js';

export function createProjectsApi(client = httpClient) {
  return {
    listProjects() {
      return client.request('/api/projects');
    },
    transferFounder(projectId, body) {
      return client.request(`/api/projects/${encodeURIComponent(projectId)}/transfer-founder`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}

export const projectsApi = createProjectsApi();
