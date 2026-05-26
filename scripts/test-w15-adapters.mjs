/**
 * test-w15-adapters.mjs
 * W15: Slack / Feishu 适配器单元测试
 * 运行：node scripts/test-w15-adapters.mjs
 * （不需要真实 webhook，用 mock 网络层测试）
 */

import { NotificationAdapter } from '../server/adapters/base.js';
import { SlackAdapter } from '../server/adapters/slack.js';
import { FeishuAdapter } from '../server/adapters/feishu.js';
import {
  initAdapters,
  getAllAdapters,
  getPrimaryAdapter,
  broadcast,
  broadcastCard,
  registerAdapter,
} from '../server/adapters/index.js';

// ─── test helpers ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✗\x1b[0m ${label}`);
    failed++;
  }
}

function assertEq(a, b, label) {
  if (a === b) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✗\x1b[0m ${label} — got: ${JSON.stringify(a)}, expected: ${JSON.stringify(b)}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[36m[${name}]\x1b[0m`);
}

// ─── Mock 网络层 ──────────────────────────────────────────────────────────────
// 拦截 SlackAdapter 和 FeishuAdapter 的 _postWebhook / _send 方法
// 让它们返回指定结果而不发真实网络请求

function mockSend(adapter, returnValue = true) {
  const captured = { calls: [] };

  if (adapter instanceof SlackAdapter) {
    adapter._sendViaWebhook = async (payload) => {
      captured.calls.push({ type: 'webhook', payload });
      return returnValue;
    };
    adapter._sendViaApi = async (payload, channel) => {
      captured.calls.push({ type: 'api', payload, channel });
      return returnValue;
    };
  } else if (adapter instanceof FeishuAdapter) {
    adapter._postWebhook = async (payload) => {
      captured.calls.push({ payload });
      return returnValue;
    };
  }

  return captured;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
console.log('  W15 Slack / Feishu 适配器 测试');
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');

// ─── Step 1: NotificationAdapter 基类接口 ────────────────────────────────────
section('Step 1: NotificationAdapter 基类接口');

const base = new NotificationAdapter();
assertEq(base.name, 'base', 'base.name = "base"');
assert(!base.isAvailable(), 'base.isAvailable() = false');

let errorThrown = false;
try { await base.sendMarkdown('test'); } catch (e) { errorThrown = true; }
assert(errorThrown, 'base.sendMarkdown 抛出 not implemented');

// sendCard 降级为 sendMarkdown（base 实现）
// 不能直接测试 base.sendCard（会调 sendMarkdown 然后抛出）
// 只验证接口存在
assert(typeof base.sendCard === 'function', 'base.sendCard 方法存在');
assert(typeof base.resolveHandle === 'function', 'base.resolveHandle 方法存在');

// ─── Step 2: SlackAdapter — isAvailable ──────────────────────────────────────
section('Step 2: SlackAdapter — isAvailable');

const slackNoConfig = new SlackAdapter({ webhookUrl: null, botToken: null });
assert(!slackNoConfig.isAvailable(), '无配置时 isAvailable=false');

const slackWithWebhook = new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/test' });
assert(slackWithWebhook.isAvailable(), '有 webhookUrl 时 isAvailable=true');

const slackWithToken = new SlackAdapter({ botToken: 'xoxb-test-token' });
assert(slackWithToken.isAvailable(), '有 botToken 时 isAvailable=true');

assertEq(slackWithWebhook.name, 'slack', 'name = "slack"');

// ─── Step 3: SlackAdapter — sendMarkdown 格式转换 ────────────────────────────
section('Step 3: SlackAdapter — sendMarkdown 格式转换');

const slack = new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/test' });
const captured3 = mockSend(slack, true);

const ok3 = await slack.sendMarkdown('**Hello** World\n[Click](https://example.com)');
assert(ok3 === true, 'sendMarkdown 返回 true');
assertEq(captured3.calls.length, 1, '调用了一次 webhook');

const payload3 = captured3.calls[0].payload;
assert(Array.isArray(payload3.blocks), 'payload 包含 blocks');
const textBlock = payload3.blocks.find(b => b.type === 'section');
assert(textBlock !== undefined, '有 section block');
assert(textBlock.text.type === 'mrkdwn', 'text type = mrkdwn');
// **Hello** → *Hello* （Slack mrkdwn）
assert(textBlock.text.text.includes('*Hello*'), '**bold** → *bold*');
// [Click](url) → <url|Click>
assert(textBlock.text.text.includes('<https://example.com|Click>'), 'markdown link → Slack link');

// ─── Step 4: SlackAdapter — sendMarkdown @mention + urgency ──────────────────
section('Step 4: SlackAdapter — sendMarkdown @mention + urgency');

const slack4 = new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/test' });
const captured4 = mockSend(slack4, true);

await slack4.sendMarkdown('紧急告警', { mentions: ['U123456'], urgency: 'high' });
const payload4 = captured4.calls[0].payload;

// urgency=high → header block
const header = payload4.blocks.find(b => b.type === 'header');
assert(header !== undefined, '高紧急度有 header block');
assert(header.text.text.includes('紧急'), 'header 包含"紧急"');

// @mention 在 text 中
const section4 = payload4.blocks.find(b => b.type === 'section');
assert(section4.text.text.includes('<@U123456>'), '@mention 写入 mrkdwn');

// ─── Step 5: SlackAdapter — sendCard ─────────────────────────────────────────
section('Step 5: SlackAdapter — sendCard');

const slack5 = new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/test' });
const captured5 = mockSend(slack5, true);

await slack5.sendCard({
  title: '任务完成通知',
  body: '任务 **T001** 已完成',
  actions: [
    { label: '查看详情', url: 'https://hub.cueai.top/tasks/T001' },
    { label: '关闭', url: 'https://hub.cueai.top' },
  ],
});

const payload5 = captured5.calls[0].payload;
const headerBlock = payload5.blocks.find(b => b.type === 'header');
assert(headerBlock !== undefined, 'sendCard 有 header block');
assertEq(headerBlock.text.text, '任务完成通知', 'header 标题正确');

const actionsBlock = payload5.blocks.find(b => b.type === 'actions');
assert(actionsBlock !== undefined, '有 actions block');
assertEq(actionsBlock.elements.length, 2, '两个按钮');
assertEq(actionsBlock.elements[0].text.text, '查看详情', '第一个按钮标签');
assertEq(actionsBlock.elements[0].url, 'https://hub.cueai.top/tasks/T001', '按钮 URL');

// ─── Step 6: SlackAdapter — 发送失败时返回 false ─────────────────────────────
section('Step 6: SlackAdapter — 发送失败返回 false');

const slack6 = new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/test' });
mockSend(slack6, false);
const ok6 = await slack6.sendMarkdown('test');
assert(ok6 === false, '发送失败时 sendMarkdown 返回 false');

// ─── Step 7: SlackAdapter — resolveHandle ────────────────────────────────────
section('Step 7: SlackAdapter — resolveHandle');

const slack7 = new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/test' });
// 无 botToken → 返回 null
const handle7 = await slack7.resolveHandle('testuser');
assert(handle7 === null, '无 botToken 时 resolveHandle 返回 null');

const slack7b = new SlackAdapter({ botToken: 'xoxb-test' });
// Slack ID 格式（U + 大写字母数字）→ 直接返回
const handle7b = await slack7b.resolveHandle('U1234ABCD');
assertEq(handle7b, 'U1234ABCD', 'Slack ID 格式直接返回');

// ─── Step 8: FeishuAdapter — isAvailable ─────────────────────────────────────
section('Step 8: FeishuAdapter — isAvailable');

const feishuNoConfig = new FeishuAdapter({ webhookUrl: null });
assert(!feishuNoConfig.isAvailable(), '无配置时 isAvailable=false');

const feishu = new FeishuAdapter({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' });
assert(feishu.isAvailable(), '有 webhookUrl 时 isAvailable=true');
assertEq(feishu.name, 'feishu', 'name = "feishu"');

// ─── Step 9: FeishuAdapter — sendMarkdown（post 格式）────────────────────────
section('Step 9: FeishuAdapter — sendMarkdown（post 格式）');

const feishu9 = new FeishuAdapter({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' });
const captured9 = mockSend(feishu9, true);

const ok9 = await feishu9.sendMarkdown('### 标题\n\n**粗体** 正文\n[链接](https://example.com)');
assert(ok9 === true, 'sendMarkdown 返回 true');
assertEq(captured9.calls.length, 1, '调用了一次 webhook');

const payload9 = captured9.calls[0].payload;
assertEq(payload9.msg_type, 'post', 'msg_type = post');
assert(payload9.content.post.zh_cn !== undefined, '有 zh_cn 内容');
assert(Array.isArray(payload9.content.post.zh_cn.content), 'content 是数组');

// 验证标题行被解析为粗体节点
const firstLine = payload9.content.post.zh_cn.content.find(p => p.length > 0 && p[0].style?.includes('bold'));
assert(firstLine !== undefined, '标题行转为粗体节点');

// 验证链接节点存在
const allNodes = payload9.content.post.zh_cn.content.flat();
const linkNode9 = allNodes.find(n => n.tag === 'a');
assert(linkNode9 !== undefined, '有链接节点');
assertEq(linkNode9.text, '链接', '链接文本正确');
assertEq(linkNode9.href, 'https://example.com', '链接 URL 正确');

// ─── Step 10: FeishuAdapter — @mention ───────────────────────────────────────
section('Step 10: FeishuAdapter — @mention');

const feishu10 = new FeishuAdapter({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' });
const captured10 = mockSend(feishu10, true);

await feishu10.sendMarkdown('测试消息', { mentions: ['ou_user123'] });
const payload10 = captured10.calls[0].payload;
const firstPara = payload10.content.post.zh_cn.content[0];
// @mention 节点在第一段
const atNode10 = firstPara.find(n => n.tag === 'at');
assert(atNode10 !== undefined, '有 at 节点');
assertEq(atNode10.user_id, 'ou_user123', 'user_id 正确');

// ─── Step 11: FeishuAdapter — sendCard（interactive）────────────────────────
section('Step 11: FeishuAdapter — sendCard（interactive）');

const feishu11 = new FeishuAdapter({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' });
const captured11 = mockSend(feishu11, true);

await feishu11.sendCard({
  title: 'PR 审阅完成',
  body: 'PR #42 已通过审阅',
  actions: [
    { label: '查看 PR', url: 'https://github.com/org/repo/pull/42' },
  ],
});

const payload11 = captured11.calls[0].payload;
assertEq(payload11.msg_type, 'interactive', 'msg_type = interactive');
assert(payload11.card !== undefined, '有 card 字段');
assertEq(payload11.card.header.title.content, 'PR 审阅完成', '卡片标题正确');

const actionEl = payload11.card.elements.find(e => e.tag === 'action');
assert(actionEl !== undefined, '有 action element');
assertEq(actionEl.actions[0].text.content, '查看 PR', '按钮文本正确');
assertEq(actionEl.actions[0].url, 'https://github.com/org/repo/pull/42', '按钮 URL 正确');

// ─── Step 12: FeishuAdapter — 失败降级 ───────────────────────────────────────
section('Step 12: FeishuAdapter — 失败时降级为 text');

const feishu12 = new FeishuAdapter({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' });
let callCount12 = 0;
feishu12._postWebhook = async (payload) => {
  callCount12++;
  if (payload.msg_type === 'post') return false; // post 失败
  return true; // text 成功
};

const ok12 = await feishu12.sendMarkdown('降级测试');
assert(ok12 === true, '降级后返回 true');
assert(callCount12 === 2, '尝试了 post 和 text 两种格式');

// ─── Step 13: adapters/index — initAdapters + registerAdapter ────────────────
section('Step 13: adapters/index — initAdapters + registerAdapter');

// 无环境变量 → 0 个适配器
delete process.env.WECOM_WEBHOOK_URL;
delete process.env.SLACK_WEBHOOK_URL;
delete process.env.FEISHU_WEBHOOK_URL;
delete process.env.SLACK_BOT_TOKEN;

initAdapters();
assert(getAllAdapters().length === 0, '无配置时 0 个适配器');
assert(getPrimaryAdapter() === null, '无配置时 getPrimaryAdapter=null');

// 手动注册 mock 适配器
class MockAdapter extends NotificationAdapter {
  get name() { return 'mock'; }
  isAvailable() { return true; }
  async sendMarkdown(md) { this.lastMarkdown = md; return true; }
  async sendCard(card) { this.lastCard = card; return true; }
}

const mock1 = new MockAdapter();
const mock2 = new MockAdapter();
registerAdapter(mock1);
registerAdapter(mock2);

assert(getAllAdapters().length === 2, 'registerAdapter 后有 2 个适配器');
assert(getPrimaryAdapter() === mock1, 'getPrimaryAdapter 返回第一个');

// ─── Step 14: broadcast / broadcastCard ──────────────────────────────────────
section('Step 14: broadcast / broadcastCard');

const broadcastOk = await broadcast('测试广播消息');
assert(broadcastOk === true, 'broadcast 返回 true（任意成功）');
assertEq(mock1.lastMarkdown, '测试广播消息', 'mock1 收到 markdown');
assertEq(mock2.lastMarkdown, '测试广播消息', 'mock2 收到 markdown');

const cardOk = await broadcastCard({ title: '测试卡片', body: '内容' });
assert(cardOk === true, 'broadcastCard 返回 true');
assertEq(mock1.lastCard.title, '测试卡片', 'mock1 收到 card');

// ─── Step 15: broadcast 部分失败场景 ─────────────────────────────────────────
section('Step 15: broadcast 部分失败场景');

class FailAdapter extends NotificationAdapter {
  get name() { return 'fail'; }
  isAvailable() { return true; }
  async sendMarkdown() { return false; }
  async sendCard() { return false; }
}

// 重置，加入 fail + success
initAdapters(); // 清零
const mockSuccess = new MockAdapter();
const mockFail = new FailAdapter();
registerAdapter(mockFail);
registerAdapter(mockSuccess);

const partialOk = await broadcast('部分失败测试');
assert(partialOk === true, '一个成功一个失败时 broadcast 返回 true');

// 全部失败
initAdapters();
registerAdapter(new FailAdapter());
registerAdapter(new FailAdapter());
const allFail = await broadcast('全部失败测试');
assert(allFail === false, '全部失败时 broadcast 返回 false');

// ─── Step 16: registerAdapter 类型检查 ───────────────────────────────────────
section('Step 16: registerAdapter 类型检查');

let typeError = false;
try {
  registerAdapter({ name: 'not-adapter' });
} catch (e) {
  typeError = true;
  assert(e.message.includes('NotificationAdapter'), '错误提示需要 NotificationAdapter');
}
assert(typeError, '非 NotificationAdapter 实例抛出错误');

// ─── Step 17: Slack — mrkdwn 转换规则验证 ────────────────────────────────────
section('Step 17: Slack mrkdwn 转换规则');

// 验证转换不依赖网络，直接测试转换后的 block 内容
const slack17 = new SlackAdapter({ webhookUrl: 'https://hooks.slack.com/test' });
const captured17 = mockSend(slack17, true);

const md = [
  '### 标题',          // ### → *标题*
  '**粗体**',          // **bold** → *bold*
  '__下划线粗体__',    // __bold__ → *bold*
  '~~删除线~~',        // ~~text~~ → ~text~
  '[链接](https://a)', // link → <url|text>
].join('\n');

await slack17.sendMarkdown(md);
const text17 = captured17.calls[0].payload.blocks.find(b => b.type === 'section').text.text;
assert(text17.includes('*标题*'), '标题转为粗体');
assert(text17.includes('*粗体*'), '**bold** → *bold*');
assert(text17.includes('*下划线粗体*'), '__bold__ → *bold*');
assert(text17.includes('~删除线~'), '~~text~~ → ~text~');
assert(text17.includes('<https://a|链接>'), 'link → Slack 格式');

// ─── Step 18: Feishu — urgency=high 标题 ─────────────────────────────────────
section('Step 18: FeishuAdapter — urgency=high 标题');

const feishu18 = new FeishuAdapter({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' });
const captured18 = mockSend(feishu18, true);

await feishu18.sendMarkdown('高紧急度消息', { urgency: 'high' });
const payload18 = captured18.calls[0].payload;
assertEq(payload18.content.post.zh_cn.title, '🚨 紧急通知', 'urgency=high 时标题为"🚨 紧急通知"');

await feishu18.sendMarkdown('普通消息');
const payload18b = captured18.calls[1].payload;
assertEq(payload18b.content.post.zh_cn.title, 'CUE Hub', '普通消息标题为"CUE Hub"');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n\x1b[36m═══════════════════════════════════════════════════════\x1b[0m');
console.log('  W15 Slack / Feishu 适配器 测试');
if (failed === 0) {
  console.log(`  \x1b[32m✓ ${passed} passed\x1b[0m  `);
} else {
  console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m`);
}
console.log('\x1b[36m═══════════════════════════════════════════════════════\x1b[0m\n');

process.exit(failed > 0 ? 1 : 0);
