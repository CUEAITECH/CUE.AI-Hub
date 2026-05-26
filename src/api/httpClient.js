export function toV2RequestPath(path) {
  return typeof path === 'string' && path.startsWith('/api/')
    ? `/v2/app${path.slice('/api'.length)}`
    : path;
}

function defaultFetch(path, options) {
  return fetch(path, options);
}

function defaultSessionToken() {
  return globalThis.sessionStorage?.getItem('cueHubSessionToken') || '';
}

export function createHttpClient({
  fetchImpl = defaultFetch,
  getSessionToken = defaultSessionToken,
} = {}) {
  return {
    async request(path, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
      const sessionToken = getSessionToken();
      if (sessionToken && !headers.Authorization && !headers['X-CUE-Session-Token']) {
        headers['X-CUE-Session-Token'] = sessionToken;
      }

      const response = await fetchImpl(toV2RequestPath(path), {
        ...options,
        method,
        headers,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload.details
          ? `${payload.error || `Request failed: ${response.status}`}：${payload.details}`
          : payload.error || `Request failed: ${response.status}`;
        throw new Error(message);
      }
      return payload;
    },
  };
}

export const httpClient = createHttpClient();
