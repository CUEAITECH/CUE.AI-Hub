// server/services/prPromptGenerator.js
// W5-T1: PR 描述草稿自动生成
//
// 设计：
//   1. 从任务 AC + 关联 memory 构建 prompt
//   2. LLM 生成标准 PR 描述（中文 + 验收清单）
//   3. 写入 pulls 表 body 字段，agent/人类可直接 copy-paste
//   4. LLM 不可用时降级到规则模板（保证 always-on）
//
// 使用场景：
//   - agent 完成任务后自动调用（agent.task.completed reducer 触发）
//   - 人类开 PR 前通过 POST /v2/pulls/generate-description 手动触发

import { callClaude } from './claude.js';
import { getDb } from '../db/index.js';
import { dbWrite } from '../db/actor.js';
import { searchSimilarMemory } from './vectorStore.js';

const PR_TEMPLATE = `## 变更说明

{summary}

## 关联任务

- 任务 ID：\`{taskId}\`
- 任务标题：{title}

## 验收清单（AC）

{acChecklist}

## 注意事项

{notes}

---
> 此描述由 CUE Hub 自动生成，请在 merge 前人工确认。`;

/**
 * 为任务生成 PR 描述草稿
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.tenantId
 * @param {string} [params.branchName]       - 分支名（可选，用于 LLM 参考）
 * @param {string} [params.diffSummary]      - diff 摘要（可选，agent 提供）
 * @param {string[]} [params.artifacts]      - agent 产物（PR URL 等）
 * @returns {Promise<{ body: string; source: 'llm'|'template' }>}
 */
export async function generatePRDescription({ taskId, tenantId, branchName, diffSummary, artifacts = [] }) {
  const db = getDb();

  // ── 1. 读取任务 ───────────────────────────────────────────
  const task = db.prepare(`
    SELECT t.*, a.display_name as actor_name
    FROM tasks t
    LEFT JOIN actors a ON t.actor_id = a.id
    WHERE t.id = ? AND t.tenant_id = ?
  `).get(taskId, tenantId);

  if (!task) throw new Error(`task ${taskId} not found`);

  // ── 2. 相关 memory（向量检索约定/决策/taboo，供 LLM 参考）──
  const ragQuery = [task.title, task.acceptance].filter(Boolean).join('\n');
  let memory = searchSimilarMemory(db, {
    tenantId,
    query:     ragQuery,
    projectId: task.project_id,
    limit:     10,
    kinds:     ['convention', 'decision', 'taboo'],
  });
  if (memory === null) {
    // sqlite-vec 未就绪 → 回退 confidence 排序
    memory = db.prepare(`
      SELECT kind, body FROM project_memory
      WHERE tenant_id = ? AND (project_id = ? OR project_id IS NULL)
        AND kind IN ('convention', 'decision', 'taboo')
        AND superseded_by IS NULL
      ORDER BY confidence DESC LIMIT 10
    `).all(tenantId, task.project_id || '');
  }

  // ── 3. AC 解析（从 acceptance 字段提取条目） ─────────────
  const acItems = parseAcceptanceCriteria(task.acceptance || '');

  // ── 4. LLM 生成 ──────────────────────────────────────────
  const systemPrompt = `你是一个专业的 PR 描述生成器。
生成中文 Markdown 格式的 PR 描述，简洁专业，不超过 600 字。
格式要求：
- 变更说明：1-3 句话说明做了什么、为什么
- 验收清单：每条 AC 用 "- [ ] xxx" 格式
- 注意事项：从团队约定/决策中提取与此 PR 相关的注意点（最多 3 条）
- 不要重复任务标题，不要废话`;

  const userPrompt = `任务标题：${task.title}
任务优先级：${task.priority || 'P2'}
${branchName ? `分支名：${branchName}` : ''}
${diffSummary ? `Diff 摘要：\n${diffSummary}` : ''}

验收标准（AC）：
${task.acceptance || '（未填写）'}

团队约定（参考）：
${memory.map(m => `[${m.kind}] ${m.body}`).join('\n') || '（暂无）'}

请生成标准 PR 描述。`;

  let body;
  let source = 'llm';

  try {
    const llmResult = await callClaude(systemPrompt, userPrompt);
    if (llmResult) {
      body = llmResult;
    } else {
      // LLM 不可用，降级到模板
      body = buildTemplateDescription({ task, acItems, memory, branchName, artifacts });
      source = 'template';
    }
  } catch (err) {
    console.warn('[prPromptGenerator] LLM 调用失败，降级到模板:', err.message);
    body = buildTemplateDescription({ task, acItems, memory, branchName, artifacts });
    source = 'template';
  }

  // ── 5. 记录 LLM 调用账本 ─────────────────────────────────
  if (source === 'llm') {
    await dbWrite('prPromptGenerator:llm_log', (db) => {
      db.prepare(`
        INSERT INTO llm_calls (tenant_id, purpose, model, prompt_tokens, completion_tokens, ts)
        VALUES (?, 'pr-description', 'claude-sonnet-4-6', ?, ?, ?)
      `).run(tenantId,
        Math.ceil((systemPrompt.length + userPrompt.length) / 4),
        Math.ceil(body.length / 4),
        new Date().toISOString()
      );
    });
  }

  console.log(`[prPromptGenerator] generated PR description for ${taskId} via ${source}`);
  return { body, source };
}

/**
 * 将生成的 PR 描述写入指定 PR 记录
 * 仅在 pull.body 为空时写入，避免覆盖人工填写的内容
 */
export async function injectPRDescription({ tenantId, pullId, taskId, branchName, diffSummary, artifacts }) {
  const db = getDb();

  // 确认 PR 存在
  const pull = db.prepare('SELECT * FROM pulls WHERE id = ? AND tenant_id = ?').get(pullId, tenantId);
  if (!pull) throw new Error(`pull ${pullId} not found`);

  // 如果已有内容且超过 50 字，视为已人工填写，跳过
  if (pull.body && pull.body.length > 50) {
    console.log(`[prPromptGenerator] pull ${pullId} already has body, skipping injection`);
    return { skipped: true };
  }

  const { body, source } = await generatePRDescription({
    taskId: taskId || pull.task_id,
    tenantId, branchName: branchName || pull.head_branch,
    diffSummary, artifacts,
  });

  await dbWrite('prPromptGenerator:inject', (db) => {
    db.prepare('UPDATE pulls SET body = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(body, new Date().toISOString(), pullId, tenantId);
  });

  return { body, source, injected: true };
}

// ── 工具函数 ─────────────────────────────────────────────────

/** 解析 AC 字段，返回字符串数组 */
function parseAcceptanceCriteria(acceptance) {
  if (!acceptance) return [];
  return acceptance.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\[[ x]\]\s*/i, ''));
}

/** 规则模板降级（LLM 不可用时） */
function buildTemplateDescription({ task, acItems, memory, branchName, artifacts }) {
  const acChecklist = acItems.length > 0
    ? acItems.map(item => `- [ ] ${item}`).join('\n')
    : '- [ ] （请手动填写验收清单）';

  const relevantMemory = memory.filter(m => m.kind === 'taboo' || m.kind === 'decision');
  const notes = relevantMemory.length > 0
    ? relevantMemory.slice(0, 3).map(m => `- **[${m.kind}]** ${m.body.slice(0, 80)}${m.body.length > 80 ? '…' : ''}`).join('\n')
    : '- 请确认代码符合团队规范';

  return PR_TEMPLATE
    .replace('{summary}', `实现 ${task.title}${branchName ? `（分支：\`${branchName}\`）` : ''}`)
    .replace('{taskId}', task.id)
    .replace('{title}', task.title)
    .replace('{acChecklist}', acChecklist)
    .replace('{notes}', notes);
}
