// eval/llm-regression/asserts/invariants.mjs
//
// promptfoo javascript 断言 —— 检查「结构不变量」而非字节精确匹配。
// 学术依据（arXiv:2506.13023）：非确定性下评估须按语义/结构等价，不能 byte-exact。
// 每个函数签名 (output, context) → { pass, score, reason }，output 为 provider 的 JSON 字符串。

function parse(output) {
  try { return JSON.parse(output); } catch { return null; }
}

// L1 clarify：必须返回 3–5 个澄清问题（AC-L1-002）+ initialUnderstanding
export function clarifyValid(output) {
  const o = parse(output);
  if (!o) return { pass: false, score: 0, reason: 'output 非合法 JSON' };
  const q = o.clarificationQuestions;
  if (!Array.isArray(q)) return { pass: false, score: 0, reason: '缺 clarificationQuestions 数组' };
  if (q.length < 3 || q.length > 5) return { pass: false, score: 0, reason: `问题数 ${q.length}，期望 3–5` };
  if (!q.every((s) => typeof s === 'string' && s.trim().length > 0))
    return { pass: false, score: 0, reason: '存在空问题项' };
  return { pass: true, score: 1, reason: `ok（${q.length} 问）` };
}

// L2 plan：3–6 个任务，每个有非空 title 且 acceptance ≠ description（L2 核心不变量）
export function planValid(output) {
  const a = parse(output);
  if (!Array.isArray(a)) return { pass: false, score: 0, reason: 'output 不是任务数组' };
  if (a.length < 3 || a.length > 6) return { pass: false, score: 0, reason: `任务数 ${a.length}，期望 3–6` };
  for (const [i, t] of a.entries()) {
    if (!t || typeof t.title !== 'string' || !t.title.trim())
      return { pass: false, score: 0, reason: `任务[${i}] 缺 title` };
    if (t.acceptance && t.description && t.acceptance === t.description)
      return { pass: false, score: 0, reason: `任务[${i}] acceptance===description（L2 硬伤）` };
  }
  return { pass: true, score: 1, reason: `ok（${a.length} 任务）` };
}

// T13 gap：covered/missing 为数组，riskLevel/source 在合法枚举内
export function gapValid(output) {
  const o = parse(output);
  if (!o) return { pass: false, score: 0, reason: 'output 非合法 JSON' };
  if (o.skipped) return { pass: true, score: 1, reason: `skipped（${o.reason || ''}）— 合法跳过` };
  if (!Array.isArray(o.covered) || !Array.isArray(o.missing))
    return { pass: false, score: 0, reason: '缺 covered/missing 数组' };
  if (!['low', 'medium', 'high', 'unknown'].includes(o.riskLevel))
    return { pass: false, score: 0, reason: `riskLevel 非法: ${o.riskLevel}` };
  if (!['llm', 'fallback'].includes(o.source))
    return { pass: false, score: 0, reason: `source 非法: ${o.source}` };
  return { pass: true, score: 1, reason: `ok（risk=${o.riskLevel}, missing=${o.missing.length}, src=${o.source}）` };
}
