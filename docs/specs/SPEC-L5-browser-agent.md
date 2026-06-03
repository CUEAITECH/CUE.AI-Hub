---
id: SPEC-L5
title: "L5 — Browser Agent 像人一样测试"
status: draft
type: layer
index: 5
fidelity: 48%
open-source-basis:
  - Skyvern (skyvern-ai/skyvern)
  - browser-use
  - Stagehand (Browserbase)
cue-seed:
  - mcp__Claude_in_Chrome（已连接）
dependencies:
  - SPEC-L3
  - SPEC-L2
effort-weeks: 8
phase: 3
---

# SPEC-L5：Browser Agent 像人一样测试

## 1. 目标

> 驱动 browser agent 访问产品网站，按照任务的 acceptance criteria 逐条测试，把测试结果记录进系统，为 E2 提供"业务是否真实现"的信号。

**诚实的能力边界**：WebArena 当前最高分 61.7%，WebVoyager 59.1%。CUE 产品核心是音视频，E2 对音视频功能的可实现度约 8-12%。本层设计以**辅助发现问题**为目标，不是全自动质检。

## 2. 需求

### 功能需求

- **REQ-L5-001**:（必须）接受任务的 acceptance criteria，生成对应的浏览器测试步骤
- **REQ-L5-002**:（必须）执行测试，记录每个 AC 的测试结果（pass / fail / inconclusive）
- **REQ-L5-003**:（必须）测试结果写入 `store.testRuns`，关联 task_id
- **REQ-L5-004**:（必须）inconclusive（无法判断）时，标记为"需人工确认"，不自动判 fail
- **REQ-L5-005**:（应该）测试失败时截图，作为证据存入 evidenceRefs
- **REQ-L5-006**:（不做）音视频质量测试（TRTC 通话质量、音频延迟）——硬上限，标记为 manual-only

### 非功能需求

- **REQ-L5-NFR-001**: 单次测试 session ≤ 15 分钟（避免 timeout 和高成本）
- **REQ-L5-NFR-002**: 每次测试 LLM 调用成本 ≤ $3
- **REQ-L5-NFR-003**: flaky 率（相同测试两次结果不同）< 30%

## 3. 用户故事

```
作为 QA / 产品负责人，我想让 agent 帮我验证"学生能通过课堂码加入课堂"
这个功能是否真的能用，而不只是代码里有对应函数。
验收：agent 访问产品网站，完成加入课堂流程，输出 pass/fail + 截图。
```

## 4. 验收标准

- [ ] AC-L5-001: 给定"登录 → 进入课堂列表"的 AC，agent 能完成并输出 pass
- [ ] AC-L5-002: 给定一个已知 broken 的功能，agent 输出 fail 或 inconclusive（不误判 pass）
- [ ] AC-L5-003: 测试结果写入 store.testRuns，关联 task_id
- [ ] AC-L5-004: 测试耗时 < 15 分钟
- [ ] **AC-L5-005: 音视频相关 AC 输出 `manual-only`，不尝试自动测试**

## 5. 技术方案

### 工具选型（→ 见 ADR-003）

优先用 **Skyvern**（开源，vision-based，无需预先了解 DOM 结构）。
CUE 环境已有 `mcp__Claude_in_Chrome` 可作为轻量替代。

### 测试用例生成

```
输入: task.acceptance = "学生端进入课堂后，TRTC 控制台显示该学生已进房"

生成测试步骤:
1. 打开 [PRODUCT_URL]/join
2. 输入课堂码（测试环境提供）
3. 点击"加入课堂"
4. 观察页面状态 → 判断是否成功进入课堂界面
5. （无法验证 TRTC 控制台 → 标记 inconclusive）
```

### 结果数据结构

```json
{
  "id": "run_xxx",
  "taskId": "task_xxx_yyy",
  "triggeredAt": "ISO date",
  "status": "pass | fail | inconclusive | manual-only",
  "acResults": [
    {
      "acId": "AC-L5-001",
      "status": "pass | fail | inconclusive | manual-only",
      "evidence": "screenshot_url or null",
      "reason": "为什么 inconclusive 或 fail"
    }
  ],
  "cost": 0.85,
  "durationSeconds": 180
}
```

### 音视频功能处理

```
检测规则：AC 文本包含以下关键词时，自动标记 manual-only：
  TRTC / 音频 / 视频 / 进房 / 麦克风 / 扬声器 / 屏幕共享 / 实时

同时生成提醒：
  "该功能需要人工测试：[AC 内容]"
  → 写入 store.manualTestQueue
```

## 6. 差距分析

| 测试类型 | 可实现度 | 说明 |
|---|---|---|
| 页面导航 / 点击 / 表单 | 75-80% | 接近生产可用 |
| 视觉 QA（布局/色系/响应式）| 65% | 主观判断需基准 |
| **实时音视频（TRTC）** | **8-12%** | **硬上限，当前无任何工具有音频感知** |
| 多端实时协作 | 15-20% | 多 agent 协同极不稳定 |

## 7. 实现笔记

> 待实现后更新。
