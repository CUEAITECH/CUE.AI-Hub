import { httpClient } from './httpClient.js';

function buildQuery(params) {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

function tenantHeaders(tenantId) {
  return tenantId ? { 'X-Tenant-Id': tenantId } : {};
}

export function createEventsApi(client = httpClient) {
  return {
    getGroupedEvents(params = {}, tenantId = '') {
      return client.request(`/v2/events/grouped${buildQuery(params)}`, {
        headers: tenantHeaders(tenantId),
      });
    },
    prReviewStreamUrl(type = 'pr.review.posted') {
      return `/v2/events/stream?type=${encodeURIComponent(type)}`;
    },
  };
}

export const eventsApi = createEventsApi();
