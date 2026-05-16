import { isProjectFounder, verifySessionToken } from '../services/auth.js';

function getProjectRepo(project) {
  if (project.githubFullRepo?.includes('/')) {
    const [owner, repo] = project.githubFullRepo.split('/');
    return { owner, repo };
  }
  return { owner: project.githubOwner || '', repo: project.repository || '' };
}

function isPlaceholderAcceptance(value) {
  return !String(value || '').trim() || /待补充|未定|todo/i.test(String(value || ''));
}

function mergeStageChecklist(draft, parsedPhasesResult, defaultStageChecklist, reassignChecklistPhaseIds) {
  if (!parsedPhasesResult?.phases?.length) return;

  const { phases: newPhases, nodes: newNodes, nodeAssignments } = parsedPhasesResult;
  draft.currentStage = { ...(draft.currentStage || {}), phases: newPhases };
  if (!(newNodes || []).length) return;

  const currentChecklist = draft.currentStage.checklist?.length
    ? draft.currentStage.checklist : defaultStageChecklist;
  const oldById = new Map(currentChecklist.map((node) => [node.id, node]));
  const newNodeSet = new Set(newNodes.map((node) => node.id));
  const mergedNodes = [
    ...newNodes.map((node) => {
      const old = oldById.get(node.id);
      return old
        ? {
            ...old,
            title: node.title || old.title,
            acceptance: node.acceptance || old.acceptance,
            phaseId: node.phaseId || old.phaseId
          }
        : node;
    }),
    ...currentChecklist.filter((node) => !newNodeSet.has(node.id) && (node.taskIds?.length > 0))
  ];
  draft.currentStage.checklist = reassignChecklistPhaseIds(mergedNodes, newPhases, nodeAssignments || {});
}

export function createProjectRoutes({
  createId,
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  hasGitHubConfig,
  scanGitHubProject,
  scanLocalGitProject,
  syncGitHubProjectIntoStore,
  githubSyncErrorHint,
  reviewChange,
  scanRisks,
  buildMetrics,
  buildHybridAnalysis,
  fetchProjectDocs,
  parseDocsForTasks,
  parseProgressDoc,
  parsePhasesFromDocs,
  selectDailyDocTasks,
  buildProgressMarkdown,
  writeProgressToGitHub,
  defaultStageChecklist,
  reassignChecklistPhaseIds,
  todayText
}) {
  function slugId(prefix, value) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^\w\u3400-\u9fff]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    return `${prefix}_${normalized || createId('node').replace(/^node_/, '')}`;
  }

  function normalizeTitle(value) {
    return String(value || '').replace(/\s+/g, '').replace(/[【】()[\]（）]/g, '').toLowerCase();
  }

  // 判断两个 normTitle 是否"近似重复"：一个包含另一个，且长度差 ≤ 8
  function isFuzzyDuplicateTitle(a, b) {
    if (!a || !b) return false;
    const diff = Math.abs(a.length - b.length);
    if (diff > 8) return false;
    return a.includes(b) || b.includes(a);
  }

  // 项目无关的常见缩写，不能作为"产品域识别符"（每个项目都可能出现，没有区分度）
  const COMMON_ABBREVS = new Set([
    'api', 'sdk', 'sop', 'sos', 'mvp', 'sku', 'oauth', 'jwt', 'http', 'https',
    'json', 'yaml', 'crud', 'cors', 'rest', 'cli', 'gui', 'ux', 'ui',
    'ci', 'cd', 'dev', 'prod', 'qa', 'env', 'v1', 'v2', 'mr', 'pr', 'pm'
  ]);

  // 提取"产品域识别符"：长度 ≥ 4 且不在常见缩写表里的纯 ASCII token
  // 用途：判断两个标题是否属于不同产品端（iPhone vs iPad 之类）
  // 项目无关：完全靠字符特征识别，不写死任何项目术语
  function extractDistinctiveTokens(text) {
    const ascii = String(text || '').toLowerCase().match(/[a-z][a-z0-9]+/g) || [];
    return ascii.filter((t) => t.length >= 4 && !COMMON_ABBREVS.has(t));
  }

  // task 标题 与 deliverable 标题 是否在产品域上"不冲突"（基于 ASCII 标识符）
  function isTitleConsistent(taskTitle, deliverableTitle) {
    const taskTokens = extractDistinctiveTokens(taskTitle);
    const dlvTokens = extractDistinctiveTokens(deliverableTitle);
    if (!taskTokens.length || !dlvTokens.length) return true;
    const taskLower = String(taskTitle).toLowerCase();
    const dlvLower = String(deliverableTitle).toLowerCase();
    if (taskTokens.some((t) => dlvLower.includes(t))) return true;
    if (dlvTokens.some((t) => taskLower.includes(t))) return true;
    return false;
  }

  // 更强的可信度校验：ASCII 标识符 + phase productKeywords 双重检查
  // 用例：iPhone 任务被 LLM 错绑到纯中文标题的"第一周后端交付物"deliverable，
  //       isTitleConsistent 无法判定，但 phase productKeywords 能识别出 task 实际归属客户端 phase。
  function isBindingPlausible(taskTitle, deliverable, parsedPhasesResult) {
    // 1. ASCII 标识符冲突直接拒绝
    if (!isTitleConsistent(taskTitle, deliverable.title)) return false;
    // 2. 基于 LLM productKeywords 的 phase 级一致性
    if (!deliverable.phaseId || !parsedPhasesResult?.phases?.length) return true;
    const phases = parsedPhasesResult.phases;
    const taskBest = findPhaseByLLMKeywords(taskTitle, phases);
    if (!taskBest.phaseId || taskBest.score < 2) return true; // task 没强 phase 信号，不否决
    if (taskBest.phaseId === deliverable.phaseId) return true; // 一致
    // task 的最佳 phase 与 deliverable 实际 phase 不同——计算 deliverable phase 对该 task 的得分
    const deliverablePhase = phases.find((p) => p.id === deliverable.phaseId);
    let dlvPhaseScore = 0;
    if (deliverablePhase && Array.isArray(deliverablePhase.productKeywords)) {
      const tl = String(taskTitle).toLowerCase();
      const tt = extractTokens(taskTitle);
      for (const k of deliverablePhase.productKeywords) {
        const kl = String(k || '').toLowerCase().trim();
        if (!kl) continue;
        if (tl.includes(kl)) { dlvPhaseScore += 2; continue; }
        const kt = extractTokens(k);
        for (const t of kt) if (tt.has(t)) { dlvPhaseScore += 1; break; }
      }
    }
    // task 的最佳 phase 比 deliverable 的 phase 评分高 ≥ 2 → 视为错绑
    return taskBest.score - dlvPhaseScore < 2;
  }

  // Jaccard 相似度（基于 extractTokens 的 bigram + ASCII tokens）
  function jaccardSimilarity(a, b) {
    const ta = extractTokens(a);
    const tb = extractTokens(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union > 0 ? inter / union : 0;
  }

  function sharedPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  // 综合判定两个标题是否为重复任务（覆盖比 isFuzzyDuplicateTitle 更广）
  function isLikelyDuplicate(a, b) {
    if (!a || !b) return false;
    const normA = normalizeTitle(a);
    const normB = normalizeTitle(b);
    if (!normA || !normB) return false;
    if (normA === normB) return true;
    // 模糊包含（长度差 ≤ 8）
    if (Math.abs(normA.length - normB.length) <= 8 && (normA.includes(normB) || normB.includes(normA))) return true;
    // 前缀共享 ≥ 4 char + Jaccard ≥ 0.3：覆盖词序调换 / 同义变体
    if (sharedPrefixLen(normA, normB) >= 4 && jaccardSimilarity(a, b) >= 0.3) return true;
    return false;
  }

  // 提取中文 bigrams（2字窗口）+ ASCII tokens，用于更稳的关键词重叠匹配
  function extractTokens(text) {
    const tokens = new Set();
    const ascii = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    ascii.forEach((t) => tokens.add(t));
    const cjkRuns = String(text || '').match(/[一-鿿]+/g) || [];
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.add(run.slice(i, i + 2));
      }
      if (run.length === 1) tokens.add(run);
    }
    return tokens;
  }

  // 用 LLM 自己提取的 phase.productKeywords 匹配 deliverable
  // 完全项目无关：所有关键词都来自当前项目 LLM 解析出的 phase 数据，没有任何硬编码项目术语
  // 评分：deliverable 标题（或其 token）包含 phase 的关键词时 +1；选总分最高的 phase
  function findPhaseByLLMKeywords(deliverableTitle, phases) {
    if (!deliverableTitle || !phases.length) return { phaseId: null, score: 0 };
    const dlvLower = String(deliverableTitle).toLowerCase();
    const dlvTokens = extractTokens(deliverableTitle);
    let best = null;
    let bestScore = 0;
    for (const phase of phases) {
      const keywords = Array.isArray(phase.productKeywords) ? phase.productKeywords : [];
      if (!keywords.length) continue;
      let score = 0;
      for (const kw of keywords) {
        const kwLower = String(kw || '').toLowerCase().trim();
        if (!kwLower) continue;
        // 用子串匹配（ASCII 大小写无关）+ bigram 重叠双通道
        if (dlvLower.includes(kwLower)) { score += 2; continue; }
        const kwTokens = extractTokens(kw);
        for (const t of kwTokens) if (dlvTokens.has(t)) { score += 1; break; }
      }
      if (score > bestScore) { bestScore = score; best = phase.id; }
    }
    return { phaseId: best, score: bestScore };
  }

  // 从 parsedPhasesResult 中为一个 deliverableTitle 找最匹配的 phaseId
  // 项目无关的优先级：
  //   1. LLM deliverableAssignments（经一致性校验）
  //   2. 基于 LLM phase.productKeywords 的匹配（评分 ≥ 2）
  //   3. node 标题包含匹配
  //   4. bigram 字面重叠 fallback
  //   一致性校验：若 LLM 把 deliverable 分到一个 phase，但另一个 phase 的 productKeywords
  //   对该 deliverable 评分明显更高，视为 LLM 错位，回退到关键词最匹配的 phase
  function findPhaseForDeliverable(deliverableTitle, parsedPhasesResult) {
    if (!parsedPhasesResult || !deliverableTitle) return null;
    const { phases = [], nodes = [], deliverableAssignments = {} } = parsedPhasesResult;
    const phaseIdSet = new Set(phases.map((p) => p.id));

    // LLM 给出的 productKeywords 评分结果（同时作为 LLM 映射校验基准）
    const kw = findPhaseByLLMKeywords(deliverableTitle, phases);

    // 1. LLM deliverableAssignments
    const normDlv = normalizeTitle(deliverableTitle);
    let llmMap = deliverableAssignments[deliverableTitle];
    if (!llmMap || !phaseIdSet.has(llmMap)) {
      for (const [k, v] of Object.entries(deliverableAssignments)) {
        if (normalizeTitle(k) === normDlv && phaseIdSet.has(v)) { llmMap = v; break; }
      }
    }
    // 1c. 一致性校验：用 LLM 自己的 productKeywords 评估
    //     若关键词最匹配 phase 与 LLM 映射不同，且关键词得分明显高（≥ 2），用关键词结果
    //     这是项目无关的——所有信号都来自 LLM 自己的输出
    if (llmMap && kw.phaseId && llmMap !== kw.phaseId && kw.score >= 2) {
      const llmPhaseScore = (() => {
        const llmPhase = phases.find((p) => p.id === llmMap);
        if (!llmPhase || !Array.isArray(llmPhase.productKeywords)) return 0;
        const dlvLower = deliverableTitle.toLowerCase();
        const dlvTokens = extractTokens(deliverableTitle);
        let s = 0;
        for (const k of llmPhase.productKeywords) {
          const kl = String(k || '').toLowerCase().trim();
          if (!kl) continue;
          if (dlvLower.includes(kl)) { s += 2; continue; }
          const kt = extractTokens(k);
          for (const t of kt) if (dlvTokens.has(t)) { s += 1; break; }
        }
        return s;
      })();
      // 关键词匹配分至少比 LLM 映射高 2，才视为 LLM 错位
      if (kw.score - llmPhaseScore >= 2) return kw.phaseId;
    }
    if (llmMap && phaseIdSet.has(llmMap)) return llmMap;
    if (!normDlv) return null;

    // 2. LLM productKeywords 匹配（需要至少 score >= 2，避免噪声）
    if (kw.phaseId && kw.score >= 2) return kw.phaseId;

    // 3. node 标题包含匹配
    const nodeMatch = nodes.find((n) => {
      const normNode = normalizeTitle(n.title || '');
      return normNode === normDlv || normNode.includes(normDlv) || normDlv.includes(normNode);
    });
    if (nodeMatch?.phaseId && phaseIdSet.has(nodeMatch.phaseId)) return nodeMatch.phaseId;

    // 4. bigram 字面重叠 fallback（phase 标题对比）
    const dlvTokens = extractTokens(deliverableTitle);
    let bestPhaseId = null;
    let bestScore = 0;
    for (const phase of phases) {
      const phaseTokens = extractTokens(phase.title || '');
      let score = 0;
      for (const t of dlvTokens) if (phaseTokens.has(t)) score++;
      if (score > bestScore) { bestScore = score; bestPhaseId = phase.id; }
    }
    // 同 productKeywords 评分弱兜底，避免噪声匹配
    if (bestScore >= 1) return bestPhaseId;
    // 5. 最后兜底：返回 productKeywords 评分最高的（即使 < 2），让 LLM 也尽量给个 phase
    return kw.phaseId || null;
  }

  function normalizeProjectInput(input = {}, fallbackId = '') {
    const owner = String(input.githubOwner || '').trim();
    const repository = String(input.repository || '').trim();
    const explicitFullRepo = String(input.githubFullRepo || '').trim();
    const githubFullRepo = explicitFullRepo || (owner && repository ? `${owner}/${repository}` : '');
    const [repoOwner = owner, repoName = repository] = githubFullRepo.includes('/')
      ? githubFullRepo.split('/')
      : [owner, repository];
    const name = String(input.name || repoName || fallbackId || '').trim();
    const id = String(input.id || fallbackId || '').trim();
    return {
      id,
      name,
      githubOwner: repoOwner || owner,
      repository: repoName || repository,
      githubFullRepo,
      localPath: String(input.localPath || '').trim(),
      branch: String(input.branch || '').trim(),
      status: String(input.status || '待同步').trim(),
      lastSyncAt: input.lastSyncAt || '',
      summary: String(input.summary || '').trim()
    };
  }

  function countProjectLinks(store, projectId) {
    return {
      tasks: (store.tasks || []).filter((item) => item.projectId === projectId).length,
      activities: (store.activities || []).filter((item) => item.projectId === projectId).length,
      assignments: (store.assignments || []).filter((item) => item.projectId === projectId).length,
      reviews: (store.reviews || []).filter((item) => item.projectId === projectId).length,
      deliverables: (store.deliverables || []).filter((item) => item.projectId === projectId).length,
      phases: (store.phases || []).filter((item) => item.projectId === projectId).length
    };
  }

  function findDeliverableByTitle(deliverables = [], title = '') {
    const key = normalizeTitle(title);
    if (!key) return null;
    return deliverables.find((item) => {
      const candidate = normalizeTitle(item.title);
      return candidate === key || candidate.includes(key) || key.includes(candidate);
    }) || null;
  }

  function applyProgressDocSuggestions(draft, docs) {
    const progressDoc = (docs || []).find((doc) => String(doc.name || doc.path || '').includes('阶段进度追踪'));
    if (!progressDoc) return 0;
    const progressItems = parseProgressDoc(progressDoc.content || '');
    let suggested = 0;
    draft.deliverables = draft.deliverables || [];
    for (const item of progressItems) {
      if (item.docStatus !== '已完成') continue;
      const deliverable = findDeliverableByTitle(draft.deliverables, item.title);
      if (!deliverable || deliverable.status === '已完成' || deliverable.manualOverride?.status === '已完成') continue;
      deliverable.docSuggestComplete = true;
      deliverable.docStatus = item.docStatus;
      deliverable.docStatusUpdatedAt = new Date().toISOString();
      suggested++;
    }
    return suggested;
  }

  async function runProjectSync(project, scanOptions) {
    if (hasGitHubConfig(project)) {
      return scanGitHubProject(project, scanOptions);
    }
    if (project.localPath) {
      console.warn(`[Sync] 项目 ${project.id} 未配置 githubOwner，降级到本地 git（建议配置远端）`);
      return scanLocalGitProject(project, scanOptions);
    }
    throw new Error(`项目 "${project.name || project.id}" 既未配置 githubOwner，也没有 localPath，无法同步`);
  }

  async function importDocs(project, projectId, url) {
    const { owner, repo } = getProjectRepo(project);
    if (!owner || !repo) {
      throw new Error('项目未配置 githubFullRepo，请先 PATCH 设置');
    }

    const docs = await fetchProjectDocs(owner, repo);
    if (!docs.length) {
      return { imported: 0, message: 'docs/ 目录无计划文档' };
    }

    const parsedTasks = await parseDocsForTasks(docs);
    if (!parsedTasks.length) {
      return { imported: 0, message: 'LLM 未解析出任务（无 API key 或文档无可执行任务）' };
    }

    const storeSnap = await loadStore();
    const planDocs = docs.filter((doc) => !String(doc.name || doc.path || '').includes('阶段进度追踪'));
    const existingNodes = (storeSnap.currentStage?.checklist?.length
      ? storeSnap.currentStage.checklist : defaultStageChecklist
    ).map((node) => ({ id: node.id, title: node.title, phaseId: node.phaseId }));
    const parsedPhasesResult = await parsePhasesFromDocs(planDocs, parsedTasks, existingNodes);
    const importLimit = Number(url.searchParams.get('limit') || process.env.DOC_TASK_IMPORT_LIMIT || 8);
    // 注入系统现有数据：已完成任务过滤、commit 覆盖降权、晚会 nextTargets 提权
    const selectionContext = {
      hubTasks: (storeSnap.tasks || []).filter((t) => !t.projectId || t.projectId === projectId),
      semanticLinks: storeSnap.semanticLinks || {},
      eveningReports: storeSnap.eveningReports || {}
    };
    const dailyCandidates = selectDailyDocTasks(parsedTasks, importLimit, selectionContext);
    // 保证每个 unique deliverableTitle 至少有一个代表任务入候选（让路径图 phase 都有内容，不留空 phase）
    const coveredDeliverables = new Set(dailyCandidates.map((t) => t.deliverableTitle).filter(Boolean));
    const representatives = [];
    for (const parsed of parsedTasks) {
      const dlv = parsed.deliverableTitle;
      if (!dlv || coveredDeliverables.has(dlv)) continue;
      if (parsed.status === 'completed') continue;
      coveredDeliverables.add(dlv);
      representatives.push(parsed);
    }
    const importCandidates = [...dailyCandidates, ...representatives];

    let imported = 0;
    let createdDeliverables = 0;
    let docSuggestions = 0;
    const nextStore = await updateStore((draft) => {
      let existing = draft.tasks || [];
      draft.deliverables = draft.deliverables || [];
      // 找一个与 task 标题产品域一致的 deliverable（用于校验 LLM 给的 deliverableTitle）
      function findConsistentDeliverableForTask(taskTitle) {
        if (!taskTitle) return null;
        return (draft.deliverables || []).find((d) => (
          (!d.projectId || d.projectId === projectId)
          && isTitleConsistent(taskTitle, d.title)
          && extractDistinctiveTokens(taskTitle).some((t) => String(d.title).toLowerCase().includes(t))
        )) || null;
      }

      for (const task of importCandidates) {
        let deliverable = findDeliverableByTitle(draft.deliverables, task.deliverableTitle || task.title);
        // 可信度校验：LLM 给的 deliverable 是否合理（ASCII 标识符 + phase productKeywords）
        if (deliverable && !isBindingPlausible(task.title, deliverable, parsedPhasesResult)) {
          const better = findConsistentDeliverableForTask(task.title);
          deliverable = better; // 没找到就 null（任务暂留为孤儿，下次重绑）
        }
        if (deliverable && !deliverable.phaseId) {
          // 已有 deliverable 但 phaseId 为空，尝试补填
          const resolvedPhaseId = findPhaseForDeliverable(deliverable.title, parsedPhasesResult);
          if (resolvedPhaseId) {
            deliverable.phaseId = resolvedPhaseId;
            deliverable.updatedAt = new Date().toISOString();
          }
        }
        if (!deliverable && (task.deliverableTitle || task.title)) {
          deliverable = {
            id: slugId('deliverable', task.deliverableTitle || task.title),
            projectId,
            phaseId: findPhaseForDeliverable(task.deliverableTitle || task.title, parsedPhasesResult),
            title: task.deliverableTitle || task.title,
            owner: task.owner || '',
            acceptance: task.description || '',
            keywords: [task.title, task.deliverableTitle, task.sourceDoc].filter(Boolean),
            status: task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '推进中' : '待补证据',
            progress: task.status === 'completed' ? 100 : 0,  // 进度由子任务聚合，不在此硬编码
            sourceDocPath: task.sourceDoc || '',
            docSuggestComplete: false,
            manualOverride: null,
            taskIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          draft.deliverables.push(deliverable);
          createdDeliverables++;
        }
        // 用 isLikelyDuplicate（精确 + 模糊包含 + Jaccard）去重，防止变体堆积
        const duplicate = existing.find(
          (item) => {
            const sameDoc = !item.sourceDoc || !task.sourceDoc || item.sourceDoc === task.sourceDoc;
            return sameDoc && isLikelyDuplicate(item.title, task.title);
          }
        );
        // 兜底：docs 来的任务必须有 deliverableId，不允许孤儿状态
        if (!deliverable && task.sourceDoc) {
          const fallbackTitle = task.deliverableTitle || task.title;
          deliverable = {
            id: slugId('deliverable', fallbackTitle),
            projectId,
            phaseId: findPhaseForDeliverable(fallbackTitle, parsedPhasesResult),
            title: fallbackTitle,
            owner: task.owner || '',
            acceptance: task.acceptance || task.description || '',
            keywords: [task.title, task.deliverableTitle, task.sourceDoc].filter(Boolean),
            status: task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '推进中' : '待补证据',
            progress: 0,
            sourceDocPath: task.sourceDoc || '',
            docSuggestComplete: false,
            manualOverride: null,
            taskIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          draft.deliverables.push(deliverable);
          createdDeliverables++;
        }

        if (!duplicate) {
          const taskId = createId('task');
          existing.unshift({
            id: taskId,
            title: task.title,
            // task.owner 永远是 '待认领'：LLM 建议的负责人只是建议，
            // task.owner 应该只反映"实际领取"状态。LLM 的建议保留在 suggestedOwner，前端可选展示
            owner: '待认领',
            suggestedOwner: task.owner || '',
            priority: task.priority || 'P1',
            status: task.status || 'pending',
            description: task.description || '',
            dueDate: task.dueDate || '',
            sourceDoc: task.sourceDoc || '',
            projectId,
            deliverableId: deliverable?.id || null,
            acceptance: task.acceptance || deliverable?.acceptance || task.description || '',
            createdAt: new Date().toISOString()
          });
          if (deliverable && !deliverable.taskIds?.includes(taskId)) {
            deliverable.taskIds = [...(deliverable.taskIds || []), taskId];
          }
          imported++;
        } else {
          // 重复任务：必须通过可信度校验才允许补绑，避免 fuzzy 匹配误绑手动创建的任务
          if (deliverable && isBindingPlausible(duplicate.title, deliverable, parsedPhasesResult)) {
            if (!duplicate.deliverableId) {
              duplicate.deliverableId = deliverable.id;
            }
            if (isPlaceholderAcceptance(duplicate.acceptance)) {
              duplicate.acceptance = task.acceptance || deliverable.acceptance || task.description || duplicate.acceptance || '';
            }
            if (!deliverable.taskIds?.includes(duplicate.id)) {
              deliverable.taskIds = [...(deliverable.taskIds || []), duplicate.id];
            }
          }
        }
      } // end for (const task of importCandidates)
      // 第二遍：只把存量任务重绑到第一遍已经创建的 deliverable，不创建新的
      // 防止幽灵 deliverable（LLM 解析出 40 个任务但只导入 8 个时，剩下 32 个会创建空 deliverable 污染路径图）
      let rebound = 0;
      for (const parsed of parsedTasks) {
        const targetDlvTitle = parsed.deliverableTitle || parsed.title;
        if (!targetDlvTitle) continue;
        const deliverable = findDeliverableByTitle(draft.deliverables, targetDlvTitle);
        if (!deliverable) continue; // 不创建幽灵
        // 补填 phaseId（已有 deliverable 但缺 phase）
        if (!deliverable.phaseId) {
          const resolved = findPhaseForDeliverable(deliverable.title, parsedPhasesResult);
          if (resolved) {
            deliverable.phaseId = resolved;
            deliverable.updatedAt = new Date().toISOString();
          }
        }
        // 用 isLikelyDuplicate 找现有匹配任务，加上可信度校验后再统一绑定
        for (const task of existing) {
          if (task.projectId && task.projectId !== projectId) continue;
          if (!isLikelyDuplicate(task.title, parsed.title)) continue;
          if (!isBindingPlausible(task.title, deliverable, parsedPhasesResult)) continue;
          if (task.deliverableId !== deliverable.id) {
            task.deliverableId = deliverable.id;
            rebound++;
          }
          if (!deliverable.taskIds?.includes(task.id)) {
            deliverable.taskIds = [...(deliverable.taskIds || []), task.id];
          }
        }
      }
      // 第三遍：deliverable 级模糊去重——若两个 deliverable normTitle 互相包含且长度差 ≤ 8，合并
      // 保留 taskIds 多的，合并对方的 taskIds 和被绑的 task.deliverableId
      const dedupedDeliverables = [];
      const mergedMap = new Map(); // oldId → newId
      for (const dlv of draft.deliverables) {
        if (dlv.projectId && dlv.projectId !== projectId) {
          dedupedDeliverables.push(dlv);
          continue;
        }
        const dlvNorm = normalizeTitle(dlv.title);
        const peer = dedupedDeliverables.find((existing) =>
          existing.projectId === projectId
          && (normalizeTitle(existing.title) === dlvNorm
            || isFuzzyDuplicateTitle(normalizeTitle(existing.title), dlvNorm))
        );
        if (peer) {
          // 合并到 peer：选 taskIds 多的为主，少的为附
          const peerCount = (peer.taskIds || []).length;
          const dlvCount = (dlv.taskIds || []).length;
          const winner = peerCount >= dlvCount ? peer : dlv;
          const loser = peerCount >= dlvCount ? dlv : peer;
          winner.taskIds = Array.from(new Set([...(winner.taskIds || []), ...(loser.taskIds || [])]));
          winner.keywords = Array.from(new Set([...(winner.keywords || []), ...(loser.keywords || [])]));
          if (!winner.phaseId && loser.phaseId) winner.phaseId = loser.phaseId;
          mergedMap.set(loser.id, winner.id);
          if (winner === dlv) {
            // 替换 dedupedDeliverables 中的 peer 为 dlv
            const idx = dedupedDeliverables.indexOf(peer);
            dedupedDeliverables[idx] = dlv;
          }
        } else {
          dedupedDeliverables.push(dlv);
        }
      }
      draft.deliverables = dedupedDeliverables;
      // 重映射 tasks/activities/assignments 上被合并掉的 deliverableId
      if (mergedMap.size > 0) {
        draft.tasks = (draft.tasks || []).map((task) => (
          task.deliverableId && mergedMap.has(task.deliverableId)
            ? { ...task, deliverableId: mergedMap.get(task.deliverableId) }
            : task
        ));
        existing = draft.tasks;
        draft.activities = (draft.activities || []).map((activity) => (
          activity.deliverableId && mergedMap.has(activity.deliverableId)
            ? { ...activity, deliverableId: mergedMap.get(activity.deliverableId) }
            : activity
        ));
        draft.assignments = (draft.assignments || []).map((assignment) => (
          assignment.deliverableId && mergedMap.has(assignment.deliverableId)
            ? { ...assignment, deliverableId: mergedMap.get(assignment.deliverableId) }
            : assignment
        ));
      }
      draft._syncDocsLog = { rebound, mergedDeliverables: mergedMap.size };
      draft.tasks = existing;
      if (!draft.docTasks) draft.docTasks = {};
      draft.docTasks[projectId] = parsedTasks;
      mergeStageChecklist(draft, parsedPhasesResult, defaultStageChecklist, reassignChecklistPhaseIds);
      docSuggestions = applyProgressDocSuggestions(draft, docs);
      return draft;
    });

    return {
      imported,
      selected: importCandidates.length,
      totalCandidates: parsedTasks.length,
      importLimit: Math.min(Math.max(Number.isFinite(importLimit) ? Math.floor(importLimit) : 8, 1), 20),
      message: `已从 ${parsedTasks.length} 个候选任务中选择 ${importCandidates.length} 个适合近期领取的任务导入。`,
      importedTasks: nextStore.tasks.filter((task) => (
        task.projectId === projectId && importCandidates.some((candidate) =>
          candidate.title === task.title && candidate.sourceDoc === task.sourceDoc
        )
      )),
      candidates: parsedTasks,
      phases: parsedPhasesResult?.phases?.length || 0,
      createdDeliverables,
      docSuggestComplete: docSuggestions
    };
  }

  return async function projectRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const store = await loadStore();
      sendJson(res, 200, { projects: store.projects || [] });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const { json } = await readBody(req);
      if (!json) { sendError(res, 400, 'invalid json'); return true; }
      const id = String(json.id || slugId('project', json.githubFullRepo || json.repository || json.name)).trim();
      const project = normalizeProjectInput(json, id);
      if (!project.name) { sendError(res, 400, 'project name required'); return true; }
      const store = await loadStore();
      if ((store.projects || []).some((item) => item.id === project.id)) {
        sendError(res, 409, 'project id already exists');
        return true;
      }
      // 把当前调用者（session 中的 user）设为创始人，自动赋项目管理员角色
      const callerSession = (() => {
        const headers = req.headers || {};
        const header = headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (headers['x-cue-session-token'] || '');
        return verifySessionToken(token);
      })();
      const callerUser = callerSession
        ? (store.users || []).find((u) => u.id === callerSession.sub && u.active !== false)
        : null;
      const nextStore = await updateStore((draft) => {
        draft.projects = draft.projects || [];
        draft.projects.push({
          ...project,
          founderId: callerUser?.id || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        // 创始人自动获得本项目的 project_admin 角色
        if (callerUser) {
          const idx = (draft.users || []).findIndex((u) => u.id === callerUser.id);
          if (idx !== -1) {
            const u = draft.users[idx];
            const roles = u.projectRoles && typeof u.projectRoles === 'object' ? u.projectRoles : {};
            draft.users[idx] = {
              ...u,
              projectIds: Array.from(new Set([...(u.projectIds || []), project.id])),
              projectRoles: { ...roles, [project.id]: 'project_admin' },
              updatedAt: new Date().toISOString()
            };
          }
        }
        return draft;
      });
      const saved = (nextStore.projects || []).find((item) => item.id === project.id);
      if (!saved) { sendError(res, 409, 'project id already exists'); return true; }
      sendJson(res, 201, { project: saved });
      return true;
    }

    // 转移项目创始人：只有当前创始人本人能调用
    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/transfer-founder')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const { json } = await readBody(req);
      const targetUsername = String(json?.targetUsername || '').trim();
      if (!targetUsername) { sendError(res, 400, 'targetUsername required'); return true; }
      const before = await loadStore();
      const project = (before.projects || []).find((p) => p.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      const callerSession = (() => {
        const headers = req.headers || {};
        const header = headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (headers['x-cue-session-token'] || '');
        return verifySessionToken(token);
      })();
      const callerUser = callerSession
        ? (before.users || []).find((u) => u.id === callerSession.sub && u.active !== false)
        : null;
      if (!callerUser || !isProjectFounder(callerUser, project)) {
        sendError(res, 403, 'only the current founder can transfer ownership');
        return true;
      }
      const target = (before.users || []).find((u) =>
        u.username === targetUsername && u.active !== false && u.id !== callerUser.id
      );
      if (!target) { sendError(res, 404, 'target user not found or is current founder'); return true; }
      const now = new Date().toISOString();
      await updateStore((draft) => {
        const pIdx = (draft.projects || []).findIndex((p) => p.id === projectId);
        if (pIdx !== -1) draft.projects[pIdx] = { ...draft.projects[pIdx], founderId: target.id, updatedAt: now };
        // 新创始人 → project_admin
        const tIdx = (draft.users || []).findIndex((u) => u.id === target.id);
        if (tIdx !== -1) {
          const u = draft.users[tIdx];
          const roles = u.projectRoles && typeof u.projectRoles === 'object' ? u.projectRoles : {};
          draft.users[tIdx] = {
            ...u,
            projectIds: Array.from(new Set([...(u.projectIds || []), projectId])),
            projectRoles: { ...roles, [projectId]: 'project_admin' },
            updatedAt: now
          };
        }
        // 老创始人保留 project_admin 角色（不强降，留个管理权）
        return draft;
      });
      sendJson(res, 200, { ok: true, projectId, newFounderId: target.id, newFounderUsername: target.username });
      return true;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/projects/') &&
        !url.pathname.includes('/sync')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const { json } = await readBody(req);
      if (!json) { sendError(res, 400, 'invalid json'); return true; }
      const nextStore = await updateStore((draft) => {
        const index = (draft.projects || []).findIndex((project) => project.id === projectId);
        if (index === -1) return draft;
        const allowed = ['name', 'repository', 'githubOwner', 'githubFullRepo', 'localPath', 'summary', 'branch', 'status'];
        const patch = Object.fromEntries(Object.entries(json).filter(([key]) => allowed.includes(key)));
        const normalizedPatch = normalizeProjectInput({ ...draft.projects[index], ...patch }, projectId);
        const current = draft.projects[index];
        const repoChanged = ['repository', 'githubOwner', 'githubFullRepo', 'localPath']
          .some((key) => Object.hasOwn(patch, key) && normalizedPatch[key] !== current[key]);
        const shouldResetSync = repoChanged || json.resetSync === true;
        draft.projects[index] = {
          ...current,
          ...normalizedPatch,
          id: current.id,
          ...(shouldResetSync
            ? {
                branch: '',
                status: '待同步',
                lastSyncAt: '',
                commitCount: 0,
                dirtyFileCount: 0
              }
            : {}),
          updatedAt: new Date().toISOString()
        };
        return draft;
      });
      const project = (nextStore.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      sendJson(res, 200, { project });
      return true;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore();
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      if (projectId === 'cue_ai_classroom' || (store.projects || []).length <= 1) {
        sendError(res, 409, 'default project cannot be deleted');
        return true;
      }
      const links = countProjectLinks(store, projectId);
      const linkedCount = Object.values(links).reduce((sum, count) => sum + count, 0);
      if (linkedCount > 0) {
        sendError(res, 409, 'project has linked records', {
          message: '为避免误删真实研发数据，请先清理或迁移该项目下的任务、提交、分工和审阅记录。',
          links
        });
        return true;
      }
      const nextStore = await updateStore((draft) => {
        draft.projects = (draft.projects || []).filter((item) => item.id !== projectId);
        return draft;
      });
      sendJson(res, 200, { deleted: true, projectId, projects: nextStore.projects || [] });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-github')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore();
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, 'project not found'); return true; }
      if (!hasGitHubConfig(project)) {
        sendError(res, 400, `项目未配置 githubOwner，请先 PATCH /api/projects/${projectId} 设置 githubOwner 和 repository`);
        return true;
      }

      try {
        const result = await syncGitHubProjectIntoStore(project, {
          since: url.searchParams.get('since') || '14 days ago',
          limit: Number(url.searchParams.get('limit') || 15)
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendError(res, 422, 'GitHub 同步失败', githubSyncErrorHint(project, err));
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-local-git')) {
      const projectId = decodeURIComponent(url.pathname.split('/')[3] || '');
      const store = await loadStore();
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) {
        sendError(res, 404, 'project not found');
        return true;
      }

      const scanOptions = {
        since: url.searchParams.get('since') || '14 days ago',
        limit: Number(url.searchParams.get('limit') || 12)
      };
      const scan = await runProjectSync(project, scanOptions);

      const commitReviews = await Promise.all(
        scan.activities
          .filter((activity) => activity.type === 'commit' && String(activity.title || '').trim().length > 0)
          .map(async (activity) => ({
            id: `review_${activity.sha}`,
            projectId: project.id,
            activityId: activity.id,
            ...await reviewChange({
              repo: project.repository,
              title: activity.title,
              owner: activity.owner,
              diff: activity.diff || activity.files.join('\n'),
              files: activity.files
            })
          }))
      );
      const lightweightActivities = scan.activities.map(({ diff, ...activity }) => activity);
      let addedActivityCount = 0;
      let addedReviewCount = 0;

      const nextStore = await updateStore((draft) => {
        draft.projects = (draft.projects || []).map((item) => (
          item.id === project.id
            ? {
                ...item,
                branch: scan.branch,
                status: scan.dirtyFileCount ? '有未提交改动' : '已同步',
                lastSyncAt: new Date().toISOString(),
                commitCount: scan.commitCount,
                dirtyFileCount: scan.dirtyFileCount
              }
            : item
        ));

        const existingActivityIds = new Set((draft.activities || []).map((activity) => activity.id));
        const existingReviewIds = new Set((draft.reviews || []).map((review) => review.id));
        const retainedActivities = (draft.activities || []).filter((activity) => (
          activity.projectId !== project.id || activity.type !== 'working_tree'
        ));
        const newActivities = lightweightActivities.filter((activity) => (
          activity.type === 'working_tree' || !existingActivityIds.has(activity.id)
        ));
        const newReviews = commitReviews.filter((review) => !existingReviewIds.has(review.id));
        addedActivityCount = newActivities.length;
        addedReviewCount = newReviews.length;

        draft.activities = [...newActivities, ...retainedActivities].slice(0, 700);
        draft.reviews = [...newReviews, ...(draft.reviews || [])].slice(0, 300);
        return draft;
      });

      const alerts = scanRisks(nextStore);
      sendJson(res, 200, {
        project: nextStore.projects.find((item) => item.id === project.id),
        addedActivities: addedActivityCount,
        addedReviews: addedReviewCount,
        activities: lightweightActivities,
        reviews: commitReviews,
        metrics: buildMetrics(nextStore, alerts),
        alerts
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/sync-docs')) {
      const projectId = url.pathname.split('/')[3];
      const store = await loadStore();
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, '项目不存在'); return true; }

      try {
        const result = await importDocs(project, projectId, url);
        sendJson(res, 200, result);
      } catch (err) {
        if (err.message.includes('githubFullRepo')) {
          sendError(res, 400, err.message);
        } else {
          sendError(res, 500, 'internal server error', err.message);
        }
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/update-docs')) {
      const projectId = url.pathname.split('/')[3];
      const store = await loadStore();
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, '项目不存在'); return true; }

      const { owner, repo } = getProjectRepo(project);
      if (!owner || !repo) { sendError(res, 400, '项目未配置 githubFullRepo'); return true; }

      const docTasks = (store.docTasks || {})[projectId] || [];
      const hubTasks = (store.tasks || []).filter((task) => task.projectId === projectId);
      const deliverables = (store.deliverables || []).filter((item) => item.projectId === projectId);
      const today = todayText();
      const todayAssignments = (store.assignments || []).filter((assignment) =>
        assignment.date === today && assignment.projectId === projectId
      );

      // 风险映射 + commit 覆盖 + 晚会对账（与 daily-scan 复用相同逻辑）
      const rawAlerts = scanRisks(store);
      const analysisById = Object.fromEntries(
        (store.riskAnalyses || []).map((a) => [a.alertId, a])
      );
      const riskByTaskId = {};
      for (const alert of rawAlerts) {
        if (!alert.source) continue;
        const analysis = analysisById[alert.id];
        const severity = analysis?.severity || alert.severity;
        const current = riskByTaskId[alert.source];
        if (!current || severity < current.severity) {
          riskByTaskId[alert.source] = { severity, reason: analysis?.reason || alert.detail };
        }
      }
      const progressContext = {
        riskByTaskId,
        commitTaskLinks: store.semanticLinks?.commitTaskLinks || [],
        eveningReports: store.eveningReports || {}
      };
      const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today, deliverables, progressContext);
      await writeProgressToGitHub(owner, repo, markdown);

      sendJson(res, 200, { written: true, path: 'docs/阶段进度追踪.md', date: today });
      return true;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/daily-scan')) {
      const projectId = url.pathname.split('/')[3];
      const store = await loadStore();
      const project = (store.projects || []).find((item) => item.id === projectId);
      if (!project) { sendError(res, 404, '项目不存在'); return true; }

      const result = { projectId, steps: {} };

      try {
        const { owner, repo } = getProjectRepo(project);
        if (owner && repo) {
          const syncResult = await scanGitHubProject(project, { maxCommits: 30 });
          if (syncResult) {
            await updateStore((draft) => {
              const newActivities = syncResult.activities || [];
              const retained = (draft.activities || []).filter((activity) =>
                !newActivities.find((nextActivity) => nextActivity.id === activity.id)
              );
              draft.activities = [...newActivities, ...retained].slice(0, 700);
              return draft;
            });
            result.steps.syncCommits = { ok: true, added: syncResult.activities?.length || 0 };
          }
        }
      } catch (err) {
        result.steps.syncCommits = { ok: false, error: err.message };
      }

      // Step 1.5：语义分析 + 风险分析，让后续 importDocs/buildProgressMarkdown 用最新数据
      try {
        const storeForAnalysis = await loadStore();
        const freshAnalysis = await buildHybridAnalysis(storeForAnalysis);
        if (freshAnalysis) {
          await updateStore((draft) => {
            draft.semanticLinks = freshAnalysis.semanticLinks || draft.semanticLinks || {};
            draft.riskAnalyses = freshAnalysis.riskAnalyses || draft.riskAnalyses || [];
            draft.healthAnalysis = freshAnalysis.healthAnalysis || draft.healthAnalysis || null;
            draft.aiAnalysisUpdatedAt = freshAnalysis.generatedAt;
            return draft;
          });
          result.steps.refreshAnalysis = { ok: true, llmEnabled: freshAnalysis.llmEnabled };
        }
      } catch (err) {
        result.steps.refreshAnalysis = { ok: false, error: err.message };
        // 非致命：继续用缓存的 semanticLinks
      }

      try {
        const docsResult = await importDocs(project, projectId, url);
        result.steps.syncDocs = {
          ok: true,
          imported: docsResult.imported,
          selected: docsResult.selected || 0,
          totalCandidates: docsResult.totalCandidates || 0,
          phases: docsResult.phases || 0,
          createdDeliverables: docsResult.createdDeliverables || 0,
          docSuggestComplete: docsResult.docSuggestComplete || 0
        };
      } catch (err) {
        result.steps.syncDocs = { ok: false, error: err.message };
      }

      try {
        const freshStore = await loadStore();
        const { owner, repo } = getProjectRepo(project);
        const docTasks = (freshStore.docTasks || {})[projectId] || [];
        const hubTasks = (freshStore.tasks || []).filter((task) => task.projectId === projectId);
        const deliverables = (freshStore.deliverables || []).filter((item) => item.projectId === projectId);
        const today = todayText();
        const todayAssignments = (freshStore.assignments || []).filter((assignment) =>
          assignment.date === today && assignment.projectId === projectId
        );
        // 构建进度文档上下文：风险映射 + commit 覆盖 + 晚会对账
        const rawAlerts = scanRisks(freshStore);
        const analysisById = Object.fromEntries(
          (freshStore.riskAnalyses || []).map((a) => [a.alertId, a])
        );
        const riskByTaskId = {};
        for (const alert of rawAlerts) {
          if (!alert.source) continue;
          const analysis = analysisById[alert.id];
          const severity = analysis?.severity || alert.severity;
          const current = riskByTaskId[alert.source];
          if (!current || severity < current.severity) {
            riskByTaskId[alert.source] = { severity, reason: analysis?.reason || alert.detail };
          }
        }
        const progressContext = {
          riskByTaskId,
          commitTaskLinks: freshStore.semanticLinks?.commitTaskLinks || [],
          eveningReports: freshStore.eveningReports || {}
        };
        const markdown = buildProgressMarkdown(project, docTasks, hubTasks, todayAssignments, today, deliverables, progressContext);
        await writeProgressToGitHub(owner, repo, markdown);
        result.steps.updateDocs = { ok: true };
      } catch (err) {
        result.steps.updateDocs = { ok: false, error: err.message };
      }

      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
