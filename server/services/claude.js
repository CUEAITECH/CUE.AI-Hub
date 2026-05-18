import Anthropic from '@anthropic-ai/sdk';

// 懒读取：ES module import 先于 .env 加载执行，所以不能在模块顶层取值
function getModel() { return process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'; }
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

export async function callClaude(systemPrompt, userPrompt, options = {}) {
  const client = getClient();
  if (!client) return null;
  try {
    // SDK 接收 second-arg request options（AbortSignal 等），允许调用方在超时时取消底层 HTTP 请求
    const requestOptions = options.signal ? { signal: options.signal } : undefined;
    const response = await client.messages.create({
      model: getModel(),
      max_tokens: options.maxTokens || 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    }, requestOptions);
    // 检测因 max_tokens 截断的情况，给出明确日志
    if (response.stop_reason === 'max_tokens') {
      console.warn(`[Claude] 输出在 max_tokens=${options.maxTokens || 4096} 处被截断（stop_reason=max_tokens），输出可能不完整`);
    }
    return response.content.find((b) => b.type === 'text')?.text ?? null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('[Claude] API key 无效，将使用规则引擎');
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error('[Claude] 触发频率限制，将使用规则引擎');
    } else {
      console.error('[Claude] API 调用失败，降级到规则引擎:', err.message);
    }
    return null;
  }
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
