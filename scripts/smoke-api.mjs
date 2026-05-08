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
    validate: (json) => Array.isArray(json?.tasks) && json?.metrics && json?.stageChecklist
  },
  {
    path: '/api/tasks',
    validate: (json) => Array.isArray(json?.tasks)
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
