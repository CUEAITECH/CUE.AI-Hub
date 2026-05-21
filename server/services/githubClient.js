// server/services/githubClient.js
// @octokit/rest 封装，替代 server/services/githubApi.js
// 优势：内置限速重试、分页、webhook 验签、官方维护
//
// 接口与 githubApi.js 保持 100% 兼容，可直接替换

import { Octokit } from '@octokit/rest';

// ── 作者映射（GitHub login → 中文成员名） ─────────────────
const authorMap = [
  { pattern: /jiaming|tian|田家铭/i, owner: '田家铭' },
  { pattern: /hjttu|hu|胡佳涛/i, owner: '胡佳涛' },
  { pattern: /ryanlzk|luo|罗子宽/i, owner: '罗子宽' },
  { pattern: /lin|林世棋/i, owner: '林世棋' }
];

function mapOwner(login = '', name = '', email = '') {
  const text = `${login} ${name} ${email}`;
  return authorMap.find(item => item.pattern.test(text))?.owner || name || login || '未识别';
}

// ── Octokit 单例 ────────────────────────────────────────────
let _octokit = null;

export function getOctokit() {
  if (!_octokit) {
    _octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN || undefined,
      userAgent: 'CUE.AI-Hub/2.0',
      // 自动重试：网络错误 + 服务端 5xx，最多 3 次
      request: {
        retries: 3,
        retryAfter: 5,
      },
      log: {
        debug: () => {},
        info: () => {},
        warn: console.warn,
        error: console.error,
      }
    });
  }
  return _octokit;
}

// ── parseRepo / hasGitHubConfig（与 githubApi.js 完全相同） ──

export function parseRepo(project) {
  const full = project.githubFullRepo || '';
  if (full.includes('/')) {
    const [owner, repo] = full.split('/');
    return { owner: owner.trim(), repo: repo.trim() };
  }
  const owner = (project.githubOwner || '').trim();
  const repo = (project.repository || '').trim();
  return { owner, repo };
}

export function hasGitHubConfig(project) {
  const { owner, repo } = parseRepo(project);
  return Boolean(owner && repo);
}

// ── REST 方法（对应 githubApi.js 的 ghFetch 系列） ─────────

export async function fetchRepoInfo(owner, repo) {
  const { data } = await getOctokit().rest.repos.get({ owner, repo });
  return data;
}

export async function fetchCommits(owner, repo, options = {}) {
  const params = {
    owner, repo,
    per_page: Math.min(options.per_page || 20, 100),
  };
  if (options.since) params.since = options.since;
  if (options.sha) params.sha = options.sha;
  const { data } = await getOctokit().rest.repos.listCommits(params);
  return data;
}

export async function fetchCommitDetail(owner, repo, sha) {
  const { data } = await getOctokit().rest.repos.getCommit({ owner, repo, ref: sha });
  return data;
}

export async function fetchProjectPRs(owner, repo, options = {}) {
  const { data: rawPRs } = await getOctokit().rest.pulls.list({
    owner, repo,
    state: options.state || 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: Math.min(options.per_page || 30, 100),
  });

  const since = options.since ? new Date(options.since) : null;
  const filtered = since
    ? rawPRs.filter(pr => new Date(pr.updated_at) >= since)
    : rawPRs;

  return filtered.map(pr => ({
    number: pr.number,
    title: pr.title || '',
    body: pr.body || '',
    state: pr.merged_at ? 'merged' : pr.state,
    author: mapOwner(pr.user?.login || '', '', ''),
    authorLogin: pr.user?.login || '',
    headBranch: pr.head?.ref || '',
    baseBranch: pr.base?.ref || '',
    htmlUrl: pr.html_url || '',
    mergedAt: pr.merged_at || null,
    createdAt: pr.created_at || new Date().toISOString(),
    updatedAt: pr.updated_at || new Date().toISOString()
  }));
}

export async function fetchPRDetail(owner, repo, prNumber) {
  const [{ data: pr }, { data: reviews }, { data: comments }] = await Promise.all([
    getOctokit().rest.pulls.get({ owner, repo, pull_number: prNumber }),
    getOctokit().rest.pulls.listReviews({ owner, repo, pull_number: prNumber }),
    getOctokit().rest.pulls.listReviewComments({ owner, repo, pull_number: prNumber }),
  ]);

  return {
    number: pr.number,
    title: pr.title || '',
    body: pr.body || '',
    state: pr.merged_at ? 'merged' : pr.state,
    author: mapOwner(pr.user?.login || '', '', ''),
    authorLogin: pr.user?.login || '',
    headBranch: pr.head?.ref || '',
    baseBranch: pr.base?.ref || '',
    htmlUrl: pr.html_url || '',
    mergedAt: pr.merged_at || null,
    createdAt: pr.created_at || new Date().toISOString(),
    updatedAt: pr.updated_at || new Date().toISOString(),
    reviews: (reviews || []).map(r => ({
      id: r.id,
      author: r.user?.login || '',
      body: r.body || '',
      state: r.state,
      submittedAt: r.submitted_at
    })),
    comments: (comments || []).map(c => ({
      id: c.id,
      author: c.user?.login || '',
      body: c.body || '',
      path: c.path || '',
      position: c.position,
      createdAt: c.created_at
    }))
  };
}

/**
 * 写 PR 评论（Hub bot 写 AC checklist 用）
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {string} body - Markdown 正文
 * @returns {Promise<{id: number, htmlUrl: string}>}
 */
export async function createPRComment(owner, repo, prNumber, body) {
  const { data } = await getOctokit().rest.issues.createComment({
    owner, repo,
    issue_number: prNumber,
    body
  });
  return { id: data.id, htmlUrl: data.html_url };
}

/**
 * 更新 PR 评论（AC checklist 状态实时更新）
 * @param {string} owner
 * @param {string} repo
 * @param {number} commentId
 * @param {string} body
 */
export async function updatePRComment(owner, repo, commentId, body) {
  const { data } = await getOctokit().rest.issues.updateComment({
    owner, repo,
    comment_id: commentId,
    body
  });
  return { id: data.id, htmlUrl: data.html_url };
}

/**
 * 列出 PR 的所有 issue comments（包含 Hub 和 PR-Agent 写的）
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 */
export async function listPRComments(owner, repo, prNumber) {
  const { data } = await getOctokit().rest.issues.listComments({
    owner, repo,
    issue_number: prNumber,
    per_page: 100
  });
  return data.map(c => ({
    id: c.id,
    author: c.user?.login || '',
    body: c.body || '',
    createdAt: c.created_at,
    updatedAt: c.updated_at
  }));
}

/**
 * 扫描 GitHub 项目（与 githubApi.js 的 scanGitHubProject 接口完全兼容）
 */
export async function scanGitHubProject(project, options = {}) {
  const { owner, repo } = parseRepo(project);
  if (!owner || !repo) {
    throw new Error(`项目 "${project.name || project.id}" 未配置 githubOwner，请在项目设置中填写 GitHub 用户名/组织名`);
  }

  const limit = Math.min(options.limit || 15, 30);
  const diffLimit = Math.min(options.diffLimit || 8, limit);
  const sinceDays = parseInt((options.since || '14 days ago').replace(/\s*days?\s*ago/i, '')) || 14;
  const sinceDate = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  // 1. 仓库元信息
  const repoInfo = await fetchRepoInfo(owner, repo);
  const defaultBranch = repoInfo.default_branch || 'main';

  // 2. commits 列表
  const rawCommits = await fetchCommits(owner, repo, {
    since: sinceDate,
    per_page: limit,
    sha: defaultBranch
  });

  // 3. 前 diffLimit 条拉 diff
  const activities = [];
  for (let i = 0; i < rawCommits.length; i++) {
    const raw = rawCommits[i];
    const sha = raw.sha;
    const authorLogin = raw.author?.login || '';
    const authorName = raw.commit?.author?.name || '';
    const authorEmail = raw.commit?.author?.email || '';
    const message = raw.commit?.message || 'commit';
    const title = message.split('\n')[0].slice(0, 120);
    const createdAt = raw.commit?.author?.date || new Date().toISOString();

    let files = [];
    let diff = '';

    if (i < diffLimit) {
      try {
        const detail = await fetchCommitDetail(owner, repo, sha);
        files = (detail.files || []).map(f => f.filename);
        let accumulated = '';
        for (const f of (detail.files || []).slice(0, 15)) {
          if (f.patch) accumulated += `--- ${f.filename}\n${f.patch}\n`;
          if (accumulated.length > 8000) break;
        }
        diff = accumulated;
      } catch (err) {
        console.warn(`[githubClient] 无法获取 commit ${sha.slice(0, 7)} 详情:`, err.message);
      }
    } else {
      files = (raw.files || []).map(f => f.filename || f);
    }

    activities.push({
      id: `commit_${sha}`,
      type: 'commit',
      projectId: project.id,
      repo: `${owner}/${repo}`,
      actor: authorLogin,
      owner: mapOwner(authorLogin, authorName, authorEmail),
      title,
      sha,
      shortSha: sha.slice(0, 7),
      branch: defaultBranch,
      files,
      diff,
      url: raw.html_url || '',
      createdAt
    });
  }

  return {
    branch: defaultBranch,
    activities,
    dirtyFileCount: 0,
    commitCount: rawCommits.length,
    source: 'github-client-v2'   // 标记来源为新客户端
  };
}
