---
id: SPEC-E2
title: "E2 — 测试结果 → 业务是否真实现"
status: draft
type: edge
index: E2
fidelity: 48%
open-source-basis:
  - SPEC-L5 (browser agent test runs)
cue-seed: []
dependencies:
  - SPEC-L5
  - SPEC-E1
effort-weeks: 3
phase: 3
---

# SPEC-E2：测试结果 → 业务实现判定

## 1. 目标

> 把 L5 的测试结果（pass/fail/inconclusive）转化为"这个业务功能是否真实现"的结论，写回任务状态，为 E4 纠偏和 L4-c 缺口分析提供真实信号。

**与 E1 的区别**：E1 看的是"代码是否提交"，E2 看的是"功能是否能用"。两者互补。代码有 + 功能能用 = 真正完成。

## 2. 需求

- **REQ-E2-001**:（必须）L5 测试结果 all pass → task.e2Status = `verified`
- **REQ-E2-002**:（必须）L5 测试结果有 fail → task.e2Status = `failed`，触发通知
- **REQ-E2-003**:（必须）L5 测试结果有 inconclusive → task.e2Status = `needs-review`，推送人工确认
- **REQ-E2-004**:（必须）manual-only 的功能不走 E2，直接标 `manual-required`
- **REQ-E2-005**:（应该）e2Status 显示在任务详情和里程碑进度中

## 3. 验收标准

- [ ] AC-E2-001: L5 全 pass → task.e2Status = `verified`，里程碑进度更新
- [ ] AC-E2-002: L5 有 fail → e2Status = `failed`，在 hub 和企微推送通知
- [ ] AC-E2-003: 音视频相关任务自动标 `manual-required`，不参与 E2 自动判定
- [ ] AC-E2-004: e2Status 在总览页的里程碑卡片上可见

## 4. 状态机

```
task.e2Status 状态机:

not-tested  →（L5 运行）→  verified
                        →  failed      →（修复后重测）→ verified
                        →  needs-review →（人工确认）→ verified / failed
                        →  manual-required（永久，需人工测）
```

## 5. 实现笔记

> 待实现后更新。
