# LLM4RE — 用 LLM 做需求工程

> 摘要自：arXiv 2509.11446（LLM4RE 系统综述，2025）和 arXiv 2602.01253（TraceLLM，2026）

> **⚠️ 2026-06-14 更正（精读 TraceLLM 原文后）**：本文早期版本对 TraceLLM 有三处错误，已在下文修正：
> 1. TraceLLM 的任务是**文档制品↔文档制品配对**（需求↔设计、用例↔测试、需求↔法规），判断「(2) 是否 directly fulfill (1)，只答 Yes/No」。**它不碰代码，更不碰 PR diff**。早期写的「需求 R ↔ 代码 C」是错的。
> 2. 「④-c 代码文件树→PRD」「④-d PR diff→acceptance criteria」**不是 TraceLLM 的场景**，是 CUE 自己的外推，曾被误当成论文原话（并写进了 SPEC-L4c 的依据，已更正）。
> 3. 「8 个 benchmark」应为 **8 个 LLM + 4 个数据集（CM1/EasyClinic×2/CCHIT）**。
>
> **更贴 CUE「代码↔验收」场景的论文（精读/搜索于 2026-06-14）**：
> - **Are LLMs Reliable Code Reviewers? Systematic Overcorrection（arXiv:2603.00539, 2026）** — 任务即「不跑测试，判代码是否满足 NL 需求」=T13 同款。开源 github.com/HollinJ3177/...。关键警告：LLM 系统性把已满足判成缺失（假阴性高），且**越要求解释/纠正的详细 prompt 错得越狠**（GPT-4o FNR 35.9%→87.9%）。
> - **Enhancing PR Reviews: Issue↔PR Inconsistencies（FORGE 2025, ACM）** — exact/missing/tangling/both 分类法；实测 missing 16.5%、tangling 13.4%。
> - **执行/Agent 验证线（T14/E2 依据）**：AgentForge(2604.13120)、Verify-Before-You-Fix(2604.10800)、Agentic Rubrics as Contextual Verifiers(2601.04171)、You-Name-It-I-Run-It(2412.10133)、DCE-LLM(2506.11076)、Semgrep+LLM。核心原理 execution grounding：把判断锚定到测试红绿/调用图等客观信号，旁路 LLM 偏差。**警告**：无约束 Agent 会篡改测试「骗过」验证，验证器需防篡改。
> 三级谱系（静态文本判断 → 静态工具 Agent → 执行/浏览器 Agent）详见 SPEC-L4c §6。

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

## TraceLLM 核心机制（范式可借鉴，任务不同）

TraceLLM 把需求追溯定义为**两个文档制品之间的配对二分类**：

> 给定制品 (1) 和制品 (2)（如：高层需求 ↔ 设计元素），判断「(2) 是否 directly fulfill (1)？只答 Yes / No」。

注意：**两端都是文档/文本制品，不含代码或 diff**。它实测的制品对是 需求↔设计、用例↔测试、用例↔交互图、需求↔法规。

**最优 Prompt（论文 P6）**:
```
You are an expert in software traceability. You are given two artifacts
from [DOMAIN]. (1) is [ARTIFACT_1] and (2) is [ARTIFACT_2].
Does [RELATION]? Answer with only 'Yes' or 'No'.
```
关键发现：角色提示有效；加「directly」把精确率 0.38→0.49；输出约束到 Yes/No 单 token、温度 0；2-shot + diversity + label-aware 选样优于零样本。

**可借鉴到 CUE 的是「范式」而非「任务」**：
- LLM-as-judge（不训练、不做向量检索，直接让通用模型当裁判）
- prompt 三件套：角色 + 显式关系 + 结构化输出
- 半自动定位：只做召回/初筛，结论需人工复核（recall 60–70%，不足以全自动）

**SPEC-E1（commit→task）** 的判断思路与此范式同源；而 **SPEC-L4c（PR diff↔acceptance）** 是把范式外推到「代码↔验收」新场景，TraceLLM 未验证过该场景（更贴的依据见顶部更正框）。

---

## 关键数据

- 到 2026 年，LLM4RE 论文数量预计等于过去 40 年 NLP4RE 的总和（综述预测）
- TraceLLM F2 分数超过传统 IR（VSM/LSI/LDA）和 BERT 基线（4 个数据集 × 8 个 LLM 验证；F2 约 0.68–0.83，仍属半自动水平）
- 62% 的 LLM4RE 研究组合多种策略（Zero-shot + template + task decomposition）

---

## 对 CUE 的直接启示

1. **需求必须有 ID（REQ-xxx）**：这是追溯的前提，没有 ID 就没有追溯链
2. **spec 是唯一真相源**：代码/任务/测试都从 spec 派生，不允许"凭印象做"
3. **gap analysis = 核心功能，不是可选功能**：CUE 的 AI PM 缺这一块才导致"发现不了已做和未做的东西"
