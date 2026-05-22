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
import logger from '../logger.js';

// ── 模型配置（env 覆盖） ─────────────────────────────────────────
const DEFAULT_MODEL = process.env.OPENAI_MODEL      || 'gpt-5.5';
const MINI_MODEL    = process.env.OPENAI_MINI_MODEL || 'gpt-5.4-mini';

function getModel(override) { return override || DEFAULT_MODEL; }

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

  try {
    const fetchOptions = options.signal ? { signal: options.signal } : undefined;

    const response = await client.chat.completions.create(
      {
        model:      getModel(options.model),
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

    return response.choices[0]?.message?.content ?? null;

  } catch (err) {
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
