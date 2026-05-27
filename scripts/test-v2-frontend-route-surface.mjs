import assert from 'node:assert/strict';
import { toV2RequestPath } from '../src/api/httpClient.js';
import { toLegacyApiUrl } from '../server/v2/appFacade.js';

const frontendApiSurface = [
  '/api/auth/login',
  '/api/auth/email-code',
  '/api/auth/phone-code',
  '/api/auth/me',
  '/api/auth/users?projectId=cue_ai_classroom',
  '/api/projects',
  '/api/projects/cue_ai_classroom/transfer-founder',
  '/api/projects/cue_ai_classroom/sync-docs?limit=20',
  '/api/projects/cue_ai_classroom/update-docs',
  '/api/projects/cue_ai_classroom/daily-scan',
  '/api/config',
  '/api/state?projectId=cue_ai_classroom',
  '/api/stage/checklist?projectId=cue_ai_classroom',
  '/api/stage/checklist/node_1',
  '/api/stage/reset-roadmap',
  '/api/tasks',
  '/api/tasks/task_1',
  '/api/tasks/ai-progress',
  '/api/tasks/cleanup',
  '/api/assignments',
  '/api/assignments/assignment_1',
  '/api/assignments/assignment_1/brief',
  '/api/plans',
  '/api/plans/apply',
  '/api/standups',
  '/api/standups/summarize',
  '/api/reports/evening',
  '/api/reports/daily',
  '/api/reports/compare?date=2026-05-28',
  '/api/reports/meeting-summary',
  '/api/attendance/weekly?projectId=cue_ai_classroom&date=2026-05-28',
  '/api/attendance/records',
  '/api/scoring/daily?projectId=cue_ai_classroom',
  '/api/scoring/weekly?projectId=cue_ai_classroom',
  '/api/reviews/queue',
  '/api/reviews/review_1/solutions',
  '/api/reviews/review_1/resolve',
  '/api/pulls?projectId=cue_ai_classroom&state=open',
  '/api/pulls/pull_1/decision',
  '/api/pulls/pull_1/merge',
  '/api/pulls/pull_1/auto-merge-check',
  '/api/plan-adjustments',
  '/api/plan-adjustments/adjustment_1/alternatives',
  '/api/plan-adjustments/adjustment_1/decision',
  '/api/recommendations?date=2026-05-28',
  '/api/recommendations/refresh',
  '/api/recommendations/task_1/accept',
  '/api/risks/scan',
  '/api/wecom/push',
  '/api/ai/refresh-analysis',
];

for (const legacyPath of frontendApiSurface) {
  const expectedV2Path = `/v2/app${legacyPath.slice('/api'.length)}`;
  assert.equal(toV2RequestPath(legacyPath), expectedV2Path, `${legacyPath} should use v2 app facade`);

  const v2Url = new URL(`http://localhost${expectedV2Path}`);
  const legacyUrl = toLegacyApiUrl(v2Url);
  assert.equal(`${legacyUrl.pathname}${legacyUrl.search}`, legacyPath, `${expectedV2Path} should route back to legacy handler`);
}

for (const nativeV2Path of [
  '/v2/events/stream',
  '/v2/observability/llm',
  '/v2/space',
  '/v2/tasks/task_1/explanation',
]) {
  assert.equal(toV2RequestPath(nativeV2Path), nativeV2Path, `${nativeV2Path} should stay on native v2`);
}

console.log('V2 frontend route surface OK');
