import { callClaude, parseJsonOutput } from './claude.js';

function getBaseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 4317}`;
}

async function executeGet(path) {
  const url = `${getBaseUrl()}${path}`;
  console.log(`[ApiQA]   → GET ${url}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* keep null */ }
    const snippet = JSON.stringify(body ?? text).slice(0, 500);
    console.log(`[ApiQA]   ← HTTP ${res.status} ${res.ok ? '✓' : '✗'}`);
    return { status: res.status, ok: res.ok, snippet };
  } catch (err) {
    console.error(`[ApiQA]   ← 请求失败: ${err.message}`);
    throw new Error(`GET ${path} 失败: ${err.message}`);
  }
}

async function evaluateTask({ task, commits, blockCount }) {
  console.log(`[ApiQA] 开始评估任务: ${task.title}`);

  if (!task.acceptance?.trim()) {
    throw new Error(`任务「${task.title}」无验收标准，无法评估`);
  }

  // Checkpoint 1: 生成测试用例
  console.log(`[ApiQA] [1/3] 生成测试用例…`);
  const planRaw = await callClaude(
    `你是 API 测试专家。根据任务验收标准生成 0-3 个只读 GET 测试用例。
只使用以 /api/ 开头的路径。如果验收标准无法通过 API 验证（如 UI 交互、部署配置），返回空数组 []。
返回 JSON 数组，每项包含：path（字符串）、expectation（期望验证的内容，字符串）。`,
    `任务：${task.title}
验收标准：${task.acceptance}
今日 commit：${commits.slice(0, 5).map((c) => c.title).join('；') || '无'}`,
    { maxTokens: 512 }
  );
  if (!planRaw) throw new Error(`任务「${task.title}」测试用例生成失败：LLM 返回空`);
  const testCases = parseJsonOutput(planRaw);
  if (!Array.isArray(testCases)) throw new Error(`任务「${task.title}」测试用例解析失败: ${planRaw.slice(0, 100)}`);
  console.log(`[ApiQA] [1/3] 生成 ${testCases.length} 个测试用例`);

  // Checkpoint 2: 执行测试
  console.log(`[ApiQA] [2/3] 执行 API 测试…`);
  const results = await Promise.all(
    testCases.slice(0, 3).map(async (tc) => ({
      path: tc.path,
      expectation: tc.expectation,
      result: await executeGet(tc.path)
    }))
  );
  console.log(`[ApiQA] [2/3] 测试完成，${results.filter((r) => r.result.ok).length}/${results.length} 通过`);

  // Checkpoint 3: 评估完成度
  console.log(`[ApiQA] [3/3] 评估完成度…`);
  const testSummary = results.length
    ? `API 测试结果：\n${results.map((r, i) =>
        `${i + 1}. GET ${r.path}\n   期望：${r.expectation}\n   实际：HTTP ${r.result.status} ${r.result.ok ? '✓' : '✗'}  ${r.result.snippet}`
      ).join('\n')}`
    : '该任务无法通过 API 自动验证，请根据 commit 内容和验收标准推断。';

  const evalRaw = await callClaude(
    `你是研发进度评估专家。根据 API 测试结果和任务验收标准，评估任务实际完成度。
返回 JSON（不要任何多余内容）：{"suggestedProgress":<0-100整数>,"reason":"<50字以内>","confidence":"low|medium|high"}`,
    `任务：${task.title}
验收标准：${task.acceptance}
当前进度：${task.progress}%
今日 commit：${commits.length} 条，Block 审阅：${blockCount} 条

${testSummary}`,
    { maxTokens: 256 }
  );
  if (!evalRaw) throw new Error(`任务「${task.title}」进度评估失败：LLM 返回空`);
  const ev = parseJsonOutput(evalRaw);
  if (!ev || typeof ev.suggestedProgress !== 'number') {
    throw new Error(`任务「${task.title}」进度评估结果解析失败: ${evalRaw.slice(0, 100)}`);
  }

  const result = {
    suggestedProgress: Math.min(100, Math.max(0, Math.round(ev.suggestedProgress))),
    reason: String(ev.reason || '').slice(0, 100),
    confidence: ['low', 'medium', 'high'].includes(ev.confidence) ? ev.confidence : 'medium',
    testedApis: results.map((r) => `GET ${r.path} → ${r.result.status}`)
  };
  console.log(`[ApiQA] [3/3] 评估完成：建议进度 ${result.suggestedProgress}%（${result.reason}）`);
  return result;
}

/**
 * 对晚会对账中有 commit 支撑、有验收标准的任务批量跑 API QA，最多 5 个。
 * 返回 { [taskId]: qaResult | { error: string } } 的 Map，每个任务单独记录成功或失败。
 */
export async function runApiQA({ reconciliationRows, tasks, commits, reviews }) {
  const candidates = reconciliationRows
    .filter((row) => row.commitCount > 0 && !row.completed)
    .slice(0, 5);

  console.log(`[ApiQA] 开始批量 QA，候选任务 ${candidates.length} 个`);
  if (!candidates.length) return {};

  const qaMap = {};
  await Promise.allSettled(
    candidates.map(async (row) => {
      const task = tasks.find((t) => t.id === row.taskId);
      if (!task?.acceptance?.trim()) {
        console.warn(`[ApiQA] 跳过「${row.taskTitle}」：无验收标准`);
        qaMap[row.taskId] = { error: '无验收标准，无法评估' };
        return;
      }
      const ownerCommits = commits.filter((c) => (c.owner || c.actor) === row.owner);
      const blockCount = reviews.filter((r) => r.level === 'Block' && r.owner === row.owner).length;
      try {
        qaMap[row.taskId] = await evaluateTask({ task, commits: ownerCommits, blockCount });
      } catch (err) {
        console.error(`[ApiQA] 任务「${row.taskTitle}」评估失败: ${err.message}`);
        qaMap[row.taskId] = { error: err.message };
      }
    })
  );

  const succeeded = Object.values(qaMap).filter((v) => !v.error).length;
  console.log(`[ApiQA] 批量 QA 完成：${succeeded}/${candidates.length} 成功`);
  return qaMap;
}
