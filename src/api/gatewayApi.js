// src/api/gatewayApi.js
// Gateway API 客户端 — 管理 API 密钥、查询审计日志

import { httpClient } from './httpClient.js';

export function createGatewayApi(client = httpClient) {
  return {
    /** 列出当前租户的所有 API 密钥（不含完整密钥，仅前缀） */
    listKeys() {
      return client.request('/v2/gateway/keys');
    },

    /** 生成新的 API 密钥 */
    createKey(opts = {}) {
      return client.request('/v2/gateway/keys', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
    },

    /** 撤销指定 ID 的 API 密钥 */
    revokeKey(id) {
      return client.request(`/v2/gateway/keys/${id}/revoke`, {
        method: 'POST',
        body: '{}',
      });
    },

    /** 验证当前请求使用的 API 密钥信息 */
    validate() {
      return client.request('/v2/gateway/validate');
    },

    /** 查询审计日志 */
    getAuditLog(params = {}) {
      const qs = new URLSearchParams(params).toString();
      return client.request(`/v2/gateway/audit${qs ? '?' + qs : ''}`);
    },
  };
}

export const gatewayApi = createGatewayApi();
