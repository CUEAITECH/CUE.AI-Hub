# CUE 团队 PR 工作流使用说明

> 版本：2026-05-20 | 适用仓库：CUEAITECH/Cue.AI 及所有接入 Hub 的项目仓库

---

## 1. 核心原则

- **PR 是最小交付单元**：每个功能点或 bugfix 对应一个 PR，不要一个 PR 塞多个无关改动
- **AC checklist 必填**：PR 描述里的"验收清单"是 Hub 自动对账的依据，不填则晚会无法自动评估进度
- **hotfix 例外（C+ bypass）**：紧急修复可直推 main，但必须在 **24h 内** 补开 PR，否则触发企微告警

---

## 2. 标准 PR 流程

```
1. 从 main 切出功能分支
   git checkout -b feat/your-feature-name

2. 开发 + commit（遵循 commit 规范）
   git commit -m "feat: 实现 xxx 功能，解决 yyy 问题"

3. 推送分支
   git push origin feat/your-feature-name

4. 在 GitHub 开 PR，填写模板
   - 关联任务 ID（task_xxx 格式）
   - 验收清单（AC checklist）逐条填写

5. PR-Agent 自动 review（约 2-5 分钟）
   - 会在 PR 页面留 review comment
   - Hub 自动同步结果

6. 团队 review + 讨论

7. merge 到 main
   - 晚会对账自动以本 PR 的 compliance 为依据
```

---

## 3. PR 描述模板说明

PR 描述中的验收清单格式：

```
## 验收清单（AC）
- [ ] 用户可以登录          ← 未完成
- [x] 接口返回 200          ← 已完成
- [~] 边界情况待确认        ← 需人工 check
```

符号说明：
- `[x]` = 已完成（计入 done 桶）
- `[ ]` = 未完成（计入 notDone 桶）
- `[~]` = 需人工确认（计入 needsHumanCheck 桶，不计入进度）

任务关联格式：
```
## 关联任务
任务：task_xxx          ← 填 Hub 里的任务 ID，格式必须是 task_xxx
```

---

## 4. 分支命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 功能 | `feat/<描述>` | `feat/pr-flow-migration` |
| 修复 | `fix/<描述>` | `fix/login-error` |
| 文档 | `docs/<描述>` | `docs/update-workflow` |
| 热修复（直推 main） | `hotfix/<描述>` | `hotfix/critical-crash` |

---

## 5. C+ bypass（hotfix 直推 main）

**场景**：线上紧急故障，来不及走完整 PR 流程。

**操作步骤**：
1. 切换到 `hotfix/xxx` 分支进行修复
2. 直接 push 到 main（Hub 会自动记录 bypass）
3. **24h 内** 在 GitHub 补开一个 PR 关联该 commit
4. 超 24h 未补 → 企微告警，@负责人

**注意**：只有 `hotfix/` 开头的分支才算合规 bypass，其他分支直推 main 会被 CI 记录（Hub 静默跳过，不告警）。

---

## 6. 晚会对账机制

每天 18:00 晚会，Hub 自动生成对账报告：

1. 取当日 merged PR
2. 读 PR 的 hubReview.compliance（三桶：done/notDone/needsHumanCheck）
3. 计算任务进度 = done / (done + notDone + needsHumanCheck) × 100%
4. 推送企微作战包（含 PR 汇总：已合并/待 review/Block 数）

如果 PR 没有关联任务 → 单独列出，标注"待关联任务"。

---

## 7. 在 Hub 查看 PR 数据

打开 Hub（https://hub.cueai.top），点击导航栏「PR 列表」：

- 可按项目、状态（待合并/已合并/已关闭）、成员筛选
- 点击 PR 卡片展开详情：查看 Hub Review 和 PR-Agent 的合规三桶
- 「Pass」按钮：人工覆盖，标记为通过
- 「Escalate」按钮：升级处理

---

## 8. 常见问题

**Q: PR-Agent review comment 看不懂？**  
A: PR-Agent 用英文输出，Hub 做中文映射。可以在 Hub 的 PR 列表页看中文版合规结论。

**Q: 我的任务没有在晚会对账里出现？**  
A: 检查 PR 描述的"关联任务"字段是否填了 `task_xxx` 格式的 ID。

**Q: compliance 三桶和我实际情况不符？**  
A: 在 Hub PR 详情页点"Pass"（人工覆盖）或联系 Hub 管理员修正。

**Q: 可以一个 PR 关联多个任务吗？**  
A: 可以，在"关联任务"字段填多行 `task_xxx`。Hub 会把该 PR 的 compliance 同时关联所有任务。

**Q: 直推 main 的 commit 会怎样？**  
A: Hub 记录 bypass 并给 24h 补 PR 的窗口期。如果是普通功能开发建议开 PR，hotfix 场景才用直推。
