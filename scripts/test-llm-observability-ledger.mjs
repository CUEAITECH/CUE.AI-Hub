import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { initDb, getDb } from '../server/db/index.js';

initDb();
const db = getDb();

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'test-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ledger ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        prompt_tokens_details: { cached_tokens: 3 },
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
};

try {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_MODEL = 'test-model';

  const before = db.prepare('SELECT COUNT(*) as n FROM llm_calls WHERE purpose = ?').get('ledger-test').n;
  const eventsBefore = db.prepare('SELECT COUNT(*) as n FROM events WHERE type = ?').get('llm.call.completed').n;
  const { callClaude } = await import(`../server/services/claude.js?ledger=${Date.now()}`);
  const output = await callClaude('system', 'user', { purpose: 'ledger-test', refType: 'task', refId: 't-ledger' });
  const after = db.prepare('SELECT COUNT(*) as n FROM llm_calls WHERE purpose = ?').get('ledger-test').n;
  const eventsAfter = db.prepare('SELECT COUNT(*) as n FROM events WHERE type = ?').get('llm.call.completed').n;
  const row = db.prepare('SELECT * FROM llm_calls WHERE purpose = ? ORDER BY id DESC LIMIT 1').get('ledger-test');

  assert.equal(output, 'ledger ok');
  assert.equal(after, before + 1);
  assert.equal(row.model, 'test-model');
  assert.equal(row.input_tokens, 12);
  assert.equal(row.output_tokens, 4);
  assert.equal(row.cache_hit, 1);
  assert.equal(row.ref_type, 'task');
  assert.equal(row.ref_id, 't-ledger');
  assert.equal(eventsAfter, eventsBefore + 1);
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previous.apiKey;
  if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previous.baseUrl;
  if (previous.model === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = previous.model;
}

console.log('LLM observability ledger OK');
