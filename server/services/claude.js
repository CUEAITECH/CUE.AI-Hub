// server/services/claude.js
// LLM 调用层（全量迁移至 OpenAI SDK）
//
// 导出接口与 Anthropic 版完全兼容，所有调用方零改动：
//   callClaude(sys, user, opts?) → 主力模型（gpt-4.5，规划/解释/生成类）
//   callHaiku(sys, user, opts?)  → 轻量模型（gpt-4.1-mini，review map-chunk 高频场景）
//   parseJsonOutput(text)        → LLM 输出 JSON 提取（语言无关，不变）
//   isAvailable()                → 是否配置了 OPENAI_API_KEY
//
// LLM 路由器（Part I 决策 14）：
//   review map-chunk（高频/廉价）→ MINI_MODEL（gpt-4.1-mini）
//   planner / explainer / 生成类  → DEFAULT_MODEL（gpt-4.5）
//
// Prompt caching：
//   OpenAI 对相同 system prompt 前缀自动缓存（Prompt Cache，≥1024 token 触发）
//   不需要像 Anthropic 那样显式传 cache_control，删除即可

import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import logger from '../logger.js';

// ── 模型配置（env 覆盖） ─────────────────────────────────────────
const DEFAULT_MODEL = process.env.OPENAI_MODEL      || 'gpt-5.5';
const MINI_MODEL    = process.env.OPENAI_MINI_MODEL || 'gpt-5.4-mini';
const DEFAULT_COOLDOWNS_MS = {
  auth: 10 * 60 * 1000,
  quota: 10 * 60 * 1000,
  rate_limit: 60 * 1000,
  server: 30 * 1000,
  network: 30 * 1000,
};

let circuitOpenUntil = 0;
let circuitReason = null;

function getModel(override) { return override || DEFAULT_MODEL; }

// ── 模型单价表（$/1M tokens）── 按模型名关键词匹配 ───────────────────
const MODEL_PRICING = [
  // mini / 轻量模型（高频低成本）
  { pattern: /mini/i,          inputPer1M: 0.40,  outputPer1M: 1.60  },
  // GPT-5.5 / GPT-5 旗舰
  { pattern: /5\.5|gpt-5(?![\d.])/i, inputPer1M: 2.00,  outputPer1M: 8.00  },
  // GPT-4o / GPT-4.5
  { pattern: /4o|4\.5/i,       inputPer1M: 5.00,  outputPer1M: 15.00 },
  // GPT-4 Turbo
  { pattern: /4-turbo|4\.1(?!-mini)/i, inputPer1M: 10.00, outputPer1M: 30.00 },
];
const DEFAULT_PRICING = { inputPer1M: 3.00, outputPer1M: 15.00 }; // 兜底

function estimateCostUsd(model = '', inputTokens = 0, outputTokens = 0) {
  const pricing = MODEL_PRICING.find((p) => p.pattern.test(model)) || DEFAULT_PRICING;
  return (Number(inputTokens || 0) * pricing.inputPer1M / 1_000_000)
       + (Number(outputTokens || 0) * pricing.outputPer1M / 1_000_000);
}

async function recordLlmCall({
  purpose = 'general',
  model,
  systemPrompt,
  userPrompt,
  response,
  latencyMs,
  refType = null,
  refId = null,
  failureReason = null,
}) {
  try {
    const { dbWrite } = await import('../db/actor.js');
    const usage = response?.usage || {};
    const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
    const promptHash = createHash('sha256')
      .update(`${systemPrompt || ''}\n---\n${userPrompt || ''}`)
      .digest('hex');

    await dbWrite('llm-call:record', (db) => {
      const result = db.prepare(`
        INSERT INTO llm_calls
          (tenant_id, purpose, model, prompt_hash, cache_hit, input_tokens, output_tokens, cost_usd, latency_ms, ref_type, ref_id)
        VALUES
          (@tenantId, @purpose, @model, @promptHash, @cacheHit, @inputTokens, @outputTokens, @costUsd, @latencyMs, @refType, @refId)
      `).run({
        tenantId: 'default',
        purpose,
        model,
        promptHash,
        cacheHit: cachedTokens > 0 ? 1 : 0,
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(model, inputTokens, outputTokens),
        latencyMs,
        refType,
        refId,
      });
      db.prepare(`
        INSERT INTO events (tenant_id, type, payload_json, source, event_id, processed_at)
        VALUES (@tenantId, @type, @payloadJson, @source, @eventId, CURRENT_TIMESTAMP)
      `).run({
        tenantId: 'default',
        type: outputTokens > 0 ? 'llm.call.completed' : 'llm.call.failed',
        payloadJson: JSON.stringify({
          purpose,
          model,
          inputTokens,
          outputTokens,
          latencyMs,
          refType,
          refId,
          llmCallId: result.lastInsertRowid,
          failureReason,
        }),
        source: 'llm',
        eventId: `llm:${result.lastInsertRowid}`,
      });
    });
  } catch (err) {
    logger.warn('[LLM] 账本写入失败:', err.message);
  }
}

async function recordLlmSkipped({
  purpose = 'general',
  model,
  refType = null,
  refId = null,
  reason,
  retryAfterMs,
}) {
  try {
    const { dbWrite } = await import('../db/actor.js');
    await dbWrite('llm-call:skipped', (db) => {
      db.prepare(`
        INSERT INTO events (tenant_id, type, payload_json, source, event_id, processed_at)
        VALUES (@tenantId, @type, @payloadJson, @source, @eventId, CURRENT_TIMESTAMP)
      `).run({
        tenantId: 'default',
        type: 'llm.call.skipped',
        payloadJson: JSON.stringify({
          purpose,
          model,
          refType,
          refId,
          reason,
          retryAfterMs,
        }),
        source: 'llm',
        eventId: `llm:skipped:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      });
    });
  } catch (err) {
    logger.warn('[LLM] skipped event write failed:', err.message);
  }
}

function classifyLlmError(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  if (status === 401) return 'auth';
  if (status === 403 && /(quota|balance|billing|insufficient|额度|余额|欠费)/i.test(message)) return 'quota';
  if (status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (err?.name === 'AbortError') return 'aborted';
  if (/(fetch failed|econnreset|etimedout|enotfound|network|socket)/i.test(message)) return 'network';
  return 'unknown';
}

function cooldownMsFor(reason, err) {
  const retryAfterHeader = err?.headers?.['retry-after'] ?? err?.headers?.get?.('retry-after');
  const retryAfter = Number(retryAfterHeader || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const envMs = Number(process.env.LLM_FAILURE_COOLDOWN_MS || 0);
  if (Number.isFinite(envMs) && envMs > 0) return envMs;
  return DEFAULT_COOLDOWNS_MS[reason] || 0;
}

function openCircuit(reason, err) {
  const cooldownMs = cooldownMsFor(reason, err);
  if (cooldownMs <= 0) return;
  circuitReason = reason;
  circuitOpenUntil = Date.now() + cooldownMs;
  logger.warn(`[LLM] circuit opened for ${reason}; retry after ${Math.ceil(cooldownMs / 1000)}s`);
}

export function getLlmCircuitState() {
  const retryAfterMs = Math.max(0, circuitOpenUntil - Date.now());
  return {
    open: retryAfterMs > 0,
    reason: retryAfterMs > 0 ? circuitReason : null,
    retryAfterMs,
  };
}

export function resetLlmCircuitForTests() {
  circuitOpenUntil = 0;
  circuitReason = null;
}

let _client = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseURL = process.env.OPENAI_BASE_URL; // 支持代理（如 Azure、LiteLLM）
  _client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return _client;
}

/** 是否已配置 OPENAI_API_KEY */
export function isAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * 调用 OpenAI Chat Completions（默认 gpt-4.5，用于 planner / explainer / 生成类）
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [options]
 * @param {string} [options.model]      - 覆盖 model
 * @param {number} [options.maxTokens]  - 最大输出 token（默认 4096）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string|null>}  LLM 文本输出；失败/无 key 时返回 null
 */
export async function callClaude(systemPrompt, userPrompt, options = {}) {
  // LLM_DRY_RUN=true：拦截所有 LLM 调用，写入 trace 但不调真 API
  if (process.env.LLM_DRY_RUN === 'true') {
    try {
      const { trace } = await import('./syncTrace.js');
      trace('llm-call-dryrun', {
        systemPromptPrefix: (systemPrompt || '').slice(0, 80),
        userPromptPrefix:   (userPrompt || '').slice(0, 80),
        model:              getModel(options.model),
        caller:             new Error().stack.split('\n').slice(2, 7).map((s) => s.trim()),
      });
    } catch { /* syncTrace 可选 */ }
    return null;
  }

  const client = getClient();
  if (!client) return null;

  const startedAt = Date.now();
  const model = getModel(options.model);
  const circuit = getLlmCircuitState();
  if (circuit.open) {
    await recordLlmSkipped({
      purpose: options.purpose,
      model,
      refType: options.refType,
      refId: options.refId,
      reason: circuit.reason,
      retryAfterMs: circuit.retryAfterMs,
    });
    logger.warn(`[LLM] circuit open (${circuit.reason}), skipped API call and used fallback`);
    return null;
  }

  try {
    const fetchOptions = options.signal ? { signal: options.signal } : undefined;

    const response = await client.chat.completions.create(
      {
        model,
        max_tokens: options.maxTokens || 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      },
      fetchOptions,
    );

    // 输出截断检测（finish_reason === 'length' 等价于 Anthropic 的 max_tokens）
    const finishReason = response.choices[0]?.finish_reason;
    if (finishReason === 'length') {
      logger.warn(`[LLM] 输出在 max_tokens=${options.maxTokens || 4096} 处被截断（finish_reason=length），输出可能不完整`);
    }

    await recordLlmCall({
      purpose: options.purpose,
      model,
      systemPrompt,
      userPrompt,
      response,
      latencyMs: Date.now() - startedAt,
      refType: options.refType,
      refId: options.refId,
    });

    return response.choices[0]?.message?.content ?? null;

  } catch (err) {
    const failureReason = classifyLlmError(err);
    await recordLlmCall({
      purpose: options.purpose,
      model,
      systemPrompt,
      userPrompt,
      response: null,
      latencyMs: Date.now() - startedAt,
      refType: options.refType,
      refId: options.refId,
      failureReason,
    });
    openCircuit(failureReason, err);
    if (err instanceof OpenAI.AuthenticationError || err.status === 401) {
      logger.error('[LLM] API key 无效，将使用规则引擎');
    } else if (err instanceof OpenAI.RateLimitError || err.status === 429) {
      logger.error('[LLM] 触发频率限制，将使用规则引擎');
    } else if (err?.name === 'AbortError') {
      logger.warn('[LLM] 调用被 AbortSignal 取消');
    } else {
      logger.error('[LLM] API 调用失败，降级到规则引擎:', err.message);
    }
    return null;
  }
}

/**
 * 便捷函数：用轻量模型调用（gpt-4.1-mini，reviewer map-chunk 高频低成本场景）
 * 签名与 callClaude 完全一致，调用方无需关心 model 名称
 */
export async function callHaiku(systemPrompt, userPrompt, options = {}) {
  return callClaude(systemPrompt, userPrompt, { ...options, model: MINI_MODEL });
}

/**
 * 从 LLM 输出提取 JSON（语言无关，与 Anthropic 版完全一致）
 */
export function parseJsonOutput(text) {
  if (!text) return null;
  // 1. 优先提取 markdown 代码块
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* 继续尝试 */ }
  }
  // 2. 尝试直接解析全文
  try { return JSON.parse(text.trim()); } catch { /* 继续尝试 */ }
  // 3. 提取第一个完整 JSON 对象 {...}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch { /* 继续尝试 */ }
  }
  // 4. 提取第一个 JSON 数组 [...]
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch { /* 继续尝试 */ }
  }
  return null;
}
