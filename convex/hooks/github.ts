import type { Adapter, NormalizedNotification } from './types';

/**
 * GitHub webhook adapter.
 *
 * Handles the handful of events that matter for push-to-phone:
 *   - push                          "new commits on refs/heads/..."
 *   - pull_request (opened/merged)
 *   - issues (opened)
 *   - release (published)
 *   - workflow_run (failed)
 *   - check_run (failed)
 *   - deployment_status
 *   - ping                          → returns null (webhook creation probe)
 *
 * Anything else normalizes to a generic "<event>" alert so the feed still
 * records it, but at default priority.
 *
 * Signature verification (X-Hub-Signature-256) happens in the HTTP
 * dispatcher; by the time the adapter runs the request is trusted.
 */
export const githubAdapter: Adapter = (payload, headers) => {
  const event = headers.get('x-github-event') ?? 'unknown';
  if (event === 'ping') return null;

  if (!isObject(payload)) return null;

  const repo = isObject(payload.repository)
    ? ((payload.repository.full_name as string | undefined) ?? 'repo')
    : 'repo';
  const senderLogin = isObject(payload.sender)
    ? (payload.sender.login as string | undefined)
    : undefined;
  const senderAvatar = isObject(payload.sender)
    ? (payload.sender.avatar_url as string | undefined)
    : undefined;

  const base: Partial<NormalizedNotification> = {
    eventType: event,
    image: senderAvatar,
    data: { provider: 'github', event }
  };

  switch (event) {
    case 'push': {
      const ref = typeof payload.ref === 'string' ? payload.ref : '';
      const branch = ref.replace(/^refs\/heads\//, '');
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      const count = commits.length;
      const firstMsg =
        isObject(commits[0]) && typeof commits[0].message === 'string'
          ? (commits[0].message as string).split('\n')[0]
          : '';
      const compareUrl = typeof payload.compare === 'string' ? payload.compare : undefined;
      return {
        ...base,
        title: `${repo}: ${count} commit${count === 1 ? '' : 's'} → ${branch}`,
        body: firstMsg || `by ${senderLogin ?? 'unknown'}`,
        url: compareUrl
      } as NormalizedNotification;
    }
    case 'pull_request': {
      if (!isObject(payload.pull_request)) break;
      const action = typeof payload.action === 'string' ? payload.action : '';
      const pr = payload.pull_request;
      const number = pr.number;
      const title = typeof pr.title === 'string' ? pr.title : '';
      const html = typeof pr.html_url === 'string' ? pr.html_url : undefined;
      const merged = action === 'closed' && pr.merged === true ? 'merged' : action;
      // Only notify on high-signal transitions.
      if (!['opened', 'reopened', 'ready_for_review', 'closed'].includes(action)) {
        return null;
      }
      return {
        ...base,
        title: `${repo} PR #${number} ${merged}`,
        body: title,
        url: html,
        priority: merged === 'opened' ? 6 : 5
      } as NormalizedNotification;
    }
    case 'issues': {
      if (!isObject(payload.issue)) break;
      const action = typeof payload.action === 'string' ? payload.action : '';
      if (action !== 'opened' && action !== 'reopened') return null;
      const issue = payload.issue;
      const html = typeof issue.html_url === 'string' ? issue.html_url : undefined;
      return {
        ...base,
        title: `${repo} issue #${issue.number} ${action}`,
        body: typeof issue.title === 'string' ? issue.title : '',
        url: html
      } as NormalizedNotification;
    }
    case 'release': {
      if (!isObject(payload.release)) break;
      const action = typeof payload.action === 'string' ? payload.action : '';
      if (action !== 'published') return null;
      const rel = payload.release;
      return {
        ...base,
        title: `${repo} release ${rel.tag_name ?? ''}`,
        body: typeof rel.name === 'string' ? rel.name : '',
        url: typeof rel.html_url === 'string' ? rel.html_url : undefined,
        priority: 7
      } as NormalizedNotification;
    }
    case 'workflow_run':
    case 'check_run': {
      const run = event === 'workflow_run' ? payload.workflow_run : payload.check_run;
      if (!isObject(run)) break;
      const conclusion = typeof run.conclusion === 'string' ? run.conclusion : '';
      if (conclusion !== 'failure' && conclusion !== 'timed_out') return null;
      const name =
        typeof run.name === 'string'
          ? run.name
          : typeof run.workflow_id === 'number'
            ? `workflow ${run.workflow_id}`
            : 'run';
      const url = typeof run.html_url === 'string' ? run.html_url : undefined;
      return {
        ...base,
        title: `${repo}: ${name} failed`,
        body: conclusion,
        url,
        priority: 8
      } as NormalizedNotification;
    }
    case 'deployment_status': {
      if (!isObject(payload.deployment_status)) break;
      const state = payload.deployment_status.state as string | undefined;
      if (!state || state === 'in_progress' || state === 'queued') return null;
      const env = isObject(payload.deployment)
        ? ((payload.deployment.environment as string | undefined) ?? 'env')
        : 'env';
      return {
        ...base,
        title: `${repo}: deploy to ${env} → ${state}`,
        body:
          typeof payload.deployment_status.description === 'string'
            ? payload.deployment_status.description
            : '',
        url:
          typeof payload.deployment_status.target_url === 'string'
            ? payload.deployment_status.target_url
            : undefined,
        priority: state === 'failure' || state === 'error' ? 8 : 6
      } as NormalizedNotification;
    }
  }

  return {
    ...base,
    title: `${repo}: ${event}`,
    body: senderLogin ? `by ${senderLogin}` : 'github webhook'
  } as NormalizedNotification;
};

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
