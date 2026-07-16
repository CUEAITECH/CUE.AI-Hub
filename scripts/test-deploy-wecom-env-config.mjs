import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile('.github/workflows/deploy.yml', 'utf8');
const configureIndex = workflow.indexOf('Configure WeCom env');
const restartIndex = workflow.indexOf('Restart PM2');

assert.ok(configureIndex > 0, 'deploy workflow must configure WeCom env before restart');
assert.ok(restartIndex > configureIndex, 'WeCom env must be configured before PM2 restart');
assert.match(workflow, /secrets\.WECOM_WEBHOOK_URL/, 'deploy workflow must read WECOM_WEBHOOK_URL secret');
assert.match(workflow, /secrets\.WECOM_ATTENDANCE_WEBHOOK_URL/, 'deploy workflow must read WECOM_ATTENDANCE_WEBHOOK_URL secret');
assert.match(workflow, /\.env/, 'deploy workflow must update the server .env file');
assert.match(workflow, /WECOM_WEBHOOK_URL/, 'deploy workflow must write the default WeCom webhook env');
assert.match(workflow, /WECOM_ATTENDANCE_WEBHOOK_URL/, 'deploy workflow must write the attendance WeCom webhook env');

console.log('deploy WeCom env config OK');
