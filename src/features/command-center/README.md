# Command Center

Command Center owns the signed-in project cockpit: session entry, project selection, state bootstrap, metrics, stage status, roadmap, and cross-view refresh orchestration.

Frontend code in this area should consume v2 facade-backed domain APIs from `src/api/` and shared state helpers from `src/state/`. It should not build legacy `/api/*` fetch calls directly.
