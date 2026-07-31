// eval/llm-regression/providers/cue-provider.mjs
//
// promptfoo 自定义 provider —— 不直接调 LLM，而是调 CUE **自己的服务函数**，
// 这样 golden eval 测的是真实出厂行为（prompt + 解析 + 降级整条链），而非裸 prompt。
//
// 由 promptfooconfig.yaml 的 `config.surface` 决定测哪个面：
//   clarify → prdClarifier.clarify(input)          (L1)
//   plan    → planner.generatePlan(goal)           (L2)
//   gap     → gapAnalyzer.analyzeGap(...)           (T13 / L4c)
//
// 除 LLM 本身外不打任何网络：gap 面通过注入 fetchPRDiff 喂固定 diff，real callClaude。
// 无 API key 时各服务自带规则降级 → 仍返回合法结构（结构冒烟）；
// 有 key 时才真正捕获 LLM 语义漂移（golden eval 的本职）。
//
// 服务用 **懒加载**（callApi 内 await import）：模块本身秒加载，
// 且把重依赖隔离到对应 surface —— 尤其 planner.js 会拉入 store.js/SQLite 链，
// 只有真跑 plan 面时才加载（clarify/gap 是 hermetic，不碰 store）。

export default class CueProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.surface = this.config.surface;
  }

  id() {
    return this.config.id || `cue:${this.surface || 'unknown'}`;
  }

  async callApi(_prompt, context = {}) {
    const vars = context.vars || {};
    // 允许 yaml 用 config.model 钉死/对比模型（P2：版本钉死）。best-effort，串行跑无竞态。
    if (this.config.model) process.env.OPENAI_MODEL = this.config.model;

    try {
      let result;
      let llmAvailable = false;
      switch (this.surface) {
        case 'clarify': {
          const { clarify } = await import('../../../server/services/prdClarifier.js');
          result = await clarify(vars.input);
          llmAvailable = (await import('../../../server/services/claude.js')).isAvailable();
          break;
        }

        case 'plan': {
          // 注意：planner.js 拉入 store.js/SQLite，需在真实终端跑（见 README）
          const { generatePlan } = await import('../../../server/services/planner.js');
          result = await generatePlan(vars.goal);
          llmAvailable = (await import('../../../server/services/claude.js')).isAvailable();
          break;
        }

        case 'gap': {
          const { analyzeGap } = await import('../../../server/services/gapAnalyzer.js');
          llmAvailable = (await import('../../../server/services/claude.js')).isAvailable();
          const store = {
            tasks: [{ id: 'eval-task', acceptance: vars.acceptance }],
            pulls: [],
            projects: [],
          };
          let snapshot = structuredClone(store);
          const updateStore = async (mutator) => {
            snapshot = mutator(structuredClone(snapshot)) || snapshot;
            return snapshot;
          };
          const pull = {
            id: 'pull_eval', number: 1, prNumber: 1,
            repo: 'eval/repo', projectId: 'eval-proj', taskId: 'eval-task',
          };
          const r = await analyzeGap(pull, store, updateStore, 'default', {
            fetchPRDiff: async () => vars.diff || '',
          });
          result = r.analysis || r; // {skipped} 或 analysis
          break;
        }

        default:
          return { error: `unknown surface: ${this.surface}` };
      }

      return {
        output: JSON.stringify(result),
        metadata: { surface: this.surface, llmAvailable },
      };
    } catch (err) {
      return { error: `${this.surface} failed: ${err && err.message ? err.message : String(err)}` };
    }
  }
}
