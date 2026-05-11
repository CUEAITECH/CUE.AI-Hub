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

function classifyDeliverableProduct(title) {
  const t = String(title || '').toLowerCase();
  const hasTrtc = /trtc/i.test(t);
  if (/(联调|三端|全链路|demo\s*验收|端到端|e2e)/i.test(title)) return { tokens: ['联调', '三端', '全链路', 'e2e', '集成'], prefer: null };
  if (/trtc.*(后端|asr|usersig|callback|session)/i.test(t)) return { tokens: ['后端', '服务', 'backend'], prefer: 'trtc' };
  if (/ipad|iphone|ios/i.test(t)) return { tokens: ['客户端', 'ios', 'iphone', 'ipad', '端侧', '移动端'], prefer: hasTrtc ? 'trtc' : 'week1' };
  if (/(学生|web)/i.test(t)) return { tokens: ['学生', 'web', '客户端', '端侧'], prefer: hasTrtc ? 'trtc' : 'week1' };
  if (/(后端|服务端|api|session)/i.test(t)) return { tokens: ['后端', '服务', 'api', 'session', 'backend'], prefer: hasTrtc ? 'trtc' : 'week1' };
  if (/(ci\/cd|railway|部署|deploy|流水线|env|环境)/i.test(t)) return { tokens: ['集成', '部署', '环境', 'ci', '联调'], prefer: null };
  if (/(sop|内容|话术|模板|课程包)/i.test(t)) return { tokens: ['内容', 'sop', '课程', '联调'], prefer: null };
  return { tokens: [], prefer: null };
}

function findPhaseByProductKeywords(title, phases) {
  const cls = classifyDeliverableProduct(title);
  if (!cls.tokens.length || !phases.length) return null;
  let best = null; let bestScore = -1;
  for (const phase of phases) {
    const pTitle = String(phase.title || '').toLowerCase();
    let s = 0;
    for (const kw of cls.tokens) if (pTitle.includes(kw.toLowerCase())) s++;
    if (cls.prefer === 'trtc' && /trtc/i.test(pTitle)) s += 10;
    else if (cls.prefer === 'trtc' && !/trtc/i.test(pTitle)) s -= 5;
    if (cls.prefer === 'week1' && /(第一周|week ?1|首周)/i.test(pTitle)) s += 10;
    else if (cls.prefer === 'week1' && /trtc/i.test(pTitle)) s -= 5;
    if (s > bestScore) { bestScore = s; best = phase.id; }
  }
  return bestScore >= 1 ? best : null;
}

function findPhaseForDeliverable(deliverableTitle, parsedPhasesResult) {
  if (!parsedPhasesResult || !deliverableTitle) return null;
  const { phases = [], nodes = [], deliverableAssignments = {} } = parsedPhasesResult;
  const phaseIdSet = new Set(phases.map((p) => p.id));

  const llmMap = deliverableAssignments[deliverableTitle];
  if (llmMap && phaseIdSet.has(llmMap)) return llmMap;
  const normDlv = normalizeTitle(deliverableTitle);
  for (const [k, v] of Object.entries(deliverableAssignments)) {
    if (normalizeTitle(k) === normDlv && phaseIdSet.has(v)) return v;
  }
  if (!normDlv) return null;

  const byProduct = findPhaseByProductKeywords(deliverableTitle, phases);
  if (byProduct) return byProduct;

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
  return bestScore >= 1 ? bestPhaseId : null;
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
  (phasesResult.phases || []).forEach((p) => console.log(`  ${p.id}: "${p.title}" (status=${p.status})`));
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
