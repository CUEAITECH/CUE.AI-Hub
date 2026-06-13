// server/services/promptLoader.js
//
// 外部化 prompt 管理。借鉴 Taskmaster PromptManager 的设计：
// prompt 存 JSON 文件（server/prompts/*.json），与业务代码解耦，
// prompt 变更在 git diff 里独立可见，不触碰业务逻辑。
//
// schema（每个 JSON 文件必须满足）：
//   id          string  — 唯一标识，与文件名一致
//   version     string  — semver，方便日志追踪 prompt 版本
//   description string  — 一句话说明用途
//   prompts.system string — 系统 prompt 文本

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../prompts');

// 模块级缓存：进程内复用同一对象，避免重复读磁盘
const cache = new Map();

function validate(data, id) {
  if (!data.id || typeof data.id !== 'string') throw new Error(`[PromptLoader] ${id}: missing 'id'`);
  if (!data.version || typeof data.version !== 'string') throw new Error(`[PromptLoader] ${id}: missing 'version'`);
  if (!data.prompts?.system || typeof data.prompts.system !== 'string') {
    throw new Error(`[PromptLoader] ${id}: missing 'prompts.system'`);
  }
}

export function loadPrompt(id) {
  if (cache.has(id)) return cache.get(id);

  const filePath = resolve(PROMPTS_DIR, `${id}.json`);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`[PromptLoader] prompt file not found: ${id} (looked in ${filePath})`);
  }

  const data = JSON.parse(raw);
  validate(data, id);
  cache.set(id, data);
  return data;
}

export function getSystemPrompt(id) {
  return loadPrompt(id).prompts.system;
}
