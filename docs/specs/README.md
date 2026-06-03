# Specs — 组件规格说明

每个 Spec 对应 Agentic SDLC 的一个层（Layer）或回流边（Edge）。

**写 Spec 的目的**：让 AI PM 能从这里解析出结构化任务，让实现可被追溯到需求。

## Spec 索引

### Layers（从想法到交付的主链路）

| Spec | 标题 | 状态 | 可实现度 | Phase |
|---|---|---|---|---|
| [SPEC-L1](SPEC-L1-clarification.md) | 澄清反问 → 标准 PRD | draft | 85% | 2 |
| [SPEC-L2](SPEC-L2-task-schema.md) | PRD → 里程碑 + 任务 schema | draft | 78% | 1 |
| [SPEC-L3](SPEC-L3-pr-automation.md) | 任务 → 自动建 PR | draft | 90% | 1 |
| [SPEC-L4](SPEC-L4-monitoring.md) | 实时监控（仓库/PR/业务缺口） | draft | 65% | 2 |
| [SPEC-L5](SPEC-L5-browser-agent.md) | Browser Agent 像人一样测试 | draft | 48% | 3 |

### Edges（回流边，闭合闭环）

| Spec | 标题 | 状态 | 可实现度 | Phase |
|---|---|---|---|---|
| [SPEC-E1](SPEC-E1-commit-tracking.md) | commit/PR → 任务状态自动翻转 | draft | 80% | 1 ★ |
| [SPEC-E2](SPEC-E2-browser-testing.md) | 测试结果 → 业务实现判定 | draft | 48% | 3 |
| [SPEC-E3](SPEC-E3-diff-risk.md) | diff 风险 → 阻断/新任务 | draft | 83% | 1 ★ |
| [SPEC-E4](SPEC-E4-replanning.md) | 完成情况 → 调整里程碑 | draft | 65% | 2 |
| [SPEC-E5](SPEC-E5-iteration.md) | 交付 → 下一轮迭代起点 | draft | 80% | 3 |

★ = Phase 1 优先，种子最强，立刻止血

## 追溯链

```
vision/product-vision.md
  └── PRD.REQ-xxx
        └── SPEC-Lx / SPEC-Ex
              └── task_id（hub 任务板）
                    └── commit message（含 task_id）
                          └── PR → merged
                                └── E1 自动翻转任务状态
```

## 如何写 Spec

使用 [SPEC-template.md](SPEC-template.md)。每条需求必须有 `REQ-XX-NNN` 格式的 ID，供任务和 commit 追溯。

## AI PM 解析规则

AI PM 从 Spec 生成任务时：
1. 读取 `## 4. 验收标准` 的 AC checklist → 直接作为任务 acceptance
2. 读取 `## 2. 需求` 的 REQ IDs → 作为 task 的 `requirementRefs` 字段
3. 读取 `dependencies` frontmatter → 建立任务间依赖
4. 读取 `phase` frontmatter → 决定导入优先级
