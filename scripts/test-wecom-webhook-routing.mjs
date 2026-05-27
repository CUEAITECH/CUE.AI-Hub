import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const previous = {
  defaultUrl: process.env.WECOM_WEBHOOK_URL,
  attendanceUrl: process.env.WECOM_ATTENDANCE_WEBHOOK_URL,
};

try {
  process.env.WECOM_WEBHOOK_URL = `http://127.0.0.1:${port}/default`;
  process.env.WECOM_ATTENDANCE_WEBHOOK_URL = `http://127.0.0.1:${port}/attendance`;

  const { isWeComAvailable, resolveWeComWebhookUrl, sendWeComMarkdown } = await import(`../server/services/wecom.js?routing=${Date.now()}`);

  assert.equal(isWeComAvailable(), true);
  assert.equal(isWeComAvailable('attendance'), true);
  assert.equal(resolveWeComWebhookUrl().channel, 'default');
  assert.equal(resolveWeComWebhookUrl('attendance').channel, 'attendance');

  assert.equal(await sendWeComMarkdown('daily report'), true);
  assert.equal(await sendWeComMarkdown('attendance prompt', { channel: 'attendance' }), true);

  assert.equal(received.length, 2);
  assert.equal(received[0].url, '/default');
  assert.equal(received[1].url, '/attendance');
  assert.equal(received[0].body.markdown.content, 'daily report');
  assert.equal(received[1].body.markdown.content, 'attendance prompt');

  delete process.env.WECOM_ATTENDANCE_WEBHOOK_URL;
  assert.equal(resolveWeComWebhookUrl('attendance').channel, 'default');
  assert.equal(isWeComAvailable('attendance'), true);

  delete process.env.WECOM_WEBHOOK_URL;
  process.env.WECOM_ATTENDANCE_WEBHOOK_URL = `http://127.0.0.1:${port}/attendance-only`;
  assert.equal(isWeComAvailable(), false);
  assert.equal(isWeComAvailable('attendance'), true);
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (previous.defaultUrl === undefined) delete process.env.WECOM_WEBHOOK_URL;
  else process.env.WECOM_WEBHOOK_URL = previous.defaultUrl;
  if (previous.attendanceUrl === undefined) delete process.env.WECOM_ATTENDANCE_WEBHOOK_URL;
  else process.env.WECOM_ATTENDANCE_WEBHOOK_URL = previous.attendanceUrl;
}

console.log('WeCom webhook routing OK');
