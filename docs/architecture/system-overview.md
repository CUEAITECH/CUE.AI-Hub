# System Overview — CUE Agentic SDLC

## Architecture

```mermaid
flowchart TD
    User([User Input\nidea / meeting notes / feedback])
    L1[L1: Clarification\nidea → PRD]
    L2[L2: Task Schema\nPRD → Milestones + Tasks]
    L3[L3: PR Automation\nTask → Branch + Draft PR]
    Repo[(Target Repo\ncommits / PRs / file tree / diffs)]
    L4[L4: Real-time Monitoring\ncommit status · diff risk · gap analysis · PR checklist]
    L5[L5: Browser Agent\ntest like a human]
    E1([E1: commit/PR → task status])
    E2([E2: test result → business verified])
    E3([E3: diff risk → block / fix task])
    E4([E4: completion → replan milestone])
    E5([E5: delivery → next iteration])

    User --> L1
    L1 --> L2
    L2 --> L3
    L3 --> Repo
    Repo --> L4
    Repo --> L5
    L4 --> E1
    L4 --> E3
    L5 --> E2
    E1 --> E4
    E2 --> E4
    E3 --> E4
    E4 --> L2
    E4 --> E5
    E5 --> L1
```

## Data Flow

```mermaid
sequenceDiagram
    participant U as User
    participant L1 as L1 Clarify
    participant L2 as L2 Tasks
    participant L3 as L3 PR
    participant R as Target Repo
    participant L4 as L4 Monitor
    participant L5 as L5 Browser
    participant E as Edges (E1-E5)

    U->>L1: fuzzy idea / meeting notes
    L1->>U: 3-5 clarifying questions
    U->>L1: answers
    L1->>L2: structured PRD
    L2->>L3: milestones + task tree
    L3->>R: create branch + draft PR
    R->>L4: webhooks (PR merged / opened)
    L4->>E: E1 (task complete) + E3 (diff risk)
    L3->>L5: acceptance criteria
    L5->>R: browser test run
    R-->>L5: test results
    L5->>E: E2 (business verified?)
    E->>L2: E4 replan (incremental update)
    E->>L1: E5 next iteration seed
```

## Module Mapping (Code → Spec)

| Spec | Code File | Status |
|---|---|---|
| L1 | `server/services/prdClarifier.js` (new) | ❌ not built |
| L2 | `server/services/docsManager.js` (rewrite schema) | ⚠️ refactor |
| L3 | `server/services/githubApi.js` (extend) | ⚠️ extend |
| L4-c | `server/services/gapAnalyzer.js` (new) | ❌ not built |
| L5 | `server/services/browserTestRunner.js` (new) | ❌ not built |
| E1 | `server/services/semanticLinker.js` (add state write-back) | ⚠️ extend |
| E2 | `server/services/testResultLinker.js` (new) | ❌ not built |
| E3 | `server/services/reviewTaskLinker.js` (new, <50 lines) | ❌ not built |
| E4 | `server/services/replanEvaluator.js` (new) | ❌ not built |
| E5 | `server/services/dailyBrief.js` (extend milestone retro) | ⚠️ extend |

## Implementation Phases

```mermaid
gantt
    title CUE Agentic SDLC — Build Sequence
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Phase 1 — Stop the bleeding (8-10w)
    E1  commit→task status     :crit, e1, 2026-06-10, 3w
    E3  diff risk→fix task     :crit, e3, 2026-06-10, 2w
    L2  task schema v2         :crit, l2, 2026-06-10, 4w

    section Phase 2 — Close the loop (12-16w)
    L1  clarification→PRD      :l1, after l2, 3w
    L4c gap analysis           :l4, after e1, 6w
    E4  replan milestones      :e4, after l4, 6w

    section Phase 3 — Moat (16-24w)
    L5  browser agent          :l5, after e4, 8w
    E2  business verified      :e2, after l5, 3w
    E5  iteration loop         :e5, after e2, 2w
```

## Dependency Graph

```mermaid
graph LR
    L1 --> L2
    L2 --> L3
    L3 --> Repo[(Repo)]
    Repo --> E1
    Repo --> E3
    Repo --> L4c[L4-c gap]
    Repo --> L5
    L5 --> E2
    E1 --> E4
    E3 --> E4
    E2 --> E4
    E4 --> E5
    E5 --> L1

    style E1 fill:#d4edda
    style E3 fill:#d4edda
    style L2 fill:#d4edda
```

> Green nodes = Phase 1 priority (strongest seed, stop the bleeding first)
