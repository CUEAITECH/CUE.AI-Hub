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
      && (json.stageChecklist.checklist || []).every((item) => item.binding?.mode && item.binding?.label)
    )
  },
  {
    path: '/api/state?projectId=cue_ai_classroom',
    validate: (json) => (
      json?.currentProjectId === 'cue_ai_classroom'
      && Array.isArray(json?.projects)
      && Array.isArray(json?.tasks)
      && Array.isArray(json?.deliverables)
      && json?.stageChecklist
    )
  },
  {
    path: '/api/stage/checklist',
    validate: (json) => {
      const nodes = json?.nodes || json?.checklist || [];
      return Array.isArray(nodes) && nodes.every((item) => item.binding?.mode && item.binding?.strength);
    }
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
