import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let requestCount = 0;
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  requestCount++;
  req.resume();
  req.on('end', () => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'quota_exceeded',
        message: '用户额度不足, 剩余额度: ¥-0.05',
      },
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const previous = {
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
  cooldown: process.env.LLM_FAILURE_COOLDOWN_MS,
};

try {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_MODEL = 'test-model';
  process.env.LLM_FAILURE_COOLDOWN_MS = '60000';

  const suffix = Date.now();
  const purpose = `circuit-test-${suffix}`;
  const { callClaude, getLlmCircuitState, resetLlmCircuitForTests } = await import(`../server/services/claude.js?circuit=${suffix}`);
  resetLlmCircuitForTests();

  const first = await callClaude('system', 'user', { purpose });
  const state = getLlmCircuitState();
  const second = await callClaude('system', 'user again', { purpose });

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(requestCount, 1, 'second call must be skipped while circuit is open');
  assert.equal(state.open, true);
  assert.equal(state.reason, 'quota');
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previous.apiKey;
  if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previous.baseUrl;
  if (previous.model === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = previous.model;
  if (previous.cooldown === undefined) delete process.env.LLM_FAILURE_COOLDOWN_MS;
  else process.env.LLM_FAILURE_COOLDOWN_MS = previous.cooldown;
}

console.log('LLM circuit breaker OK');
