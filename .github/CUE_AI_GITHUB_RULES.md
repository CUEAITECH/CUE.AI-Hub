# Cue.AI GitHub 协作规则

本文档是 Cue.AI 所有 GitHub 仓库的统一协作规则。除非负责人明确豁免，所有项目、分支、commit、PR、review 和发布都遵守这里的标准。

## 1. 仓库原则

- 课堂产品、项目中枢、实验工具必须保持独立仓库，不把无关产品线混在一起。
- 仓库名必须能表达产品或模块边界，例如 `CUE-Project-Hub`。
- `README.md` 必须用中文说明产品定位、运行方式、核心 API 和协作规则。
- 不把本地运行数据、日志、密钥、临时构建产物提交进仓库。

## 2. 分支原则

分支命名使用：

```text
类型/简短目标
```

推荐类型：

- `feat/`：新功能
- `fix/`：缺陷修复
- `docs/`：文档
- `refactor/`：重构
- `test/`：测试
- `chore/`：配置、脚本、维护
- `release/`：发布准备
- `codex/`：AI 代理生成或协助的工作分支

示例：

```text
feat/github-webhook-sync
fix/review-risk-score
docs/github-rules
codex/cue-project-hub-mvp
```

## 3. Commit 原则

commit 标题必须使用以下前缀之一：

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

推荐格式：

```text
类型: 动词 + 对象 + 结果
```

好例子：

```text
feat: add Cue.AI local Git sync panel
fix: handle Chinese filenames in git status parser
docs: add Cue.AI GitHub collaboration rules
```

坏例子：

```text
update
fix bug
改一下
changes
临时提交
```

强制要求：

- 标题必须说明为什么改或改了什么。
- 高风险提交必须在正文或 PR 描述里说明影响范围。
- 涉及任务交付的 commit 应关联任务、issue、PR 或阶段目标。
- 不允许把多个无关目标塞进一个 commit。

## 4. PR 原则

每个 PR 必须回答：

- 做了什么
- 为什么做
- 影响哪些用户、模块或流程
- 如何验证
- 是否存在风险或未完成事项

PR 合并前必须满足：

- 没有明显无关改动
- 没有密钥、token、密码、私有证书
- AI Review 无阻断项，或负责人明确豁免
- 高风险模块有测试说明或人工审阅说明
- 大 PR 已说明为什么不能拆分

## 5. AI Review 原则

AI Review 负责发现风险，不替代最终责任人。

阻断级问题包括：

- 可能泄露密钥、token、密码、隐私数据
- 认证、权限、支付、数据删除逻辑缺少说明或测试
- 大范围改动没有验收标准
- 提交内容与任务目标明显不一致
- PR 无法解释影响范围

AI Review 结论分级：

- `通过`：无明显问题，可以进入人工审阅
- `提醒`：存在小问题，不默认阻断
- `阻断`：高风险，默认禁止合并
- `升级`：需要技术负责人或项目负责人处理

## 6. 项目中枢使用原则

- 每个关键任务必须在 CUE 项目中枢中有记录。
- 每个任务必须有负责人、截止时间、验收标准。
- 任务进度优先从 Git、PR、Review、CI 和站会信号自动获得。
- 成员少填表，但必须及时标记阻塞、延期和请假交接。
- 任务临近截止且没有 Git 信号时，系统可以自动提醒。

## 7. 安全原则

禁止提交：

- API Key
- OAuth token
- 密码
- 私钥
- 真实用户隐私数据
- 未脱敏日志
- 本地数据库
- 临时构建产物

发现安全问题时，优先撤销凭据，再修复代码。
