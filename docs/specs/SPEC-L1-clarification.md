---
id: SPEC-L1
title: "L1 — 想法 → 澄清反问 → 标准 PRD"
status: draft
type: layer
index: 1
fidelity: 85%
open-source-basis:
  - GitHub Spec Kit (/specify workflow)
  - IdeaForge (clarification dialog pattern)
cue-seed: []
dependencies: []
effort-weeks: 2
phase: 2
---

# SPEC-L1：想法 → 澄清反问 → 标准 PRD

## 1. 目标

> 用户输入一句模糊想法、会议记录或用户反馈，AI 先反问澄清，再输出一份标准结构化 PRD。解决"需求没想清楚就布置任务"的根因。

**当前问题**：AI PM 入口只能点"同步文档"，无法接受自由输入，无澄清机制，直接抽取任务。

## 2. 需求

### 功能需求

- **REQ-L1-001**:（必须）接受任意格式输入：一句话想法、会议记录段落、用户反馈截图描述、现有 markdown 文档
- **REQ-L1-002**:（必须）输入后，AI 先返回 3-5 个澄清问题，**不直接生成 PRD**
- **REQ-L1-003**:（必须）用户回答澄清问题后，生成结构化 PRD（含所有必填字段）
- **REQ-L1-004**:（必须）PRD 输出格式标准化，可被 SPEC-L2 的解析器消费
- **REQ-L1-005**:（应该）支持多轮迭代：用户可对 PRD 提出修改，AI 局部更新而非全部重写
- **REQ-L1-006**:（应该）澄清问题聚焦四类：目标用户、成功标准、范围边界、已知约束

### 非功能需求

- **REQ-L1-NFR-001**: 澄清问题不超过 5 个（太多用户不答）
- **REQ-L1-NFR-002**: PRD 生成后必须通过 schema 校验（所有必填字段非空）

## 3. 用户故事

```
作为产品负责人，我有一个模糊的想法（"做一个让学生能提问的功能"），
我希望 AI 问我几个关键问题，然后帮我写成完整的 PRD，
而不是直接给我一堆任务但我不知道它在做什么。
验收：输入一句话 → AI 返回 3-5 个问题 → 回答后产出有完整字段的 PRD。
```

## 4. 验收标准

- [ ] AC-L1-001: 任意输入后，AI 返回澄清问题而非直接输出任务
- [ ] AC-L1-002: 澄清问题数量 3-5 个
- [ ] AC-L1-003: 回答后产出的 PRD 包含：goal / userStories / scope / nonGoals / acceptance / risks
- [ ] AC-L1-004: PRD 的 `acceptance` 字段与 `goal` 字段不相同（非复制）
- [ ] AC-L1-005: PRD 可被 SPEC-L2 的 parseDocsForTasks 消费（schema 兼容）

## 5. 技术方案

### 澄清 Prompt（核心）

```
系统提示：
你是 CUE 的 AI 产品经理。当用户描述一个想法或需求时，
你的第一步是识别模糊之处并提问，而不是直接生成任务。
聚焦四类问题：
1. 目标用户是谁，他们有什么具体痛点？
2. 做完了什么算成功（可量化）？
3. 范围边界：这次做什么，明确不做什么？
4. 已知约束：技术/时间/资源限制？

返回格式：
{
  "clarificationQuestions": ["问题1", "问题2", ...],  // 3-5个
  "initialUnderstanding": "我理解你想做的是..."  // 防止完全误解
}
```

### PRD 输出 Schema

```json
{
  "id": "prd_xxx",
  "title": "PRD 标题",
  "version": "1.0",
  "createdAt": "ISO date",
  "goal": "一句话：这个功能为谁解决什么问题",
  "userStories": [
    {
      "id": "US-001",
      "as": "角色",
      "want": "操作",
      "so": "收益",
      "acceptance": "可测量的完成条件"
    }
  ],
  "scope": ["在范围内的内容"],
  "nonGoals": ["明确不做的内容"],
  "acceptance": ["整体验收标准（可测量）"],
  "risks": ["已知风险"],
  "sourceInput": "原始输入文本"
}
```

### CUE 接入点

```
新增文件: server/services/prdClarifier.js
  - clarify(input): 返回澄清问题
  - generatePrd(input, answers): 返回结构化 PRD
  - refinePrd(prdId, feedback): 局部更新 PRD

新增路由: POST /api/ai/clarify
          POST /api/ai/generate-prd
          PATCH /api/prd/:id

前端: #ai-pm 页加"描述你的想法"输入框 + 澄清问答流程
```

## 6. 差距分析

| 能实现的 | 实现不了的 | 硬上限 |
|---|---|---|
| 通用澄清反问 | 产品领域专业知识的自动注入 | 需人工维护领域上下文 |
| 结构化 PRD 生成 | 跨项目历史经验参考 | 需要向量记忆积累 |
| 多轮迭代修改 | "这个需求和三个月前的冲突"类检测 | 需要需求版本管理 |

## 7. 实现笔记

> 待实现后更新。
