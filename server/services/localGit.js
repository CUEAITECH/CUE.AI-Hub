import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const authorMap = [
  { pattern: /jiaming|tian|田/i, owner: '田家铭' },
  { pattern: /hjttu|hu|胡/i, owner: '胡佳涛' },
  { pattern: /ryanlzk|luo|罗/i, owner: '罗子宽' },
  { pattern: /lin|林/i, owner: '林世棋' }
];

async function git(repoPath, args, options = {}) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    maxBuffer: 1024 * 1024 * 8
  });
  return options.trim === false ? stdout : stdout.trim();
}

function mapOwner(authorName, authorEmail = '') {
  const text = `${authorName} ${authorEmail}`;
  return authorMap.find((item) => item.pattern.test(text))?.owner || authorName || '未识别';
}

function parseLog(output, project) {
  const commits = [];
  let current = null;

  for (const line of output.split('\n')) {
    if (!line) continue;

    if (line.startsWith('__COMMIT__')) {
      if (current) commits.push(current);
      const [, sha, shortSha, author, email, date, subject] = line.split('\x1f');
      current = {
        id: `commit_${sha}`,
        type: 'commit',
        projectId: project.id,
        repo: project.repository,
        actor: author,
        owner: mapOwner(author, email),
        title: subject || 'commit',
        sha,
        shortSha,
        branch: project.branch || '',
        files: [],
        createdAt: date,
        url: ''
      };
      continue;
    }

    if (current) current.files.push(line);
  }

  if (current) commits.push(current);
  return commits;
}

function parseStatus(output, project) {
  if (!output) return [];
  return output.split('\0').filter(Boolean).map((line, index) => {
    const status = line.slice(0, 2).trim() || 'M';
    const file = line.slice(3).trim();
    return {
      id: `working_${project.id}_${index}_${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
      type: 'working_tree',
      projectId: project.id,
      repo: project.repository,
      actor: 'local',
      owner: '未分配',
      title: `${status} ${file}`,
      status,
      files: [file],
      createdAt: new Date().toISOString()
    };
  });
}

async function getCommitDiff(repoPath, sha) {
  return git(repoPath, ['show', '--format=', '--unified=0', '--no-ext-diff', sha]);
}

export async function scanLocalGitProject(project, options = {}) {
  const since = options.since || '14 days ago';
  const limit = String(options.limit || 12);
  const branch = await git(project.localPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusOutput = await git(project.localPath, ['status', '--porcelain=v1', '-z'], { trim: false });
  const logOutput = await git(project.localPath, [
    'log',
    `--since=${since}`,
    `--max-count=${limit}`,
    '--pretty=format:__COMMIT__%x1f%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s',
    '--name-only',
    '--no-renames'
  ]);

  const projectWithBranch = { ...project, branch };
  const commits = parseLog(logOutput, projectWithBranch);
  const workingTree = parseStatus(statusOutput, projectWithBranch);

  const commitsWithDiff = [];
  for (const commit of commits.slice(0, 8)) {
    let diff = '';
    try {
      diff = await getCommitDiff(project.localPath, commit.sha);
    } catch {
      diff = '';
    }
    commitsWithDiff.push({ ...commit, diff });
  }

  return {
    branch,
    activities: [...commitsWithDiff, ...commits.slice(8), ...workingTree],
    dirtyFileCount: workingTree.length,
    commitCount: commits.length
  };
}
