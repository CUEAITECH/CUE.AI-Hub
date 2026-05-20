# Doc ↔ PR ↔ Task 三端对照同步方案

> 日期：2026-05-21
> 状态：讨论中（未立项）
> 关联：第七阶段 PR 流迁移、第八阶段稳定性修复

---

## 背景

第七阶段完成了"把 PR 数据接进 Hub"，但下游消费者（晚会、风险、阶段、语义）仍在消费 commit，PR 流成了孤岛。

讨论后明确目标：**不是用 PR 替换 commit**，而是构建 Doc / PR / Task 三端互相同步的闭环——commit 提供战术精度，PR 提供战略意义，doc 提供人类可读叙事。

---

## 核心模型

```
           Hub（大脑：状态 + 调度 + 真源）
         /         |          \
   docsManager    gh API     pullPipeline
   读写 doc      读写 PR      接 PR 事件
        \          |          /
         \         |         /
        目标仓库 Cue.AI
            ↓
       PR-Agent（眼睛 + 嘴）
       ── 看 commit / 跑 review
       ── 在 PR 里写 AC 状态
       ── 把信号回传 Hub sink
```

### 角色定位

| 角色 | 职责 | 不做 |
|------|------|------|
| **Hub** | 唯一状态真源（task / AC / 进度），broker 协调三端事件 | 不直接面对人类，不替代 PR 评审 |
| **doc** | 人类可读的叙事面（计划、AC、阶段总览） | 不存机器状态 |
| **PR** | 工作面 + AC 实时 checklist + code review 现场 | 不存历史状态 |
| **PR-Agent** | 观察 commit/PR 跑 review，在 PR 写 AC checklist，通知 Hub | 不持久化状态，不做仲裁 |

---

## 全链路状态流

| 事件 | 触发方 | Hub | Doc | PR |
|------|------|------|------|------|
| AI PM 分工 | Hub LLM 规划 | task 入板，AC 列表生成 | 任务卡片注入 阶段进度.md | — |
| 开发者认领 | 前端/企微 | task.owner 设置 | — | Hub 通过 gh API 在 PR 模板预填评论（task ID + AC checklist + spec 链接） |
| 推第一个 commit | git push webhook | commit review + 绑定 task | — | AC checklist 自动勾选已实现项 |
| 推后续 commit | git push webhook | task 进度 = AC 通过率 | 标记 🔶 | AC 勾选实时变化 |
| PR-Agent /review | GitHub Actions | task.compliance 更新 | — | 评论：通过/Block/建议 |
| PR-Agent 出 Block | sink 回 Hub | task.compliance.notDone += 该 AC | 标记 🔶 阻塞 | Block 评论 |
| PR 合并 | merge webhook | task 完成 + 算分 | ✅ + 写回目标仓库 | 关闭 |
| AI PM 改 AC | Hub 后台 | broadcast | 任务卡片更新 | AC checklist 评论更新 |

**原则**：每个事件 → 单触发 → 三端响应。Hub 作为 broker 保证顺序与幂等。

---

## 关键机制：自动生成 PR Prompt

最大杠杆点。task 创建时 Hub 通过 LLM 填充模板，开发者打开 PR 即看到自包含的 spec：

```markdown
## 🎯 任务 task_abc：教师端 TRTC 入口

### 验收标准
- [ ] AC1: 老师点击进入课堂可成功推流
- [ ] AC2: 关闭按钮可正确退出房间
- [ ] AC3: 网络断开后自动重连
- [ ] AC4: UI 对应 docs/交互规范.md 第 3.2 节

### 上下文（给 Claude Code / 开发者）
- 关联文档：docs/教师端方案.md
- 已有实现：src/pages/teacher/...
- 注意事项：TRTC SDK 已封装在 src/lib/trtc.ts

### Hub 状态
- Task: https://hub.cueai.top/#tasks/task_abc
- Doc: https://github.com/.../docs/阶段进度追踪.md#task-abc
```

**Prompt 即 spec 即 review 标尺**——三合一，PR-Agent 用同一份 AC 做对照。

---

## 待决策的分歧点（动手前必须先定）

1. **Hub 写 PR 评论的身份**
   - 选项 A：Hub 专属 bot account（权限清晰，可审计）
   - 选项 B：复用 `github-actions[bot]`（无新账号成本但混淆）
   - **倾向 A**

2. **AC checkbox 由谁勾选**
   - 选项 A：PR-Agent 跑专属 LLM 评估（精度高，每次烧 token）
   - 选项 B：Hub 用 commit 文件路径粗判（便宜，易漏）
   - 选项 C：两者叠加——PR-Agent 出权威结论，Hub 实时粗判作过渡显示
   - **倾向 C**

3. **冲突仲裁规则**
   - **状态以 Hub 为准**（task 完成/进行/阻塞）
   - **描述以 Doc 为准**（任务标题、AC 文案）
   - **实时进度以 PR checklist 为准**（最快反映真实状态）

4. **循环防抖**
   - 三端互写会触发 webhook 风暴
   - 解决：每次写入加签名标记（如 commit message 含 `[hub-sync]`、PR comment 含 `<!-- hub-managed -->`），webhook 处理时跳过自身

5. **PR-Agent 角色边界**
   - 纯观察者（review + 通知 Hub） vs 允许直接修改 PR body
   - **倾向纯观察者**——PR-Agent 是 GitHub Actions，无持久状态，不应承担状态机职责

---

## 实施顺序（不开工，仅排序）

1. **PR Prompt 自动生成器**（Hub → PR 单向写入）
   - 杠杆最大，做完即使没反向同步，开发体验也大幅提升
2. **AC checklist 实时勾选**（PR-Agent 或 Hub commit review 驱动）
3. **PR 合并触发三端关闭**（最核心的闭环）
4. **Doc 反向同步**（task 状态变化 → 更新 阶段进度.md）
5. **冲突仲裁 + 循环防抖**（基础设施补全）

---

## 已具备的基础设施

- ✅ `pullPipeline.js` PR 入库 + LLM caching
- ✅ Webhook 实时 PR 事件（`upsertPullFromWebhook`）
- ✅ `docsManager.js` doc 解析 + 写回
- ✅ `prAgentParser.js` 消费 PR-Agent 评论
- ✅ PR-Agent workflow（已在 CUEAITECH/Cue.AI 激活）
- ✅ `syncTrace.js` 调用追踪 + `LLM_DRY_RUN` 调试开关

---

## 待补建的基础设施

- ⬜ Hub → PR 评论写入封装（gh API 客户端）
- ⬜ PR Prompt 模板引擎（task → markdown 渲染）
- ⬜ AC checklist 状态机（parse + 反写）
- ⬜ 三端事件 broker（Hub 内部 event bus）
- ⬜ 循环防抖签名机制

---

## 下一步

在专门会话中按"待决策点"逐条对齐，对齐后用 `writing-plans` 出正式实施计划。
