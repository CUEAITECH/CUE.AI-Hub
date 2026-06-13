import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
      }).catch((err) => {
        console.log(`  ❌ ${name}\n     ${err.message}`);
        failed++;
      });
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err.message}`);
    failed++;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

console.log('\nTask Contract 生产流测试\n');

const calls = [];
global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });

  if (String(url).endsWith('/repos/acme/repo')) {
    return jsonResponse({ default_branch: 'main' });
  }

  if (String(url).endsWith('/repos/acme/repo/git/ref/heads/main')) {
    return jsonResponse({ object: { sha: 'base-sha-123' } });
  }

  if (String(url).endsWith('/repos/acme/repo/git/refs')) {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.ok(body.ref.startsWith('refs/heads/feat/task_task_contract_prod_001'));
    assert.equal(body.sha, 'base-sha-123');
    return jsonResponse({ ref: body.ref, object: { sha: body.sha } }, 201);
  }

  if (String(url).endsWith('/repos/acme/repo/contents/.hub/task_contract_prod_001.md')) {
    assert.equal(options.method, 'PUT');
    const body = JSON.parse(options.body);
    assert.equal(body.message, 'chore(task_contract_prod_001): 初始化任务上下文文件');
    const content = Buffer.from(body.content, 'base64').toString('utf8');
    assert.ok(content.includes('id: task_contract_prod_001'), 'task contract id missing');
    assert.ok(content.includes('canonical_source: cue-db'), 'canonical source missing');
    assert.ok(content.includes('## Acceptance Criteria'), 'AC section missing');
    assert.ok(content.includes('- [ ] 有效课堂码进入课堂页'), 'AC checkbox missing');
    return jsonResponse({ content: { path: '.hub/task_contract_prod_001.md' } }, 201);
  }

  if (String(url).endsWith('/repos/acme/repo/pulls')) {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.draft, true);
    assert.ok(body.body.includes('## 业务目标'), 'PR body should still include business goal');
    assert.ok(body.body.includes('- [ ] 有效课堂码进入课堂页'), 'PR body should include AC checklist');
    return jsonResponse({ number: 42, html_url: 'https://github.com/acme/repo/pull/42' }, 201);
  }

  return jsonResponse({ message: `unexpected ${url}` }, 500);
};

const { createTaskBranchAndPR } = await import('../server/services/githubApi.js');

await test('createTaskBranchAndPR writes task contract before opening draft PR', async () => {
  const result = await createTaskBranchAndPR({
    id: 'task_contract_prod_001',
    title: '浏览器验证加入课堂',
    owner: '林世棋',
    priority: 'P0',
    businessNote: '学生能在浏览器里输入课堂码加入课堂',
    description: '实现 /join 页面课堂码提交和错误态展示',
    acceptance: '有效课堂码进入课堂页\n错误课堂码显示错误提示',
    dependencies: ['task_api_001'],
    requirementRefs: ['REQ-L5-001']
  }, {
    name: 'Cue.AI',
    githubOwner: 'acme',
    repository: 'repo'
  });

  assert.equal(result.prNumber, 42);
  assert.equal(result.prUrl, 'https://github.com/acme/repo/pull/42');

  const fileCallIndex = calls.findIndex((call) => call.url.endsWith('/contents/.hub/task_contract_prod_001.md'));
  const prCallIndex = calls.findIndex((call) => call.url.endsWith('/pulls'));
  assert.ok(fileCallIndex >= 0, 'task contract file write call missing');
  assert.ok(prCallIndex >= 0, 'draft PR call missing');
  assert.ok(fileCallIndex < prCallIndex, 'task contract must be written before draft PR creation');
});

if (failed > 0) {
  console.error(`\n❌ ${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n✅ ${passed} passed`);
process.exit(0);
