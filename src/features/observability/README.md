# Observability

Observability owns LLM ledger, event inspection, sync health, and SPACE health signals.

Use `observabilityApi` for all `/v2/observability/*` and `/v2/space` calls. Screens in this feature should be read-heavy, tenant-aware, and isolated from command-center mutation flows.
