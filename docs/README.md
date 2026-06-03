# CUE Hub — 文档架构

> 这套文档架构基于 LLM4RE（用 LLM 做需求工程）原则设计。
> 核心约定：**spec 是唯一真相源**。任务从 spec 派生，代码追溯到 spec，进度写回 spec。

---

## 目录结构

```
docs/
├── vision/           ← 北极星。产品定位 + 可行性规格说明书
├── specs/            ← 组件规格（LLM4RE 核心）。AI PM 从这里解析任务
├── architecture/     ← 技术决策（ADR）+ 数据模型
├── research/         ← Agent 模式 + 开源方案 + 学术 Benchmark
├── superpowers/      ← 日常开发计划 + 设计稿（历史保留）
│   ├── plans/
│   └── specs/
├── AI-PM-PROGRESS.md ← AI PM 自动写回的进度（勿手改）
└── 开发进度.md        ← 历史进度（人工维护）
```

---

## 各目录用途速查

| 目录 | 写什么 | 谁写 | 改动频率 |
|---|---|---|---|
| `vision/` | 产品定位、可行性评估 | 产品负责人 | 低 |
| `specs/` | 每个层/边的需求+验收+技术方案 | 产品+工程 | 中（每个 Phase 开始时更新）|
| `architecture/adr/` | 为什么做这个技术决策 | 工程负责人 | 低 |
| `research/` | 学术理论 + 开源方案分析 | 任何人 | 低（工具链有重大变化时）|
| `superpowers/plans/` | 具体实现计划（Task 级别）| 工程师 | 高 |
| `AI-PM-PROGRESS.md` | 当前阶段进度追踪 | **AI PM 自动生成** | 每次 sync-docs |

---

## 追溯链（LLM4RE 的核心价值）

```
vision/product-vision.md（北极星）
  └── specs/SPEC-Lx / SPEC-Ex（需求 REQ-xxx）
        └── hub 任务板（task_id，引用 requirementRefs）
              └── commit message（含 task_id）
                    └── PR → merged
                          └── E1 自动翻转任务状态
                                └── E4 更新里程碑进度
                                      └── AI-PM-PROGRESS.md（写回）
```

---

## 约定

1. **每条需求有 ID**：格式 `REQ-L2-001`（SPEC 编号 + 序号）
2. **每个验收标准有 ID**：格式 `AC-E1-001`
3. **commit message 带 task_id**：格式 `task_xxx_yyy`（已在执行）
4. **spec 变更走 ADR**：改了数据 schema 或架构设计，必须写 ADR 说明为什么

---

## 快速导航

- 了解产品定位 → [vision/product-vision.md](vision/product-vision.md)
- 了解愿景 vs 实际能做多少 → [vision/feasibility-spec-agentic-sdlc.md](vision/feasibility-spec-agentic-sdlc.md)
- 了解下一步要实现什么 → [specs/README.md](specs/README.md)（看 Phase 1 ★ 标记）
- 了解为什么这么设计 → [architecture/adr/](architecture/adr/)
- 了解技术理论基础 → [research/agent-patterns.md](research/agent-patterns.md)
- 了解开源方案选型 → [research/open-source-solutions.md](research/open-source-solutions.md)
