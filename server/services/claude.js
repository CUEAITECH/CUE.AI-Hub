import Anthropic from '@anthropic-ai/sdk';
import logger from '../logger.js';

// ── LLM 路由器（Part I 决策 14）──────────────────────────────────
// 按调用场景分配不同 model：
//   review map-chunk（高频/廉价）→ HAIKU
//   planner / explainer / 生成类   → SONNET（默认）
// 调用方通过 options.model 覆盖，或使用 callHaiku() 便捷函数
const DEFAULT_MODEL  = process.env.CLAUDE_MODEL  || 'claude-sonnet-4-5';
const HAIKU_MODEL    = process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-4-5';

// 懒读取：ES module import 先于 .env 加载执行，所以不能在模块顶层取值
function getModel(override) { return override || DEFAULT_MODEL; }
let _client = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  _client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return _client;
}

export function isAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * 调用 Claude（默认 Sonnet，用于 planner / explainer / 生成类）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [options]
 * @param {string} [options.model]      - 覆盖 model（如 HAIKU_MODEL）
 * @param {number} [options.maxTokens]  - 最大输出 token
 * @param {AbortSignal} [options.signal]
 */
export async function callClaude(systemPrompt, userPrompt, options = {}) {
  // LLM_DRY_RUN=true：拦截所有 LLM 调用，写入 trace 但不调真 API
  // 用于排查"为什么会有几千次 LLM 调用"——能完整复现触发链路而不烧钱
  if (process.env.LLM_DRY_RUN === 'true') {
    try {
      const { trace } = await import('./syncTrace.js');
      trace('claude-call-dryrun', {
        systemPromptPrefix: (systemPrompt || '').slice(0, 80),
        userPromptPrefix: (userPrompt || '').slice(0, 80),
        caller: new Error().stack.split('\n').slice(2, 7).map((s) => s.trim())
      });
    } catch {}
    return null;
  }

  const client = getClient();
  if (!client) return null;
  try {
    // SDK 接收 second-arg request options（AbortSignal 等），允许调用方在超时时取消底层 HTTP 请求
    const requestOptions = options.signal ? { signal: options.signal } : undefined;
    const response = await client.messages.create({
      model: getModel(options.model),
      max_tokens: options.maxTokens || 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    }, requestOptions);
    // 检测因 max_tokens 截断的情况，给出明确日志
    if (response.stop_reason === 'max_tokens') {
      logger.warn(`[Claude] 输出在 max_tokens=${options.maxTokens || 4096} 处被截断（stop_reason=max_tokens），输出可能不完整`);
    }
    return response.content.find((b) => b.type === 'text')?.text ?? null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      logger.error('[Claude] API key 无效，将使用规则引擎');
    } else if (err instanceof Anthropic.RateLimitError) {
      logger.error('[Claude] 触发频率限制，将使用规则引擎');
    } else {
      logger.error('[Claude] API 调用失败，降级到规则引擎:', err.message);
    }
    return null;
  }
}

/**
 * 便捷函数：用 Haiku 调用（reviewer map-chunk，高频低成本场景）
 * 签名与 callClaude 完全一致，调用方无需关心 model 名称
 */
export async function callHaiku(systemPrompt, userPrompt, options = {}) {
  return callClaude(systemPrompt, userPrompt, { ...options, model: HAIKU_MODEL });
}

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
