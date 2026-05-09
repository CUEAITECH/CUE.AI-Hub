const baseUrl = process.env.CUE_SMOKE_BASE_URL || 'http://127.0.0.1:4317';

const checks = [
  {
    path: '/api/health',
    validate: (json) => json?.ok === true
  },
  {
    path: '/api/config',
    validate: (json) => Object.hasOwn(json || {}, 'githubEnabled')
  },
  {
    path: '/api/state',
    validate: (json) => (
      Array.isArray(json?.tasks)
      && Array.isArray(json?.deliverables)
      && Array.isArray(json?.phases)
      && json?.metrics
      && json?.stageChecklist
      && Array.isArray(json?.deliverableProgress?.deliverables)
    )
  },
  {
    path: '/api/stage/checklist',
    validate: (json) => Array.isArray(json?.nodes) || Array.isArray(json?.checklist)
  },
  {
    path: '/api/tasks',
    validate: (json) => Array.isArray(json?.tasks)
  },
  {
    path: '/api/projects',
    validate: (json) => Array.isArray(json?.projects)
  },
  {
    path: '/api/assignments',
    validate: (json) => Array.isArray(json?.assignments)
  },
  {
    path: '/api/standups',
    validate: (json) => Array.isArray(json?.standups)
  },
  {
    path: '/api/reports/evening',
    validate: (json) => Object.hasOwn(json || {}, 'date')
  },
  {
    path: '/api/wecom/tasks',
    validate: (json) => typeof json?.summary === 'string' && Array.isArray(json?.tasks)
  },
  {
    path: '/api/wecom/summary',
    validate: (json) => typeof json?.summary === 'string' && json?.metrics
  },
  {
    path: '/api/reviews/queue',
    validate: (json) => Array.isArray(json?.queue)
  },
  {
    path: '/api/plan-adjustments',
    validate: (json) => Array.isArray(json?.adjustments)
  }
];

for (const check of checks) {
  const url = new URL(check.path, baseUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${check.path} returned HTTP ${response.status}`);
  }
  const json = await response.json();
  if (!check.validate(json)) {
    throw new Error(`${check.path} returned unexpected payload`);
  }
  console.log(`ok ${check.path}`);
}
