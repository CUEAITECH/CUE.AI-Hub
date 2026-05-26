import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile('.github/workflows/pr-agent.yml', 'utf8');

assert.match(workflow, /CONFIG\.AI_PROVIDER:\s*openai/, 'PR-Agent should use the OpenAI provider');
assert.match(workflow, /CONFIG\.MODEL:\s*gpt-5\.4-mini/, 'PR-Agent should use the low-cost review model');
assert.match(
  workflow,
  /OPENAI__(?:API_BASE|KEY):/,
  'PR-Agent should use official double-underscore OpenAI-like API env vars',
);
assert.match(
  workflow,
  /(?:OPENAI__API_BASE|OPENAI\.API_BASE|OPENAI_API_BASE):\s*https:\/\/api\.ikuncode\.cc\/v1/,
  'PR-Agent should call the ikuncode OpenAI-compatible v1 endpoint',
);

console.log('PR-Agent workflow config OK');
