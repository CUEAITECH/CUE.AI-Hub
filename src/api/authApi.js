import { httpClient } from './httpClient.js';

export function createAuthApi(client = httpClient) {
  return {
    me(query = '') {
      return client.request(`/api/auth/me${query}`);
    },
    loginPassword({ username, password, projectId }) {
      return client.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, projectId }),
      });
    },
    loginEmailCode({ username, emailCode, projectId }) {
      return client.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, emailCode, projectId }),
      });
    },
    sendEmailCode({ email, purpose, projectId }) {
      return client.request('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email, purpose, projectId }),
      });
    },
    updateMe(body) {
      return client.request('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
  };
}

export const authApi = createAuthApi();
