# LLM4RE — 用 LLM 做需求工程

> 摘要自：arXiv 2509.11446（LLM4RE 系统综述，2025）和 arXiv 2602.01253（TraceLLM，2026）

---

## 什么是 Requirements Engineering（需求工程）

需求工程是把"用户想要什么"变成"工程师能实现什么"的过程，包括：
1. **需求获取**：从用户/文档/会议提取需求
2. **需求规范化**：写成标准格式（用户故事、验收标准）
3. **需求追溯**：每个需求对应哪段代码、哪个测试
4. **需求变更管理**：需求变了，自动找到受影响的任务和代码

CUE 的 AI PM 做的是第 1-2 步，但缺第 3-4 步。这正是"代码有了但功能发现不了"的根因。

---

## 主流方法成熟度

| 方法 | 成熟度 | CUE 当前状态 |
|---|---|---|
| 文档 → 结构化需求（NLP 提取）| ✅ 成熟 | 已有，但 schema 不完整 |
| 需求澄清（反问 + 多轮对话）| ✅ 成熟 | ❌ 未实现 |
| 需求 ↔ 代码追溯（TraceLLM）| ✅ 2026 SOTA | ❌ 未实现 |
| 需求分层（Epic→Story→Task）| ✅ 成熟 | ❌ phases:0 |
| 差距分析（PRD vs 代码）| ⚠️ 前沿可用 | ❌ 未实现 |
| 需求变更影响分析 | ⚠️ 前沿研究中 | ❌ 未实现 |

---

## TraceLLM 核心机制（可直接借鉴）

TraceLLM 把需求追溯问题定义为：

> 给定一条需求 R 和一段代码 C，判断 C 是否实现了 R。

**Prompt 结构**:
```
你是软件需求追溯专家。
需求: [REQ-L2-001] 解析 PRD 产出三层结构 Milestone→Task→Subtask
代码摘要: [commit message / 函数签名 / 文件路径]
请判断这段代码是否实现了该需求，给出 0-1 的置信度和理由。
```

**在 CUE 中的用途**:
- SPEC-E1：commit message → task（是否完成）
- ④-c：代码文件树 → PRD 需求（gap analysis）
- ④-d：PR diff → acceptance criteria（还差什么）

---

## 关键数据

- 到 2026 年，LLM4RE 论文数量预计等于过去 40 年 NLP4RE 的总和（综述预测）
- TraceLLM F2 分数超过所有传统 IR 方法和微调模型（8 个 benchmark 验证）
- 62% 的 LLM4RE 研究组合多种策略（Zero-shot + template + task decomposition）

---

## 对 CUE 的直接启示

1. **需求必须有 ID（REQ-xxx）**：这是追溯的前提，没有 ID 就没有追溯链
2. **spec 是唯一真相源**：代码/任务/测试都从 spec 派生，不允许"凭印象做"
3. **gap analysis = 核心功能，不是可选功能**：CUE 的 AI PM 缺这一块才导致"发现不了已做和未做的东西"
