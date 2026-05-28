// src/api/configApi.js
// 系统配置 API 客户端

import { httpClient } from './httpClient.js';

export function createConfigApi(client = httpClient) {
  return {
    /** 获取当前配置（敏感值打码） */
    getConfig() {
      return client.request('/v2/config');
    },
    /** 批量更新配置 */
    setConfig(entries) {
      return client.request('/v2/config', {
        method: 'POST',
        body: JSON.stringify(entries),
      });
    },
    /** 把 LLM 配置推送到 GitHub Secrets + 更新 PR-Agent workflow YAML */
    syncPrAgent() {
      return client.request('/v2/config/sync-pr-agent', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
  };
}

export const configApi = createConfigApi();
