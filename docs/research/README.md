# Research — 理论与方案调研

> 记录 CUE Agentic SDLC 的学术基础和业界参考。不在这里写实现细节。

## 文档列表

| 文档 | 内容 | 对应 CUE |
|---|---|---|
| [agent-patterns.md](agent-patterns.md) | ReAct / Reflexion / Plan-and-Execute / 闭环控制 | 所有层的理论基础 |
| [open-source-solutions.md](open-source-solutions.md) | Taskmaster / Backlog.md / Spec Kit / APM / Skyvern / TraceLLM | 各层借鉴来源 |
| [llm4re-survey.md](llm4re-survey.md) | LLM 做需求工程的学术综述 | ①② 层 |
| [benchmarks.md](benchmarks.md) | SWE-bench / WebArena / WebVoyager 当前成绩 | E2 能力边界参考 |

## 最关键的一条结论

> 你的 AI PM 失败，在学术上叫做 **Open-loop execution**（开环执行）。
> 这不是 CUE 独有的问题，是 2024 年以前所有 LLM 规划系统的通病。
> 2025-2026 学术前沿正好在解决它，工具链刚刚成熟到可以用。

来源: LLM-Based Multi-Agent for SE, ACM TOSEM 2025
