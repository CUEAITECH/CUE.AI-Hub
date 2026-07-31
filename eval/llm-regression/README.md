# LLM Golden 回归 Eval

CUE 对治 **P2(LLM 非确定性 / 模型漂移)** 的工程件。见 `docs/research/open-problems.md` P2。

> 学术依据:LLMOps 标准做法 = **固定 golden dataset + 每次模型/prompt 版本变更重跑 + CI 闸门**。
> 断言按**结构/语义不变量**而非字节精确匹配([arXiv:2506.13023]:非确定性下须按语义等价评估)。

## 这是什么

用业界标准件 **[promptfoo](https://www.promptfoo.dev/)**(已 pin 进 devDependencies)当骨架,
但通过自定义 provider(`providers/cue-provider.mjs`)调 **CUE 自己的服务函数**,
测的是真实出厂链路(prompt + 解析 + 降级),不是裸 prompt。

覆盖面:

| surface | 调用 | 不变量(`asserts/invariants.mjs`) |
|---|---|---|
| `clarify` (L1) | `prdClarifier.clarify` | 返回 3–5 个澄清问题 |
| `gap` (T13/L4c) | `gapAnalyzer.analyzeGap` | covered/missing 为数组、riskLevel/source 合法枚举、空 acceptance 正确跳过 |
| `plan` (L2) | `planner.generatePlan` | 3–6 任务、有 title、acceptance≠description |

## 怎么跑

**两层验证,分清楚:**

| 层 | 命令 | 测什么 | 依赖 |
|---|---|---|---|
| 断言侧(离线,进 CI) | `npm run test:unit`(含 `scripts/test-llm-eval-asserts.mjs`) | **不变量断言本身对不对**(golden 集期望侧) | 无 —— 纯逻辑,不碰 SQLite/key/网络 |
| 端到端(实跑) | `npm run eval:llm` | 真实服务链 + LLM 输出是否漂移 | **需真实终端**(走 better-sqlite3 + 可选 LLM key) |

```bash
# 端到端:跑 hermetic 的两面(clarify + gap),不打网络(除 LLM 本身)
npm run eval:llm
# 可视化报告(promptfoo web UI)
npm run eval:llm:view
```

> ⚠️ `npm run eval:llm` 会经 `claude.js → configStore.js → better-sqlite3`,
> **必须在真实终端 + 项目锁定的 Node 22(`.nvmrc`)** 下跑;
> Node 24/受限 sandbox 里原生模块会失配卡死(见 memory `dev-env-gotchas`)。
> 断言侧逻辑已由 `scripts/test-llm-eval-asserts.mjs` 在 CI 离线覆盖(19/19),无此依赖。

**关键:有没有配 `OPENAI_API_KEY` 决定测什么**
- **没 key**:各服务走规则降级,仍返回合法结构 → 验证**结构不变量**(抓代码回归)。可离线跑、CI 安全。
- **有 key**:走真实 LLM → **额外捕获语义漂移**(golden eval 的本职)。会真实调用、产生费用。

**何时跑(P2 纪律)**:换模型(`OPENAI_MODEL`)、改任一 system prompt、升级 LLM 供应商时,**必跑**,对比基线看行为是否漂移。

## 为什么 `plan` 单独拆(`npm run eval:llm:plan`)

`planner.js` 会 import `store.js` → 拉入 better-sqlite3/SQLite 链,需在**真实终端**跑(sandbox 里 native 模块加载可能挂,见 memory `dev-env-gotchas`)。
故 `plan` 不进默认 `eval:llm`,单独提供 `eval:llm:plan`,请在本机终端、装好原生模块后运行。

## 对比模型(可选)

provider 支持 `config.model` 钉死模型(P2 版本钉死)。要并排对比两个模型的漂移,
在对应 config 的 `providers` 下复制一份改 `label` + `config.model` 即可,promptfoo 会自动出对比表。

## 扩展:加新 surface

1. `providers/cue-provider.mjs` 的 `switch` 加一个 `case`(懒加载对应服务);
2. `asserts/invariants.mjs` 加一个不变量函数;
3. 复制一份 `config.<surface>.yaml`,填 golden 用例 + 绑断言。
