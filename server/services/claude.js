import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
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

export async function callClaude(systemPrompt, userPrompt) {
  const client = getClient();
  if (!client) return null;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    });
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
  const match = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  try {
    return JSON.parse((match ? match[1] : text).trim());
  } catch {
    return null;
  }
}
