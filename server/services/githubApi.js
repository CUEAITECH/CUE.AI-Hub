import logger from '../logger.js';
/**
 * GitHub REST API v3 封装
 * 用于从远端仓库拉取 commits、文件变更和 patch，替代本地 git 命令
 * 无需本地 clone，任何机器均可运行
 */

const API_BASE = 'https://api.github.com';

/** 构造认证请求头（设置 GITHUB_TOKEN 可提升速率至 5000 次/小时） */
function authHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'CUE.AI-Hub/1.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
}

async function ghFetch(path) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const resetTime = reset ? new Date(Number(reset) * 1000).toLocaleTimeString('zh-CN') : '未知';
    throw new Error(`GitHub API 速率限制，${reset ? `恢复时间 ${resetTime}` : '请配置 GITHUB_TOKEN 提高配额'}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${path.slice(0, 80)} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** 解析 "owner/repo" 格式或单独的 repo 名 */
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

/** 检查项目是否配置了 GitHub 远端信息 */
export function hasGitHubConfig(project) {
  const { owner, repo } = parseRepo(project);
  return Boolean(owner && repo);
}

/** 获取仓库元信息（默认分支等） */
export async function fetchRepoInfo(owner, repo) {
  return ghFetch(`/repos/${owner}/${repo}`);
}

/** 获取最近 commits 列表（不含 diff） */
export async function fetchCommits(owner, repo, options = {}) {
  const params = new URLSearchParams();
  if (options.since) params.set('since', options.since);
  if (options.sha) params.set('sha', options.sha);
  params.set('per_page', String(Math.min(options.per_page || 20, 100)));
  return ghFetch(`/repos/${owner}/${repo}/commits?${params}`);
}

/** 获取单个 commit 详情（含文件列表和 patch） */
export async function fetchCommitDetail(owner, repo, sha) {
  return ghFetch(`/repos/${owner}/${repo}/commits/${sha}`);
}

// ── 作者映射（GitHub login → 中文成员名） ─────────────────────────────────────
const authorMap = [
  { pattern: /jiaming|tian|田家铭/i, owner: '田家铭' },
  { pattern: /hjttu|hu|胡佳涛/i, owner: '胡佳涛' },
  { pattern: /ryanlzk|luo|罗子宽/i, owner: '罗子宽' },
  { pattern: /lin|林世棋/i, owner: '林世棋' }
];

function mapOwner(login = '', name = '', email = '') {
  const text = `${login} ${name} ${email}`;
  return authorMap.find((item) => item.pattern.test(text))?.owner || name || login || '未识别';
}

/**
 * 从 GitHub 远端拉取项目最近 commits，含 AI Review 所需的 diff
 * 替代 scanLocalGitProject，不依赖本地 clone
 *
 * @param {object} project - 需要 githubOwner + repository（或 githubFullRepo）
 * @param {object} options - { since: '14 days ago', limit: 15, diffLimit: 8 }
 */
export async function scanGitHubProject(project, options = {}) {
  const { owner, repo } = parseRepo(project);
  if (!owner || !repo) {
    throw new Error(`项目 "${project.name || project.id}" 未配置 githubOwner，请在项目设置中填写 GitHub 用户名/组织名`);
  }

  const limit = Math.min(options.limit || 15, 30);
  const diffLimit = Math.min(options.diffLimit || 8, limit); // 只拉前 N 条的 patch（API 调用较慢）
  const sinceDays = parseInt((options.since || '14 days ago').replace(/\s*days?\s*ago/i, '')) || 14;
  const sinceDate = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  // 1. 获取仓库元信息（默认分支）
  const repoInfo = await fetchRepoInfo(owner, repo);
  const defaultBranch = repoInfo.default_branch || 'main';

  // 2. 拉取最近 commits 列表
  const rawCommits = await fetchCommits(owner, repo, {
    since: sinceDate,
    per_page: limit,
    sha: defaultBranch
  });

  // 3. 为前 diffLimit 条 commit 拉取文件变更和 patch（用于 AI Review）
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
        files = (detail.files || []).map((f) => f.filename);
        // 拼接各文件 patch（总量不超过 8000 字符）
        let accumulated = '';
        for (const f of (detail.files || []).slice(0, 15)) {
          if (f.patch) accumulated += `--- ${f.filename}\n${f.patch}\n`;
          if (accumulated.length > 8000) break;
        }
        diff = accumulated;
      } catch (err) {
        logger.warn(`[GitHub API] 无法获取 commit ${sha.slice(0, 7)} 详情:`, err.message);
      }
    } else {
      // 不拉 diff 时，尝试从列表中获取文件名（列表返回的 files 字段视 API 版本而定）
      files = (raw.files || []).map((f) => f.filename || f);
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
    dirtyFileCount: 0,    // 远端无「未提交文件」概念
    commitCount: rawCommits.length,
    source: 'github-api'
  };
}

/**
 * 获取仓库近期 Pull Request 列表
 * @param {string} owner
 * @param {string} repo
 * @param {object} options - { state: 'all'|'open'|'closed', since: ISO string, per_page: number }
 */
export async function fetchProjectPRs(owner, repo, options = {}) {
  const params = new URLSearchParams();
  params.set('state', options.state || 'all');
  params.set('sort', 'updated');
  params.set('direction', 'desc');
  params.set('per_page', String(Math.min(options.per_page || 30, 100)));
  const rawPRs = await ghFetch(`/repos/${owner}/${repo}/pulls?${params}`);

  const since = options.since ? new Date(options.since) : null;
  const filtered = since
    ? rawPRs.filter((pr) => new Date(pr.updated_at) >= since)
    : rawPRs;

  return filtered.map((pr) => ({
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

/**
 * 获取单个 PR 详情，含 review comments（PR-Agent 留在 reviews 字段）
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 */
export async function fetchPRDetail(owner, repo, prNumber) {
  const [pr, reviews, comments] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`),
    ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`),
    ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`)
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
    commits: [],
    reviews: (reviews || []).map((r) => ({
      id: r.id,
      user: r.user?.login || '',
      body: r.body || '',
      state: r.state,
      submittedAt: r.submitted_at || '',
      htmlUrl: r.html_url || ''
    })),
    reviewComments: (comments || []).map((c) => ({
      id: c.id,
      user: c.user?.login || '',
      body: c.body || '',
      path: c.path || '',
      line: c.line || c.original_line || null,
      createdAt: c.created_at || ''
    }))
  };
}
