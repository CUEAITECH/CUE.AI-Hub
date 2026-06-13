# L1 需求澄清前端模块 — 设计文档

**日期**：2026-06-12
**作者**：Claude + 田家铭
**关联后端**：`server/services/prdClarifier.js`（SPEC-L1，已实现并通过 mock exam）

## 目标

为 SPEC-L1（想法 → 澄清反问 → 结构化 PRD）提供一个最小可用的前端界面，让团队能在浏览器里真实跑通 `clarify → generate-prd → refine` 三步流程，验证功能而非仅靠脚本/API 测试。

范围限定为**单模块功能测试**：先确认流程在浏览器中可用，不接入全局数据流，不为 L2 链路预先铺路。

## 非目标

- 不接入全局 `state`，不为 L2（PRD → 任务拆解）预留数据通路（验证 OK 后再单独决定）。
- 不做 PRD 历史列表展示（`GET /v2/app/prds` 暂不接前端）。
- 不做移动端适配优化（沿用现有响应式即可）。
- 不改动 ai-pm 页现有的"规划调整"功能。

## 三项已确认的设计决策

1. **位置**：扩展现有 `ai-pm` 视图，顶部加 Tab 切换（`规划调整` | `需求澄清`），不新增侧边栏路由。
2. **步骤布局**：手风琴（Accordion）——三步始终可见，完成当前步后下一步自动展开，已完成步骤折叠但可点开回看。
3. **PRD 展示**：单列分区卡片（标题/目标/验收条件/范围/不做/风险 + 折叠的用户故事），下方跟修改意见 textarea + 保存草稿 / 提交修改按钮。

## 架构

### 新增文件

```
src/api/prdApi.js                        ← 4 个后端调用封装
src/features/ai-pm/prdClarifierPanel.js  ← 手风琴 UI + 全部交互逻辑（自包含模块）
```

### 修改文件

```
index.html   ← ai-pm section 顶部加 Tab 栏 + 两个内容区（现有"规划调整"包一层 + 新"需求澄清"骨架）
src/app.js   ← import initPrdClarifierPanel；ai-pm 路由激活时调用一次 init
```

### 组件边界

- **`prdApi.js`** — 纯数据层。输入参数，返回后端 JSON。依赖现有 `httpClient.js` 的 `client` 单例（与其他 api/ 文件一致）。不含 UI 逻辑。
- **`prdClarifierPanel.js`** — 自包含 UI 模块。导出 `initPrdClarifierPanel()`（绑定一次事件 + 渲染初始态）。内部维护私有 state，不向外暴露数据。依赖 `prdApi.js`。
- **`index.html` 骨架** — 静态 DOM 容器（手风琴三段 + Tab 栏），由 JS 填充内容。

## 数据流

模块内 3 个私有变量（不进全局 `state`）：

```js
let _input = '';          // Step 1 用户输入的想法
let _clarifyResult = null;// { clarificationQuestions[], initialUnderstanding }
let _prd = null;          // 完整 PRD 对象（含 id，refine 时回传）
```

流程：

```
Step 1 (描述想法)
  └─ 点"开始澄清" → clarify(_input) → _clarifyResult
       └─ Step 2 解锁并展开，渲染问题列表（每题一个 textarea）

Step 2 (回答澄清问题)
  └─ 点"生成 PRD" → 收集 answers → generatePrd(_input, answers) → _prd
       └─ Step 3 解锁并展开，渲染 PRD 卡片

Step 3 (PRD 预览 + 修改)
  └─ 填修改意见 → 点"提交修改" → refinePrd(_prd.id, feedback) → _prd（原地更新重渲染）
```

切走 Tab / 刷新页面 → 私有 state 丢失，需重新生成（测试场景可接受）。

## API client（prdApi.js）

| 方法 | 端点 | 请求体 | 响应（需解包） |
|------|------|--------|----------------|
| `clarify(input)` | POST `/v2/app/ai/clarify` | `{ input }` | `{ clarificationQuestions[], initialUnderstanding }`（直接返回，无包裹） |
| `generatePrd(input, answers)` | POST `/v2/app/ai/generate-prd` | `{ input, answers }` | `{ prd }` → 取 `.prd`（201） |
| `refinePrd(id, feedback)` | PATCH `/v2/app/prd/:id` | `{ feedback }` | `{ prd }` → 取 `.prd`（200） |
| `listPrds()` | GET `/v2/app/prds` | — | `{ prds }` → 取 `.prds`（本期不接 UI，保留） |

注意三个端点响应封装不一致：clarify 裸返回，其余包在 `{ prd }` / `{ prds }` 里，client 各自解包。`generatePrd` 的 `answers` 为 `{ [问题]: 回答 }` 字典；后端会 upsert 进 `store.prds`，但前端本期不读全局列表。

所有调用经 `client.request(path, { method, body })`，自动注入 apiKey/session 头。

## Tab 切换

ai-pm 视图标题下加一行 Tab 栏：

```html
<div class="ai-pm-tabs">
  <button data-aipm-tab="planning" class="active">规划调整</button>
  <button data-aipm-tab="clarifier">需求澄清</button>
</div>
```

点击切换两个内容区的 `hidden` 属性。纯前端切换，不经 `setRoute`，不新增路由。现有"规划调整"内容（summary + grid）整体包进 `#aipmTabPlanning`。

## 手风琴交互（Step 解锁规则）

- 每段有状态：`locked`（灰、不可点）/ `active`（展开、可操作）/ `done`（折叠、可点开回看）。
- 初始：Step 1 = active，Step 2/3 = locked。
- 完成一步后：当前步 → done（折叠），下一步 locked → active（展开）。
- 点击 done 状态的步骤头 → 展开回看（不改变后续步骤状态）。
- 重新提交上游步骤（如重新澄清）→ 下游步骤数据作废，回到 locked。

## PRD 卡片字段（Step 3）

```
标题       _prd.title
目标       _prd.goal
验收条件   _prd.acceptance[]      （无序列表）
范围       _prd.scope[]
不做       _prd.nonGoals[]
风险       _prd.risks[]
用户故事   _prd.userStories[]     （默认折叠，点击展开：as/want/so/acceptance）
```

字段缺失时显示"—"占位，不报错。

## 错误处理

- API 调用失败（网络/401/500）：在当前步骤区显示红色错误提示，按钮恢复可点，不阻塞其他步骤。
- 后端降级（无 LLM key）：后端已有 fallback 返回固定问题/占位 PRD，前端正常渲染，无需特殊处理。
- 防重复提交：每个动作按钮在请求进行中禁用并显示"处理中…"，复用 app.js 现有 `once()` 模式或模块内简易 flag。
- 空输入：Step 1 想法为空时"开始澄清"按钮禁用。

## 测试方式

1. 启动服务 `npm run dev`，浏览器登录进 ai-pm 页。
2. 切到"需求澄清"Tab，输入"做一个让用户能给视频打标签的功能"。
3. 验证 Step 1→2→3 手风琴逐步解锁，clarify 返回 3-5 个问题，PRD 字段完整且 acceptance ≠ goal。
4. 提交一条修改意见，验证 PRD 原地更新。
5. 对照 `scripts/mock-exam-l1.mjs` 的输出，确认前端展示与后端返回一致。

无需新增自动化测试（后端 AC 已由 `scripts/test-l1-business.mjs` + `scripts/mock-exam-l1.mjs` 覆盖）。本模块是 UI 验证层。
