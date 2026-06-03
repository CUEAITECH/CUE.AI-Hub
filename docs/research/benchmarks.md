# Agent Benchmarks — 能力边界参考

> 用于判断 CUE 各层的可实现度上限。数据截至 2026-06。

---

## SWE-bench Verified（软件工程 Agent）

**测试内容**: Agent 是否能解决真实 GitHub issue（写 patch 并通过测试）  
**当前最高分**: 80%+（claude-opus-4 / GPT-5 级别模型，2026）  
**2023 基准**: 1.96%（Claude 2）

**对 CUE 的意义**: CUE 的 AI PM 不直接写代码，但它生成的任务描述质量影响 AI coding agent 的成功率。任务描述越精准（带验收标准和依赖），SWE-bench 类任务的完成率越高。

---

## WebArena / WebVoyager（Web Agent）

**测试内容**: Agent 是否能完成真实网站上的操作任务  
**当前最高分**: 
- WebArena: 61.7%（IBM CUGA，2025-02）
- WebVoyager: 59.1%（WebVoyager 原论文）

**对 CUE 的意义**: CUE E2（browser agent 测试）的能力天花板。**当前最好的系统也只有约 60% 成功率。**

这意味着：
- E2 现阶段是"辅助发现问题"，不是"全自动质检"
- 不能把 E2 的判断结果直接驱动 E4 纠偏（置信度不够）
- 需要 Human-in-the-loop 确认 E2 的重要发现

---

## 对 CUE 各层可实现度的影响

| CUE 层/边 | 关联 Benchmark | 能力天花板 |
|---|---|---|
| ⑤ E2 标准 Web 测试 | WebArena / WebVoyager | **~60%**（无法突破当前 SOTA）|
| ⑤ E2 音视频测试 | 无对应 benchmark | **~10%**（工具链不支持音频感知）|
| E1 语义匹配 | TraceLLM | **~75%**（无显式 ID 时）|
| ② 任务生成 | SWE-bench 间接参考 | 取决于 acceptance 质量 |

---

## 结论

> **不要把任何 agent 的能力设计成"必须 100% 可靠才能运行"的关键路径。**
> 当前最好的 Web Agent 也只有 60%。
> CUE 的正确设计是：agent 提供信号，人类确认关键决策，系统在置信度高时自动行动，置信度低时请求确认。
