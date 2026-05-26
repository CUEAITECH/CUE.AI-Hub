import { httpClient } from './httpClient.js';

function buildQuery(params) {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

export function createPullsApi(client = httpClient) {
  return {
    listPulls(params = {}) {
      return client.request(`/api/pulls${buildQuery(params)}`);
    },
    submitDecision(pullId, decision) {
      return client.request(`/api/pulls/${encodeURIComponent(pullId)}/decision`, {
        method: 'PATCH',
        body: JSON.stringify({ humanDecision: decision }),
      });
    },
  };
}

export const pullsApi = createPullsApi();
