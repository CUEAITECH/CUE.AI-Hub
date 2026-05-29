import { httpClient } from './httpClient.js';

export function createAuthApi(client = httpClient) {
  return {
    me(query = '') {
      return client.request(`/api/auth/me${query}`);
    },

    // ── 登录（projectId 不再必填；全局登录后服务器返回 orgs 列表或自动选择）
    loginPassword({ username, password, orgId, projectId } = {}) {
      return client.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, orgId: orgId || projectId }),
      });
    },
    loginEmailCode({ username, emailCode, orgId, projectId } = {}) {
      return client.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, emailCode, orgId: orgId || projectId }),
      });
    },
    sendEmailCode({ email, purpose, projectId } = {}) {
      // projectId 仍可传（向下兼容），服务器已不依赖它做验证
      return client.request('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email, purpose, projectId }),
      });
    },

    // ── 组织相关
    listOrgs() {
      return client.request('/api/auth/orgs');
    },
    selectOrg(orgId) {
      return client.request('/api/auth/select-org', {
        method: 'POST',
        body: JSON.stringify({ orgId }),
      });
    },
    createOrg({ name, summary = '', githubOwner = '', repository = '' } = {}) {
      return client.request('/api/orgs', {
        method: 'POST',
        body: JSON.stringify({ name, summary, githubOwner, repository }),
      });
    },
    inviteMember(orgId, { username, email, phone, role = 'developer' } = {}) {
      return client.request(`/api/orgs/${encodeURIComponent(orgId)}/invite`, {
        method: 'POST',
        body: JSON.stringify({ username, email, phone, role }),
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
