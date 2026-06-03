# ADR-003: Browser Agent 选型

**日期**: 2026-06-03  
**状态**: draft（Phase 3 实施前确认）  
**决策人**: 待定

---

## 背景

SPEC-L5 需要选一个 browser automation 框架驱动 E2 测试。候选：Skyvern / browser-use / Stagehand。

## 候选方案对比

| 维度 | Skyvern | browser-use | Stagehand |
|---|---|---|---|
| **原理** | 截图 + Vision LLM 识别元素 | Python + Playwright + LLM | Playwright + act/extract/observe |
| **语言** | Python（有 API 可调）| Python | TypeScript ✅ |
| **无需了解 DOM** | ✅ | ⚠️ 部分 | ✅ |
| **未见过的网站** | ✅（vision-based）| ⚠️ | ✅ |
| **WebVoyager 成绩** | 85.85%（2.0）| — | — |
| **开源** | ✅ MIT | ✅ | ✅ |
| **维护活跃度** | 高 | 高 | 高（Browserbase 背）|
| **CUE 技术栈兼容** | 需 Python sidecar | 需 Python sidecar | **Node.js ✅ 直接接入** |
| **音视频测试** | ❌ | ❌ | ❌（所有工具都做不到）|

## 推荐

**Stagehand** — 理由：
1. TypeScript / Node.js，无需额外 Python sidecar，直接接入 CUE 的 Node.js 服务
2. `act()` / `extract()` / `observe()` 三个原语，干净简洁
3. 支持 Claude / GPT-4 / Gemini，与 CUE 现有 LLM 配置对齐
4. Browserbase 背景，维护有保障

**备选 Skyvern** — 如果需要处理复杂的、从未见过的 UI（Skyvern WebVoyager 85.85% 更高）。

## 待确认（Phase 3 前）

- CUE 的 LLM 配置是 OpenAI 还是 Claude？Stagehand 两者都支持，但需要确认调用成本
- 测试环境是否有稳定的 staging URL？
- 每次测试的预算上限？
