import { httpClient } from './httpClient.js';

/**
 * SPEC-L1 数据层：想法澄清 → PRD 生成 → 局部修改。
 * 路径用 /api/*，由 httpClient 自动映射到 /v2/app/*。
 * 解包后端的 { prd } / { prds } 信封，让调用方拿到裸对象。
 */
export function createPrdApi(client = httpClient) {
  return {
    async clarify(input) {
      return client.request('/api/ai/clarify', {
        method: 'POST',
        body: JSON.stringify({ input: String(input || '') }),
      });
    },
    async generatePrd(input, answers = {}) {
      const r = await client.request('/api/ai/generate-prd', {
        method: 'POST',
        body: JSON.stringify({ input: String(input || ''), answers }),
      });
      return r.prd;
    },
    async refinePrd(id, feedback) {
      const r = await client.request(`/api/prd/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ feedback: String(feedback || '') }),
      });
      return r.prd;
    },
    async listPrds() {
      const r = await client.request('/api/prds');
      return r.prds || [];
    },
  };
}

export const prdApi = createPrdApi();
