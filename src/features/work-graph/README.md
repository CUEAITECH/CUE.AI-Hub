# Work Graph

Work Graph owns task, assignment, deliverable, stage, scoring, attendance, and recommendation views.

The feature boundary is the project work model rather than a single screen. New work should route API calls through `tasksApi` or `appStateApi`, then normalize UI mutations through the store helpers before rendering.
