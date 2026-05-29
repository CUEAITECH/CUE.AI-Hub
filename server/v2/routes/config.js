// server/v2/routes/config.js
// GET  /v2/config            — 返回当前配置（敏感值打码）
// POST /v2/config            — 批量更新配置（写入 hub_config 表，立即生效）
// POST /v2/config/sync-pr-agent — 把 LLM 配置推送到 GitHub Secrets + 更新 workflow YAML

import { z } from 'zod';
import { getConfig, getAllConfig, setConfigs } from '../../services/configStore.js';
import { parseRepo } from '../../services/githubApi.js';

// ── 1. GET /v2/config ────────────────────────────────────────────────────────
async function handleGet(ctx) {
  const { sendV2Json } = ctx;
  sendV2Json(200, { config: getAllConfig({ mask: true }) });
  return true;
}

// ── 2. POST /v2/config ───────────────────────────────────────────────────────
async function handlePost(ctx) {
  const { readBody, sendV2Json, sendV2Error } = ctx;

  const ALLOWED_KEYS = new Set([
    'openai.apiKey', 'openai.baseUrl', 'openai.model', 'openai.miniModel',
    'newapi.token', 'newapi.userId', 'newapi.quotaRate',
  ]);

  const schema = z.record(z.string());
  let body;
  try { body = schema.parse(await readBody()); }
  catch (e) { sendV2Error(400, e.message); return true; }

  const entries = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_KEYS.has(k)) entries[k] = v;
  }
  if (!Object.keys(entries).length) { sendV2Error(400, 'no valid keys'); return true; }

  setConfigs(entries);
  sendV2Json(200, { ok: true, updated: Object.keys(entries), config: getAllConfig({ mask: true }) });
  return true;
}

// ── 3. POST /v2/config/sync-pr-agent ────────────────────────────────────────
async function handleSyncPrAgent(ctx) {
  const { sendV2Json, sendV2Error } = ctx;

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) { sendV2Error(503, 'GITHUB_TOKEN not configured'); return true; }

  // 找 PR-Agent 所在的 GitHub 仓库（读 state 里的 projects）
  const { loadStore } = await import('../../store.js');
  const store = await loadStore();
  const project = (store.projects || []).find((p) => p.githubOwner && p.githubRepo);
  if (!project) { sendV2Error(404, 'no github project found in hub'); return true; }

  const owner = project.githubOwner;
  const repo  = project.githubRepo;
  const base  = `https://api.github.com/repos/${owner}/${repo}`;
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const results = { secrets: {}, workflowYaml: null };

  // ── 3a. 更新 GitHub Secrets：OPENAI_API_KEY ──────────────────────────────
  const apiKey = getConfig('openai.apiKey');
  if (apiKey) {
    try {
      // 获取仓库公钥
      const pkRes = await fetch(`${base}/actions/public-key`, { headers: ghHeaders });
      if (!pkRes.ok) throw new Error(`get public key: ${pkRes.status}`);
      const { key: pubKeyB64, key_id: keyId } = await pkRes.json();

      const encryptedValue = await encryptSecret(pubKeyB64, apiKey);

      const putRes = await fetch(`${base}/actions/secrets/OPENAI_API_KEY`, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId }),
      });
      results.secrets.OPENAI_API_KEY = putRes.ok ? 'updated' : `error:${putRes.status}`;
    } catch (e) {
      results.secrets.OPENAI_API_KEY = `error:${e.message}`;
    }
  } else {
    results.secrets.OPENAI_API_KEY = 'skipped:no-api-key';
  }

  // ── 3b. 更新 workflow YAML：OPENAI_API_BASE + CONFIG.MODEL ───────────────
  const baseUrl = getConfig('openai.baseUrl');
  const model   = getConfig('openai.miniModel'); // PR-Agent 用 mini 模型

  const WORKFLOW_PATH = '.github/workflows/pr-agent.yml';
  try {
    // GET 当前文件内容
    const fileRes = await fetch(`${base}/contents/${WORKFLOW_PATH}`, { headers: ghHeaders });
    if (!fileRes.ok) throw new Error(`get workflow: ${fileRes.status}`);
    const fileData = await fileRes.json();
    const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');

    let updated = currentContent;
    let changed = false;

    if (baseUrl) {
      const newBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/v1`;
      const prev = updated;
      updated = updated
        .replace(/^(\s*OPENAI_API_BASE:\s*).*$/m,   `$1${newBase}`)
        .replace(/^(\s*OPENAI__API_BASE:\s*).*$/m,  `$1${newBase}`);
      if (updated !== prev) changed = true;
    }

    if (model) {
      const prev = updated;
      updated = updated.replace(/^(\s*CONFIG\.MODEL:\s*).*$/m, `$1${model}`);
      if (updated !== prev) changed = true;
    }

    if (changed) {
      const putRes = await fetch(`${base}/contents/${WORKFLOW_PATH}`, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `config: sync PR-Agent LLM config from Hub\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`,
          content: Buffer.from(updated).toString('base64'),
          sha: fileData.sha,
        }),
      });
      results.workflowYaml = putRes.ok ? 'updated' : `error:${putRes.status}`;
    } else {
      results.workflowYaml = 'no-change';
    }
  } catch (e) {
    results.workflowYaml = `error:${e.message}`;
  }

  sendV2Json(200, { ok: true, repo: `${owner}/${repo}`, results });
  return true;
}

// ── libsodium sealed box（GitHub Secrets 加密）──────────────────────────────
// 使用 Node.js 内置 crypto（无需额外依赖）实现 X25519 + XSalsa20-Poly1305
async function encryptSecret(publicKeyB64, secretValue) {
  // GitHub 要求 libsodium crypto_box_seal，Node.js 内置 crypto 不直接支持
  // 尝试通过 @octokit/rest 没有加密能力，需要自行实现或依赖 tweetsodium
  // 这里优先尝试 libsodium-wrappers；如果没安装，回退到说明信息
  try {
    const sodium = await import('libsodium-wrappers').then(m => m.default ?? m);
    await sodium.ready;
    const pubKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
    const secret = sodium.from_string(secretValue);
    const encrypted = sodium.crypto_box_seal(secret, pubKey);
    return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error('libsodium-wrappers not installed. Run: npm install libsodium-wrappers');
  }
}

// ── 路由分发 ─────────────────────────────────────────────────────────────────
export async function handle(ctx) {
  const { method, path } = ctx;

  if (method === 'GET'  && path === '/v2/config')               return handleGet(ctx);
  if (method === 'POST' && path === '/v2/config')               return handlePost(ctx);
  if (method === 'POST' && path === '/v2/config/sync-pr-agent') return handleSyncPrAgent(ctx);

  return false;
}
