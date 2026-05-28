// server/services/newApiLedger.js
// 从 NewAPI（One-API fork）拉取真实 LLM 调用日志
//
// 环境变量：
//   NEWAPI_BASE_URL   NewAPI 地址，默认复用 OPENAI_BASE_URL 去掉 /v1 后缀
//   NEWAPI_TOKEN      NewAPI 用户 token（可在 NewAPI 控制台「系统令牌」里生成）
//   NEWAPI_QUOTA_RATE quota 换算汇率：1 USD = N quota，默认 500000（NewAPI 标准配置）
//
// NewAPI /api/log 返回格式：
//   { success: true, data: { items: [...], total: N } }
//   每条: { id, model_name, input_tokens, output_tokens, quota, created_at, username, ... }

const QUOTA_RATE = Number(process.env.NEWAPI_QUOTA_RATE || 500000); // 1 USD = 500,000 quota
const USD_TO_YUAN = 7.2;

function getBaseUrl() {
  const explicit = process.env.NEWAPI_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  // 从 OPENAI_BASE_URL 推导（去掉 /v1 后缀）
  const openaiBase = process.env.OPENAI_BASE_URL || '';
  return openaiBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '') || null;
}

function getToken() {
  return process.env.NEWAPI_TOKEN || null;
}

export function isNewApiAvailable() {
  return Boolean(getToken() && getBaseUrl());
}

/**
 * 拉取今日（上海时区）的 LLM 调用日志
 * @returns {Promise<{ items: object[], totalCalls: number, totalInput: number, totalOutput: number, totalQuota: number, costYuan: number, costUsd: number, byModel: object[] } | null>}
 */
export async function fetchTodayLedger() {
  const baseUrl = getBaseUrl();
  const token   = getToken();
  if (!baseUrl || !token) return null;

  // 今天上海时区 00:00:00 的 Unix 时间戳
  const now = new Date();
  const shanghaiOffset = 8 * 60 * 60 * 1000;
  const shanghaiNow = new Date(now.getTime() + shanghaiOffset);
  const todayStart = new Date(Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate()
  ) - shanghaiOffset);
  const startTs = Math.floor(todayStart.getTime() / 1000);
  const endTs   = Math.floor(now.getTime() / 1000) + 1;

  // 分页拉取（最多 3 页，每页 100 条，通常够用）
  let allItems = [];
  for (let p = 1; p <= 3; p++) {
    const url = `${baseUrl}/api/log?start_timestamp=${startTs}&end_timestamp=${endTs}&p=${p}&page_size=100&type=2`;
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000)
      });
    } catch (err) {
      break; // 网络超时或连接失败，用已有数据
    }
    if (!res.ok) break;
    const body = await res.json();
    const items = body?.data?.items || [];
    allItems = allItems.concat(items);
    if (items.length < 100) break; // 最后一页
  }

  if (!allItems.length) return { items: [], totalCalls: 0, totalInput: 0, totalOutput: 0, totalQuota: 0, costYuan: 0, costUsd: 0, byModel: [] };

  // 汇总
  let totalInput = 0, totalOutput = 0, totalQuota = 0;
  const modelMap = {};
  for (const item of allItems) {
    const input  = Number(item.prompt_tokens    || item.input_tokens  || 0);
    const output = Number(item.completion_tokens || item.output_tokens || 0);
    const quota  = Number(item.quota || 0);
    totalInput  += input;
    totalOutput += output;
    totalQuota  += quota;

    const model = item.model_name || item.model || '未知';
    if (!modelMap[model]) modelMap[model] = { model, calls: 0, input: 0, output: 0, quota: 0 };
    modelMap[model].calls  += 1;
    modelMap[model].input  += input;
    modelMap[model].output += output;
    modelMap[model].quota  += quota;
  }

  // 优先用 quota 换算（若 quota 全为 0 说明未配置扣费，降级用 token×单价估算）
  const useQuota = totalQuota > 0;
  let costUsd, byModelArr;

  if (useQuota) {
    costUsd = totalQuota / QUOTA_RATE;
    byModelArr = Object.values(modelMap).map((m) => ({
      ...m,
      costYuan: parseFloat((m.quota / QUOTA_RATE * USD_TO_YUAN).toFixed(3))
    }));
  } else {
    // quota 未配置 → 用真实 token 数 × 模型单价表
    const MODEL_PRICING = [
      { pattern: /mini/i,                      inputPer1M: 0.40,  outputPer1M: 1.60  },
      { pattern: /5\.5|gpt-5(?![\d.])/i,       inputPer1M: 2.00,  outputPer1M: 8.00  },
      { pattern: /4o|4\.5/i,                   inputPer1M: 5.00,  outputPer1M: 15.00 },
      { pattern: /4[-.]?turbo|4\.1(?!-mini)/i, inputPer1M: 10.00, outputPer1M: 30.00 },
    ];
    const DEFAULT_P = { inputPer1M: 3.00, outputPer1M: 15.00 };
    costUsd = 0;
    byModelArr = Object.values(modelMap).map((m) => {
      const p = MODEL_PRICING.find((r) => r.pattern.test(m.model)) || DEFAULT_P;
      const mUsd = m.input * p.inputPer1M / 1_000_000 + m.output * p.outputPer1M / 1_000_000;
      costUsd += mUsd;
      return { ...m, costYuan: parseFloat((mUsd * USD_TO_YUAN).toFixed(3)) };
    });
  }

  const costYuan = parseFloat((costUsd * USD_TO_YUAN).toFixed(2));

  return {
    items:      allItems,
    totalCalls: allItems.length,
    totalInput,
    totalOutput,
    totalQuota,
    costSource: useQuota ? 'newapi-quota' : 'newapi-tokens',
    costYuan,
    costUsd:    parseFloat(costUsd.toFixed(4)),
    byModel:    byModelArr.sort((a, b) => b.calls - a.calls),
  };
}
