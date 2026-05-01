import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actualBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parseGitHubEvent(eventName, payload) {
  const repo = payload.repository?.full_name || payload.repository?.name || 'unknown';
  const actor = payload.sender?.login || payload.pusher?.name || 'unknown';
  const now = new Date().toISOString();

  if (eventName === 'push') {
    return (payload.commits || []).map((commit) => ({
      type: 'commit',
      repo,
      actor,
      title: commit.message?.split('\n')[0] || 'commit',
      sha: commit.id,
      url: commit.url,
      branch: payload.ref?.replace('refs/heads/', '') || '',
      files: [...(commit.added || []), ...(commit.modified || []), ...(commit.removed || [])],
      createdAt: commit.timestamp || now
    }));
  }

  if (eventName === 'pull_request') {
    return [{
      type: 'pull_request',
      repo,
      actor,
      title: payload.pull_request?.title || 'pull request',
      number: payload.pull_request?.number,
      state: payload.pull_request?.state,
      action: payload.action,
      url: payload.pull_request?.html_url,
      branch: payload.pull_request?.head?.ref || '',
      files: [],
      createdAt: now
    }];
  }

  if (eventName === 'pull_request_review') {
    return [{
      type: 'review',
      repo,
      actor,
      title: `Review ${payload.review?.state || ''}`.trim(),
      number: payload.pull_request?.number,
      state: payload.review?.state,
      action: payload.action,
      url: payload.review?.html_url,
      branch: payload.pull_request?.head?.ref || '',
      files: [],
      createdAt: now
    }];
  }

  return [{
    type: eventName || 'unknown',
    repo,
    actor,
    title: `${eventName || 'unknown'} event`,
    action: payload.action || '',
    files: [],
    createdAt: now
  }];
}
