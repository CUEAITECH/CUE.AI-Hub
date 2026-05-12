// 本地调试脚本：实际跑一遍 sync-docs 流程，记录每步输出
// 用法：API_KEY=xxx node scripts/debug-sync-docs.mjs
import { fetchProjectDocs, parseDocsForTasks, parsePhasesFromDocs } from '../server/services/docsManager.js';

const project = {
  id: 'cue_ai_classroom',
  name: 'Cue.AI',
  githubOwner: 'CUEAITECH',
  repository: 'Cue.AI',
  githubFullRepo: 'CUEAITECH/Cue.AI'
};

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[【】()[\]（）]/g, '').toLowerCase();
}

function isFuzzyDuplicateTitle(a, b) {
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > 8) return false;
  return a.includes(b) || b.includes(a);
}

function extractTokens(text) {
  const tokens = new Set();
  const ascii = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  ascii.forEach((t) => tokens.add(t));
  const cjkRuns = String(text || '').match(/[一-鿿]+/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
    if (run.length === 1) tokens.add(run);
  }
  return tokens;
}

function findPhaseByLLMKeywords(deliverableTitle, phases) {
  if (!deliverableTitle || !phases.length) return { phaseId: null, score: 0 };
  const dlvLower = String(deliverableTitle).toLowerCase();
  const dlvTokens = extractTokens(deliverableTitle);
  let best = null; let bestScore = 0;
  for (const phase of phases) {
    const keywords = Array.isArray(phase.productKeywords) ? phase.productKeywords : [];
    if (!keywords.length) continue;
    let score = 0;
    for (const kw of keywords) {
      const kwLower = String(kw || '').toLowerCase().trim();
      if (!kwLower) continue;
      if (dlvLower.includes(kwLower)) { score += 2; continue; }
      const kwTokens = extractTokens(kw);
      for (const t of kwTokens) if (dlvTokens.has(t)) { score += 1; break; }
    }
    if (score > bestScore) { bestScore = score; best = phase.id; }
  }
  return { phaseId: best, score: bestScore };
}

function findPhaseForDeliverable(deliverableTitle, parsedPhasesResult) {
  if (!parsedPhasesResult || !deliverableTitle) return null;
  const { phases = [], nodes = [], deliverableAssignments = {} } = parsedPhasesResult;
  const phaseIdSet = new Set(phases.map((p) => p.id));

  const kw = findPhaseByLLMKeywords(deliverableTitle, phases);

  const normDlv = normalizeTitle(deliverableTitle);
  let llmMap = deliverableAssignments[deliverableTitle];
  if (!llmMap || !phaseIdSet.has(llmMap)) {
    for (const [k, v] of Object.entries(deliverableAssignments)) {
      if (normalizeTitle(k) === normDlv && phaseIdSet.has(v)) { llmMap = v; break; }
    }
  }
  if (llmMap && kw.phaseId && llmMap !== kw.phaseId && kw.score >= 2) {
    const llmPhaseScore = (() => {
      const llmPhase = phases.find((p) => p.id === llmMap);
      if (!llmPhase || !Array.isArray(llmPhase.productKeywords)) return 0;
      const dl = deliverableTitle.toLowerCase();
      const dt = extractTokens(deliverableTitle);
      let s = 0;
      for (const k of llmPhase.productKeywords) {
        const kl = String(k || '').toLowerCase().trim();
        if (!kl) continue;
        if (dl.includes(kl)) { s += 2; continue; }
        const kt = extractTokens(k);
        for (const t of kt) if (dt.has(t)) { s += 1; break; }
      }
      return s;
    })();
    if (kw.score - llmPhaseScore >= 2) return kw.phaseId;
  }
  if (llmMap && phaseIdSet.has(llmMap)) return llmMap;
  if (!normDlv) return null;

  if (kw.phaseId && kw.score >= 2) return kw.phaseId;

  const nodeMatch = nodes.find((n) => {
    const normNode = normalizeTitle(n.title || '');
    return normNode === normDlv || normNode.includes(normDlv) || normDlv.includes(normNode);
  });
  if (nodeMatch?.phaseId && phaseIdSet.has(nodeMatch.phaseId)) return nodeMatch.phaseId;

  const dlvTokens = extractTokens(deliverableTitle);
  let bestPhaseId = null; let bestScore = 0;
  for (const phase of phases) {
    const phaseTokens = extractTokens(phase.title || '');
    let score = 0;
    for (const t of dlvTokens) if (phaseTokens.has(t)) score++;
    if (score > bestScore) { bestScore = score; bestPhaseId = phase.id; }
  }
  if (bestScore >= 1) return bestPhaseId;
  return kw.phaseId || null;
}

async function main() {
  console.log('=== STEP 1: fetch docs from GitHub ===');
  const docs = await fetchProjectDocs(project.githubOwner, project.repository);
  console.log(`fetched ${docs.length} docs:`);
  docs.forEach((d) => console.log(`  - ${d.name || d.path} (${(d.content || '').length} chars)`));

  console.log('\n=== STEP 2: parseDocsForTasks (LLM call) ===');
  const planDocs = docs.filter((d) => !String(d.name || d.path || '').includes('阶段进度追踪'));
  const parsedTasks = await parseDocsForTasks(planDocs);
  console.log(`got ${parsedTasks.length} parsed tasks`);

  // 唯一 deliverableTitle 统计
  const dlvCount = {};
  parsedTasks.forEach((t) => {
    const dlv = t.deliverableTitle || '<NULL>';
    dlvCount[dlv] = (dlvCount[dlv] || 0) + 1;
  });
  console.log('\nunique deliverableTitles:');
  Object.entries(dlvCount).forEach(([k, v]) => console.log(`  '${k}': ${v} tasks`));

  console.log('\nsample tasks (first 3):');
  parsedTasks.slice(0, 3).forEach((t) =>
    console.log(`  - title="${t.title}" owner="${t.owner}" deliverableTitle="${t.deliverableTitle}" priority=${t.priority}`)
  );

  console.log('\n=== STEP 3: parsePhasesFromDocs (LLM call) ===');
  const phasesResult = await parsePhasesFromDocs(planDocs, parsedTasks, []);
  if (!phasesResult) {
    console.log('LLM returned null!');
    return;
  }
  console.log(`got ${phasesResult.phases?.length || 0} phases, ${phasesResult.nodes?.length || 0} nodes`);
  console.log('\nphases:');
  (phasesResult.phases || []).forEach((p) => {
    console.log(`  ${p.id}: "${p.title}" (status=${p.status})`);
    console.log(`    productKeywords: [${(p.productKeywords || []).join(', ')}]`);
  });
  console.log('\nnodes:');
  (phasesResult.nodes || []).forEach((n) => console.log(`  [${n.phaseId}] "${n.title}" (id=${n.id})`));
  console.log('\nnodeAssignments:');
  console.log(' ', JSON.stringify(phasesResult.nodeAssignments || {}, null, 2));
  console.log('\ndeliverableAssignments (LLM 权威映射):');
  console.log(' ', JSON.stringify(phasesResult.deliverableAssignments || {}, null, 2));

  console.log('\n=== STEP 4: findPhaseForDeliverable for each unique deliverableTitle ===');
  const uniqueDlvs = Object.keys(dlvCount).filter((d) => d !== '<NULL>');
  for (const dlvTitle of uniqueDlvs) {
    const matched = findPhaseForDeliverable(dlvTitle, phasesResult);
    const phaseName = (phasesResult.phases || []).find((p) => p.id === matched)?.title || 'NULL';
    console.log(`  "${dlvTitle}" → phaseId="${matched}" ("${phaseName}")`);

    if (!matched) {
      // 详细调试为什么没匹配
      const normDlv = normalizeTitle(dlvTitle);
      const dlvWords = normDlv.match(/[一-鿿]{1,4}|[a-z0-9]+/g) || [];
      console.log(`    norm="${normDlv}" tokens=[${dlvWords.join(', ')}]`);
      (phasesResult.phases || []).forEach((p) => {
        const normPhase = normalizeTitle(p.title || '');
        const pwords = normPhase.match(/[一-鿿]{1,4}|[a-z0-9]+/g) || [];
        const overlap = dlvWords.filter((w) => pwords.some((pw) => pw.includes(w) || w.includes(pw)));
        console.log(`      vs "${p.title}" norm="${normPhase}" tokens=[${pwords.join(', ')}] overlap=[${overlap.join(',')}]`);
      });
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
