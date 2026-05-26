import { httpClient } from './httpClient.js';

function buildQuery(params) {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

function tenantHeaders(tenantId) {
  return tenantId ? { 'X-Tenant-Id': tenantId } : {};
}

export function createObservabilityApi(client = httpClient) {
  return {
    getLlmStats(tenantId = '') {
      return client.request('/v2/observability/llm', {
        headers: tenantHeaders(tenantId),
      });
    },
    getEvents(params = {}, tenantId = '') {
      return client.request(`/v2/observability/events${buildQuery(params)}`, {
        headers: tenantHeaders(tenantId),
      });
    },
    getSyncHealth(tenantId = '') {
      return client.request('/v2/observability/sync-health', {
        headers: tenantHeaders(tenantId),
      });
    },
    getSpace(tenantId = '') {
      return client.request('/v2/space', {
        headers: tenantHeaders(tenantId),
      });
    },
  };
}

export const observabilityApi = createObservabilityApi();
