import type { Adapter, NormalizedNotification } from './types';

/**
 * Grafana unified alerting webhook adapter.
 *
 * Payload shape (trimmed):
 *   {
 *     status: "firing" | "resolved",
 *     alerts: [{ labels, annotations, status, startsAt, endsAt, generatorURL }],
 *     commonLabels, commonAnnotations, groupLabels,
 *     externalURL, title, message, state, ruleName
 *   }
 *
 * We collapse the batch into one notification headlined by the count/severity.
 */
export const grafanaAdapter: Adapter = (payload, headers) => {
  if (!isObject(payload)) return null;
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const status = typeof payload.status === 'string' ? payload.status : 'firing';
  const ruleName =
    typeof payload.ruleName === 'string'
      ? payload.ruleName
      : typeof payload.title === 'string'
        ? payload.title
        : 'Grafana alert';
  const firingCount = alerts.filter((a) => isObject(a) && a.status === 'firing').length;

  const severity = pickSeverity(payload);
  const url = typeof payload.externalURL === 'string' ? payload.externalURL : undefined;
  const message =
    typeof payload.message === 'string'
      ? payload.message
      : (firstAnnotation(alerts, 'summary') ?? firstAnnotation(alerts, 'description') ?? '');

  const title = firingCount > 0 ? `${ruleName} (${firingCount} firing)` : `${ruleName} resolved`;

  return {
    title,
    body: message,
    url,
    priority: status === 'resolved' ? 4 : mapSeverity(severity),
    eventType: headers.get('x-grafana-event') ?? status,
    data: { provider: 'grafana', status, severity }
  } satisfies NormalizedNotification;
};

function firstAnnotation(alerts: any[], key: string): string | undefined {
  for (const a of alerts) {
    if (isObject(a) && isObject(a.annotations)) {
      const v = a.annotations[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return undefined;
}

function pickSeverity(payload: Record<string, any>): string {
  const common = isObject(payload.commonLabels) ? payload.commonLabels : {};
  if (typeof common.severity === 'string') return common.severity;
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  for (const a of alerts) {
    if (isObject(a) && isObject(a.labels) && typeof a.labels.severity === 'string') {
      return a.labels.severity;
    }
  }
  return 'warning';
}

function mapSeverity(sev: string): number {
  switch (sev.toLowerCase()) {
    case 'info':
      return 5;
    case 'warning':
      return 6;
    case 'high':
    case 'error':
      return 8;
    case 'critical':
    case 'emergency':
      return 9;
    default:
      return 6;
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
