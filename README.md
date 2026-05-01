# CUE Project Hub

CUE 项目中枢是独立于 CUE 课堂产品的新产品线，目标是用 AI 管理研发交付闭环：阶段目标拆解、任务分工、Git 活动追踪、AI 提交审阅、异步站会、风险检测与自动提醒。

## Product Positioning

CUE Project Hub is an AI-native project command center for small technical teams.

It should reduce management overhead instead of adding another reporting burden:

- Pull real signals from Git commits, pushes, PRs, reviews, CI, and standup replies.
- Detect delivery risks automatically.
- Generate task plans from stage goals.
- Review each PR or meaningful push with AI.
- Escalate only when a risk is actionable.

## MVP Scope

- AI stage goal planner
- Delivery board with owner, due date, progress, Git signal, and risk
- AI code review queue
- Team load and response dashboard
- Automation rules for reminders and escalation
- Local Node API with JSON persistence
- GitHub webhook receiver for push, PR, and review events
- Heuristic AI Review and risk engine, ready to replace with a real LLM provider

## Local Preview

```bash
npm run dev
```

Then open:

```text
http://localhost:4317
```

No install step is required for the current MVP because it uses only Node built-in modules.

## API Surface

- `GET /api/state`: full dashboard state
- `POST /api/tasks`: create a task
- `PATCH /api/tasks/:id`: update a task
- `POST /api/plans`: generate tasks from a stage goal
- `POST /api/plans/apply`: apply generated tasks to the delivery board
- `POST /api/reviews`: run AI Review on a title, diff, repo, files, and owner
- `POST /api/risks/scan`: scan tasks and reviews for reminders
- `POST /api/webhooks/github`: receive GitHub webhook events

## GitHub Webhook

Set the webhook URL to:

```text
http://your-host/api/webhooks/github
```

Recommended events:

- `push`
- `pull_request`
- `pull_request_review`

Optional signature verification:

```bash
GITHUB_WEBHOOK_SECRET=your_secret npm run dev
```

## Current AI Behavior

The first version uses deterministic rules so the product works locally without API keys:

- Planning engine maps goal keywords to tasks, owners, due dates, dependencies, and acceptance criteria.
- Review engine scores diffs for secrets, auth/payment/permission changes, missing tests, debug statements, large PRs, and missing task links.
- Risk engine detects overdue tasks, low progress near deadline, 24h inactivity, missing Git references, and blocked reviews.
- Cue.AI internal pilot sync scans the local `OmniNexus-Edu-copilot` Git repo, imports recent commits, tracks working-tree changes, maps commit authors to team members, and creates AI Review records for synced commits.

The next step is to add an LLM adapter behind these engines while keeping rule-based checks as fallback.

## Cue.AI Internal Pilot

The default project is:

```text
Cue.AI Classroom -> /Users/dirtortian/Documents/GitHub/OmniNexus-Edu-copilot
```

From the dashboard, click `同步 Cue.AI Git` to:

- read the current branch
- read recent commits from the local repository
- detect uncommitted working-tree files
- map known Git authors to team members
- generate AI Review results for each synced commit
- refresh project health, risk queue, and activity stream

## Proposed Product Split

- `OmniNexus-Edu-copilot`: CUE classroom / education product
- `CUE-Project-Hub`: CUE 项目中枢 / AI研发管理产品

These should remain separate repositories, separate roadmaps, and separate deployments.
