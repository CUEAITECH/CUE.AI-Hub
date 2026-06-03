import { httpClient } from './httpClient.js';

function query(params) {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

export function createAppStateApi(client = httpClient) {
  return {
    loadProjectState(projectId) {
      return client.request(`/api/state${query({ projectId })}`);
    },
    loadConfig() {
      return client.request('/api/config');
    },
    loadChecklist(projectId) {
      return client.request(`/api/stage/checklist${query({ projectId })}`);
    },
  };
}

export const appStateApi = createAppStateApi();
