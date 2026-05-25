# CUE 团队 PR 提交流程与审阅规则

> 版本：2026-05-25 | 适用仓库：CUEAITECH/Cue.AI、CUE.AI-Hub 及所有接入 Hub 的项目仓库

本文档是 CUE 团队的 PR 提交规则。除负责人明确豁免外，功能开发、缺陷修复、文档、配置、发布和 hotfix 都按这里执行。

---

## 1. 核心原则

- **PR 是最小交付单元**：每个功能点、bugfix 或可验证交付对应一个 PR，不把多个无关目标塞进同一个 PR。
- **主分支保持可发布**：`main` 任何时候都应处于可部署或接近可部署状态。
- **先 Draft，后 Ready**：较大或不确定的改动尽早开 Draft PR 暴露上下文，完成后再转 Ready for Review。
- **AC checklist 必填**：PR 描述里的验收清单是 Hub 自动对账依据，不填则晚会无法自动评估进度。
- **自动化优先**：lint、test、build、格式、标题、密钥扫描等机器能检查的内容交给 GitHub Actions。
- **人工审阅看风险**：review 重点关注需求一致性、边界条件、安全、性能、数据一致性、可维护性和测试充分性。
- **hotfix 有绿色通道**：线上紧急修复可以走 C+ bypass，但必须在 24h 内补 PR，保证可追溯。

---

## 2. 分支模型

默认采用轻量模型：

```text
feature/fix/chore/docs/refactor/hotfix -> PR -> main
```

如果项目进入固定周期发布，允许增加发布分支：

```text
feature/fix/chore/docs/refactor -> PR -> develop -> release/* -> PR -> main
hotfix/* -> PR -> main -> 回合并 develop 或 release/*
```

分支用途：

| 分支 | 用途 | 规则 |
|------|------|------|
| `main` | 生产稳定分支 | 禁止普通开发直推，必须通过 PR 或合规 hotfix |
| `develop` | 可选集成分支 | 多人并行或固定发布周期时使用 |
| `feat/*` | 新功能 | 从 `main` 或 `develop` 拉出 |
| `fix/*` | 普通缺陷修复 | 从目标合并分支拉出 |
| `hotfix/*` | 线上紧急修复 | 从 `main` 拉出，合并后回同步 |
| `docs/*` | 文档修改 | 文档范围保持聚焦 |
| `refactor/*` | 重构 | 不混入业务行为变化 |
| `test/*` | 测试补充 | 可关联缺陷或质量任务 |
| `chore/*` | 配置、脚本、依赖、维护 | 说明影响范围 |
| `release/*` | 发布候选 | 只允许阻塞级修复、版本号、发布说明 |
| `codex/*` | AI 代理协助分支 | 用于 Codex 或其他 AI 代理生成/协助的变更 |
| `experiment/*` | 探索性实验 | 默认不保证合并 |

---

## 3. 什么时候开新分支

以下情况必须开新分支：

- 新功能开发：`feat/user-profile-editor`
- 普通 bug 修复：`fix/login-token-expiry`
- 线上紧急问题：`hotfix/payment-timeout`
- 文档更新：`docs/update-pr-workflow`
- 重构或迁移：`refactor/split-reviewer-service`
- 测试补充：`test/add-login-regression`
- 构建、依赖、配置调整：`chore/upgrade-actions`
- AI 代理协助的独立工作：`codex/improve-pr-dashboard`
- 不确定是否合并的探索：`experiment/new-search-ranking`

不允许直接在 `main` 上做普通开发提交。即使是小改动，也应走短分支和 PR。

---

## 4. 标准 PR 流程

```text
1. 从目标分支切出工作分支
   git checkout main
   git pull
   git checkout -b feat/your-feature-name

2. 开发并提交
   git commit -m "feat: add user profile editor"

3. 推送分支
   git push origin feat/your-feature-name

4. 开 Draft PR
   - 关联 Hub 任务 ID：task_xxx
   - 填写背景、变更内容、验收清单和风险
   - 需要早期设计反馈时保持 Draft

5. 完成自查后转 Ready for Review
   - 本地基础验证完成
   - 无明显调试代码和无关改动
   - PR 描述完整

6. GitHub Actions + PR-Agent 自动检查
   - lint / test / build / title / security 等检查
   - PR-Agent 输出 review comment
   - Hub 自动同步合规结果

7. 团队 review + 修改
   - 处理 blocker 和 changes requested
   - 所有 conversation resolve

8. 满足合并标准后合并到目标分支
   - 默认 squash merge
   - 合并后删除工作分支
   - Hub 晚会对账以该 PR 的 compliance 为依据
```

---

## 5. 什么时候开 PR

适合开 Draft PR：

- 方案已经确定，但代码尚未完成。
- 需要提前确认接口、架构、目录组织或交互方向。
- 改动影响多人协作，提前暴露上下文可以减少重复劳动。
- PR 预计较大，需要分阶段 review。
- 希望先让 CI、PR-Agent 和 Hub 跑起来。

适合转 Ready for Review：

- 主要功能已经完成。
- 作者已自查 diff。
- 本地关键验证已完成。
- PR 描述写清楚做了什么、为什么做、如何验证。
- 没有明显调试代码、临时代码和无关格式化。
- 验收清单、任务关联和风险说明已补齐。

---

## 6. PR 描述模板说明

PR 必须包含以下信息：

```md
## 背景

说明为什么需要这个改动。

## 变更内容

-
-
-

## 关联任务

任务：task_xxx

## 验收清单（AC）

- [ ] 用户可以登录
- [x] 接口返回 200
- [~] 边界情况需人工确认

## 验证方式

- [ ] 本地测试通过
- [ ] 单元测试通过
- [ ] 手动验证通过
- [ ] 已验证异常场景

## 风险点

-

## 截图 / 录屏 / 接口示例

如适用请补充。
```

AC 符号说明：

- `[x]` = 已完成，计入 `done` 桶。
- `[ ]` = 未完成，计入 `notDone` 桶。
- `[~]` = 需人工确认，计入 `needsHumanCheck` 桶，不直接计入完成。

任务关联说明：

- 任务 ID 必须使用 `task_xxx` 格式。
- 一个 PR 可以关联多个任务，每行填写一个 `task_xxx`。
- 没有关联任务的 PR 会在晚会对账中标记为“待关联任务”。

---

## 7. Commit 与 PR 标题

commit 和 PR 标题使用 Conventional Commit 风格：

```text
feat: add user profile editor
fix: correct token refresh timing
docs: update PR workflow
chore: upgrade GitHub Actions cache
```

允许前缀：

```text
feat:
fix:
docs:
refactor:
test:
chore:
perf:
ci:
build:
merge:
revert:
```

标题必须能说明“改了什么”或“解决什么问题”。禁止使用 `update`、`fix bug`、`改一下`、`changes`、`临时提交` 这类无法追溯的标题。

---

## 8. Review 规则

Review SLA：

| PR 优先级 | 首次响应 | 完成 review |
|------|------|------|
| Hotfix | 30 分钟内 | 1 小时内 |
| 高优先级业务功能 | 4 小时内 | 1 个工作日内 |
| 普通功能或 bugfix | 1 个工作日内 | 2 个工作日内 |
| 低优先级文档、重构、维护 | 2 个工作日内 | 3 个工作日内 |

Reviewer 重点看：

- 是否符合需求和验收标准。
- 是否引入安全、权限、认证、支付、数据删除、数据一致性风险。
- 边界条件、错误处理、空状态、加载状态是否完整。
- 是否破坏已有行为。
- 测试和人工验证是否覆盖关键路径。
- 命名、结构和抽象是否便于维护。
- PR 是否过大，是否应拆分。

Reviewer 不应把主要精力放在：

- formatter 可自动处理的格式问题。
- 与本 PR 无关的大型重构。
- 没有明确收益的个人风格偏好。

Reviewer 数量：

| 改动类型 | 要求 |
|------|------|
| 普通业务代码 | 至少 1 人 approve |
| 跨模块改动 | 至少 2 人 approve |
| 数据库 schema / 数据迁移 | 至少 2 人，其中 1 人为后端或负责人 |
| 权限 / 认证 / 支付 / 数据删除 | 至少 2 人，其中 1 人为资深成员或负责人 |
| CI/CD / 基础设施 / 部署配置 | DevOps 或负责人必须审 |
| Hotfix | 至少 1 人快速审阅，合并后补充复盘 |

PR 作者不能 approve 自己的 PR。

---

## 9. 合并规则

PR 合并前必须满足：

- GitHub Actions 必须通过。
- PR-Agent 或 Hub Review 无 Block / Escalate，或负责人明确豁免。
- 至少 1 名 Reviewer approve。
- 高风险改动满足额外 reviewer 要求。
- 所有 conversation 已 resolve。
- PR 描述、任务关联、AC checklist 和验证方式完整。
- 没有明显无关改动、调试代码、临时代码、密钥或私有凭据。
- 分支与目标分支无冲突。
- 涉及数据库、权限、支付、认证、部署配置的改动已明确说明影响范围和回滚方式。

合并方式：

| PR 类型 | 默认合并方式 |
|------|------|
| 普通 feature | Squash merge |
| 小 bugfix | Squash merge |
| 文档、配置、小维护 | Squash merge |
| 多提交有独立意义的大型迁移 | Merge commit |
| hotfix | Squash merge 或 Merge commit，优先可追溯 |

合并后：

- 删除远程工作分支。
- 关闭或更新关联任务。
- 如果是 hotfix 合入 `main`，必须同步回 `develop` 或当前 `release/*` 分支。
- 如涉及部署，记录发布版本、上线时间或变更说明。

---

## 10. PR 大小控制

| PR 大小 | 处理方式 |
|------|------|
| 1-200 行核心变更 | 理想大小 |
| 200-500 行核心变更 | 可接受，需描述清楚 |
| 500-1000 行核心变更 | 说明为什么不能拆 |
| 1000 行以上核心变更 | 默认要求拆分，生成文件或机械迁移除外 |

一个 PR 只解决一个主题。需要大改时优先拆成：

- 纯重构 PR。
- 类型、接口或基础结构准备 PR。
- 功能实现 PR。
- 测试和清理 PR。

---

## 11. GitHub Actions 流程

PR 触发：

```yaml
pull_request:
  types: [opened, synchronize, reopened, ready_for_review]
```

建议检查：

- 依赖安装与缓存。
- lint。
- format check。
- typecheck。
- unit test。
- build。
- PR 标题检查。
- secret scan。
- dependency audit。
- PR-Agent review。
- 自动 label。
- CODEOWNERS review。
- 前端 preview deploy，如项目支持。

当前仓库强制检查：

- `cue-github-policy.yml`：检查 commit / PR 标题、PR 描述必填章节、任务关联、AC checklist、测试说明、人工核查和风险说明。
- `pr-agent.yml`：在 PR 打开、重开、更新、Ready for Review、请求 review 时运行 PR-Agent；也支持在 PR 评论里手动触发 PR-Agent 指令。
- `main-push-policy.yml`：监控 `main` 直推并通知 Hub 记录 bypass。

PR-Agent 配置要求：

- 仓库必须配置 Actions secret：`ANTHROPIC_KEY`。
- 仓库建议配置 Actions variable：`HUB_URL`，或 secret：`CUE_HUB_URL`。
- 仓库如需写回 Hub，必须配置 secret：`CUE_API_KEY`。
- 默认模型为 `anthropic/claude-sonnet-4-20250514`，兜底模型为 `anthropic/claude-3-5-haiku-20241022`；可用仓库变量 `PR_AGENT_MODEL` 和 `PR_AGENT_FALLBACK_MODELS` 覆盖。
- PR-Agent workflow 必须显示成功，且 PR 页面应出现 `github-actions` / PR-Agent 评论。

合并到 `main` 后触发：

- lint / test / build 复跑。
- 生成 changelog 或 release note，如项目支持。
- 部署 staging 或 production，如项目支持。
- 通知企微、Slack 或其他团队渠道。
- 创建 release tag，如项目使用版本发布。

---

## 12. PR-Agent 的地位与人工核查

PR-Agent 的地位：

- PR-Agent 是自动审阅助手，负责给出代码风险、测试建议、改进建议和合规信号。
- Hub 使用 PR-Agent / Hub Review 的结果做晚会对账和风险展示。
- PR-Agent 不替代人工 reviewer，不拥有最终合并权。
- PR-Agent 的 Block / Escalate 默认阻断合并，除非负责人在 PR 中明确写明豁免理由。
- PR-Agent 没有评论、workflow 失败、secret 缺失或 Hub 未同步时，该 PR 视为自动审阅未完成。

人工核查步骤：

1. 打开 PR 的 `Checks` 页，确认 `Cue.AI GitHub 规则检查` 和 `PR-Agent Review` 都是绿色。
2. 打开 PR Conversation，确认有 PR-Agent 评论；没有评论时检查 Actions 日志。
3. 阅读 PR-Agent 的风险、测试建议和代码建议，判断是否需要作者修改。
4. 检查 PR 描述是否包含任务 ID、AC checklist、测试说明、人工核查和风险说明。
5. 按 PR 描述里的“测试说明”和“人工核查”逐项复验；UI 改动看截图或预览环境，接口改动看请求示例或日志。
6. 打开 Hub 的「PR 列表」，确认该 PR 已同步，Hub Review / PR-Agent 合规三桶符合预期。
7. 对 Block / Escalate 逐条处理；确需豁免时，在 PR 留言说明负责人、原因、影响范围和补救动作。
8. 所有 conversation resolved 后，Reviewer 才能 approve。

PR-Agent 工作正常的判定：

- PR-Agent workflow 在最近一次 PR 更新后成功完成。
- PR 页面出现自动 review 或 describe 评论。
- Hub PR 详情能看到该 PR 的合规结果。
- PR-Agent 的结论和人工核查没有明显矛盾。

PR-Agent 异常处理：

- workflow 未触发：检查 PR 是否为 Draft、触发事件是否在 `pr-agent.yml` 中、Actions 是否启用。
- workflow 失败且提示缺少 `ANTHROPIC_KEY`：在仓库 Settings 配置 Actions secret。
- workflow 成功但无评论：检查 `GITHUB_TOKEN` 权限、PR 是否来自受限 fork、PR-Agent 日志。
- Hub 未同步：检查 `HUB_URL` / `CUE_HUB_URL`、`CUE_API_KEY` 和 `/api/webhooks/pr-agent` 日志。
- PR-Agent 误判：Reviewer 在 PR 里说明依据，并在 Hub 点 “Pass” 或 “Escalate”。

---

## 13. 通过标准

代码标准：

- 没有明显重复逻辑。
- 命名清晰。
- 错误处理完整。
- 边界条件处理合理。
- 没有无关改动。
- 没有遗留 `console.log`、`debugger`、临时代码或测试账号。

测试标准：

- 新功能覆盖核心路径。
- Bugfix 优先补回归测试。
- 高风险逻辑覆盖边界测试。
- UI 改动提供截图、录屏或人工验证说明。

产品标准：

- 行为符合任务和 AC。
- 空状态、错误状态、加载状态合理。
- 不破坏已有关键流程。

工程标准：

- CI 通过。
- PR 描述完整。
- Reviewer approve。
- conversation 全部 resolve。
- 文档、配置或迁移说明已同步。

---

## 14. C+ bypass：Hotfix 直推 main

场景：线上紧急故障，来不及走完整 PR 流程。

操作步骤：

1. 从 `main` 切 `hotfix/xxx` 分支进行修复。
2. 完成最小修复和最小验证。
3. 可直接 push 到 `main`，Hub 会自动记录 bypass。
4. 24h 内在 GitHub 补开 PR 关联该 commit。
5. 超 24h 未补 PR，Hub 触发企微告警并 @负责人。
6. 合并或补 PR 后，同步回 `develop` 或当前 `release/*` 分支。
7. 事故结束后补充复盘：原因、影响、修复、后续预防。

注意：

- 只有 `hotfix/` 开头的分支才算合规 bypass。
- 普通功能开发不得借 hotfix 直推。
- Hotfix 可以简化部分非关键检查，但不能跳过 reviewer、基础构建和最小验证说明。

---

## 15. Release 分支流程

固定周期发布时使用 `release/*`：

```text
develop -> release/2026-05-25 -> main -> tag
```

Release 分支只允许：

- 阻塞级 bugfix。
- 版本号调整。
- 发布文档。
- 环境配置修正。

Release 分支不允许继续加入新功能。发布后：

- `release/*` 合并到 `main`。
- `release/*` 回合并到 `develop`。
- 创建版本 tag，例如 `v1.2.3`。
- 记录 release note。

---

## 16. 分支保护建议

`main` 建议启用：

- 禁止直接 push，hotfix bypass 由单独机制记录。
- 必须通过 PR 合并。
- 必须 CI 通过。
- 必须至少 1 个 approval。
- CODEOWNERS 必须通过，如项目配置。
- conversation 必须全部 resolve。
- 启用 merge queue 或要求分支与目标分支保持最新。
- 管理员也遵守保护规则，除非负责人明确豁免。

`develop` 建议启用：

- 禁止普通成员直接 push。
- 必须 CI 通过。
- 至少 1 个 approval。

---

## 17. Hub 晚会对账机制

每天 18:00 晚会，Hub 自动生成对账报告：

1. 取当日 merged PR。
2. 读 PR 的 `hubReview.compliance` 三桶：`done` / `notDone` / `needsHumanCheck`。
3. 计算任务进度：`done / (done + notDone + needsHumanCheck) * 100%`。
4. 推送企微作战包，包含已合并、待 review、Block 数。

如果 PR 没有关联任务，Hub 会单独列出并标注“待关联任务”。

---

## 18. 在 Hub 查看 PR 数据

打开 Hub（https://hub.cueai.top），点击导航栏「PR 列表」：

- 可按项目、状态、成员筛选。
- 点击 PR 卡片展开详情，查看 Hub Review 和 PR-Agent 的合规三桶。
- 「Pass」按钮：人工覆盖，标记为通过。
- 「Escalate」按钮：升级处理。

---

## 19. 常见问题

**Q: PR-Agent review comment 看不懂？**  
A: PR-Agent 用英文输出，Hub 做中文映射。可以在 Hub 的 PR 列表页看中文版合规结论。

**Q: 我的任务没有在晚会对账里出现？**  
A: 检查 PR 描述的“关联任务”字段是否填了 `task_xxx` 格式的 ID。

**Q: compliance 三桶和我实际情况不符？**  
A: 在 Hub PR 详情页点“Pass”人工覆盖，或联系 Hub 管理员修正。

**Q: 可以一个 PR 关联多个任务吗？**  
A: 可以，在“关联任务”字段填多行 `task_xxx`。Hub 会把该 PR 的 compliance 同时关联所有任务。

**Q: 直推 main 的 commit 会怎样？**  
A: Hub 记录 bypass 并给 24h 补 PR 的窗口期。普通功能开发必须开 PR，hotfix 场景才用直推。
