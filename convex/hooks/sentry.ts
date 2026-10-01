import type { Adapter, NormalizedNotification } from './types';

/**
 * Sentry webhook adapter.
 *
 * Sentry supports multiple webhook shapes:
 *   - Internal Integrations: envelope { action, data: { issue | event | ... } }
 *   - Legacy "plugins" webhook: { project_name, message, url, ... }
 *
 * We detect both. Alerts default to high priority (level ≥ error) since
 * you rarely want to be paged for INFO.
 */
export const sentryAdapter: Adapter = (payload, headers) => {
  if (!isObject(payload)) return null;
  const eventType = headers.get('sentry-hook-resource') ?? undefined;

  // --- Internal Integration envelope ---
  if (isObject(payload.data)) {
    const action = typeof payload.action === 'string' ? payload.action : '';
    const d = payload.data;
    if (isObject(d.issue)) {
      const issue = d.issue;
      const project =
        (isObject(d.project) && typeof d.project.name === 'string' ? d.project.name : undefined) ??
        'sentry';
      const title = typeof issue.title === 'string' ? issue.title : 'issue';
      const culprit = typeof issue.culprit === 'string' ? issue.culprit : '';
      const level = typeof issue.level === 'string' ? issue.level : 'error';
      const permalink = typeof issue.permalink === 'string' ? issue.permalink : undefined;
      return {
        title: `${project}: ${action} — ${title}`,
        body: culprit || level,
        url: permalink,
        priority: mapLevel(level),
        eventType: eventType ?? `issue.${action}`,
        data: { provider: 'sentry', level }
      };
    }
    if (isObject(d.event)) {
      const ev = d.event;
      const title = typeof ev.title === 'string' ? ev.title : 'event';
      const message = typeof ev.message === 'string' ? ev.message : '';
      const level = typeof ev.level === 'string' ? ev.level : 'error';
      const url = typeof ev.web_url === 'string' ? ev.web_url : undefined;
      return {
        title,
        body: message || level,
        url,
        priority: mapLevel(level),
        eventType: eventType ?? `event.${action}`,
        data: { provider: 'sentry', level }
      };
    }
  }

  // --- Legacy plugin webhook ---
  if (typeof payload.message === 'string' && typeof payload.url === 'string') {
    return {
      title:
        typeof payload.project_name === 'string'
          ? `sentry: ${payload.project_name}`
          : 'sentry alert',
      body: payload.message,
      url: payload.url,
      priority: mapLevel(typeof payload.level === 'string' ? payload.level : 'error'),
      eventType: eventType ?? 'legacy',
      data: { provider: 'sentry' }
    };
  }

  return null;
};

function mapLevel(level: string): number {
  switch (level.toLowerCase()) {
    case 'debug':
      return 2;
    case 'info':
      return 4;
    case 'warning':
    case 'warn':
      return 6;
    case 'error':
      return 8;
    case 'fatal':
      return 9;
    default:
      return 5;
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
