# Agent 控制模式

> 这是 CUE Agentic SDLC 的理论地基。每个概念都映射到 CUE 的具体问题。

---

## 1. ReAct（Reason + Act）

**论文**: Yao et al., ICLR 2023  
**一句话**: 想一步 → 做一步 → 看结果 → 再想

```
Thought: 我需要找到学生端进房的实现
Action: read_file("src/student/join.js")
Observation: 文件存在但 enterRoom 未调用
Thought: enterRoom 缺失，这是一个待完成任务
```

**CUE 映射**: AI PM 的每次文档解析 + gap analysis 应该是 ReAct loop，而不是一次性抽取。

---

## 2. Reflexion（自我反思强化）

**论文**: Shinn et al., NeurIPS 2023  
**一句话**: 失败后生成"复盘笔记"，下次带着笔记再试

```
尝试 1: 解析 docs → 生成任务 → 任务和代码不一致
反思: "我没有看代码就生成任务，下次应该先读文件树"
尝试 2: 带着反思 → 先读代码 → 生成更准确的 gap
```

**CUE 映射**: 这就是 E4 纠偏的理论原型。当前 AI PM 没有任何反思机制，每次都从零开始。

---

## 3. Plan-and-Execute

**一句话**: 先整体规划，再逐步执行（规划和执行分离）

**CUE 映射**: PRD → 里程碑（规划阶段）→ 任务逐步导入（执行阶段）。两者应该分离，不能规划和执行同时发生（当前 docsManager 混在一起）。

---

## 4. Open-loop vs Closed-loop Execution

**Open-loop（开环）**: 生成计划后直接执行，不管结果。  
**Closed-loop（闭环）**: 用执行结果修正计划，循环直到达成目标。

**CUE 现状**: 完全开环。  
**愿景**: 闭环（5 层 + 5 条回流边）。

**为什么开环必然失败**:
> "一旦计划生成，执行的失败（或完成）不会回传去修正分解和分配策略。"
> — LLM-Based Multi-Agent for SE, ACM TOSEM 2025

---

## 5. Hierarchical Task Decomposition

**一句话**: 高层 agent 管目标，委派给低层 agent 拆细节

```
高层: "本阶段目标是完成 TRTC 全链路联调"
中层: "拆分为 M1(教师进房) / M2(学生进房) / M3(ASR回调)"
低层: "M1 拆为 task_xxx(UserSig) / task_yyy(enterRoom) / task_zzz(验证)"
```

**CUE 映射**: SPEC-L2 的三层 schema（Milestone → Task → Subtask）。  
**当前问题**: phases:0，直接从文档跳到扁平小任务，丢失中间层。

---

## 6. State-triggered Replanning

**一句话**: 当状态变化（任务完成 / 偏离计划）时触发重规划，而非定时全量重跑

**CUE 映射**: ADR-002 的核心设计原则。替换掉"5/31 全量重解析把任务板冲零"的开环做法。

---

## 延伸阅读

- ReAct 原论文: https://arxiv.org/abs/2210.03629
- Reflexion 原论文: https://arxiv.org/abs/2303.11366
- Global Planning & Hierarchical Execution: https://arxiv.org/abs/2504.16563
- LLM Multi-Agent for SE 综述: https://dl.acm.org/doi/10.1145/3712003
