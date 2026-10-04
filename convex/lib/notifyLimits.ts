import type { NormalizedNotification } from '../hooks/types';
import type { LiveActivityPayload } from './dispatch';

export const LIMITS = {
  title: 256,
  body: 4096,
  url: 2048,
  dataBytes: 4096,
  dataDepth: 8,
  actionId: 64,
  actionLabel: 64,
  actionPlaceholder: 128,
  activityId: 256,
  liveText: 256,
  deliverAheadMs: 366 * 86_400_000
} as const;

const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript']);

/** The scheme as a browser or OS would read it: whitespace and control characters inside it are ignored. */
function schemeOf(raw: string): string | null {
  const visible = Array.from(raw)
    .filter((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('');
  const m = visible.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}

function tooLong(field: string, value: string | undefined, max: number): string | null {
  return value !== undefined && value.length > max ? `${field} must be at most ${max} characters` : null;
}

function webUrl(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const long = tooLong(field, value, LIMITS.url);
  if (long) return long;
  const scheme = schemeOf(value);
  return scheme === 'http' || scheme === 'https' ? null : `${field} must be an http or https URL`;
}

function linkUrl(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const long = tooLong(field, value, LIMITS.url);
  if (long) return long;
  const scheme = schemeOf(value);
  if (!scheme) return `${field} must be a URL with a scheme, like https://… or myapp://…`;
  return BLOCKED_SCHEMES.has(scheme) ? `${field} must not use the ${scheme}: scheme` : null;
}

function dataShapeError(value: unknown, depth: number): string | null {
  if (typeof value === 'string' || typeof value !== 'object' || value === null) return null;
  if (depth > LIMITS.dataDepth) return `data must be nested at most ${LIMITS.dataDepth} levels deep`;
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = dataShapeError(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.startsWith('$')) return 'data keys must not be empty or start with "$"';
    const err = dataShapeError(item, depth + 1);
    if (err) return err;
  }
  return null;
}

function dataError(data: Record<string, unknown> | undefined): string | null {
  if (data === undefined) return null;
  const shape = dataShapeError(data, 1);
  if (shape) return shape;
  return new TextEncoder().encode(JSON.stringify(data)).length > LIMITS.dataBytes
    ? `data must be at most ${LIMITS.dataBytes} bytes as JSON`
    : null;
}

function liveActivityError(la: LiveActivityPayload | undefined): string | null {
  if (!la) return null;
  return (
    tooLong('liveActivity.activityId', la.activityId, LIMITS.activityId) ??
    tooLong('liveActivity.state.title', la.state.title, LIMITS.liveText) ??
    tooLong('liveActivity.state.status', la.state.status, LIMITS.liveText) ??
    tooLong('liveActivity.state.icon', la.state.icon, LIMITS.liveText) ??
    tooLong('liveActivity.attributes.name', la.attributes?.name, LIMITS.liveText) ??
    webUrl('liveActivity.attributes.logoUrl', la.attributes?.logoUrl)
  );
}

/** First problem with what a caller asked to send, as a message naming the field and its limit; null when it is fine. */
export function notifyLimitError(args: {
  normalized: NormalizedNotification;
  liveActivity?: LiveActivityPayload;
  deliverAt?: number;
  now: number;
}): string | null {
  const n = args.normalized;
  if (args.deliverAt !== undefined && args.deliverAt > args.now + LIMITS.deliverAheadMs) {
    return 'deliverAt must be within the next 365 days';
  }
  let actionError: string | null = null;
  if (n.action) {
    actionError =
      tooLong('action.label', n.action.label, LIMITS.actionLabel) ?? linkUrl('action.url', n.action.url);
  }
  for (const a of n.actions ?? []) {
    actionError =
      actionError ??
      tooLong('actions[].id', a.id, LIMITS.actionId) ??
      tooLong('actions[].label', a.label, LIMITS.actionLabel) ??
      (a.kind === 'open_url' ? linkUrl('actions[].url', a.url) : null) ??
      (a.kind !== 'open_url' ? tooLong('actions[].callbackUrl', a.callbackUrl, LIMITS.url) : null) ??
      (a.kind === 'reply' ? tooLong('actions[].placeholder', a.placeholder, LIMITS.actionPlaceholder) : null);
  }
  return (
    tooLong('title', n.title, LIMITS.title) ??
    tooLong('body', n.body, LIMITS.body) ??
    webUrl('url', n.url) ??
    webUrl('image', n.image) ??
    linkUrl('appUrl', n.appUrl) ??
    dataError(n.data) ??
    actionError ??
    liveActivityError(args.liveActivity)
  );
}

/**
 * A provider webhook can't be asked to shorten its text, so an adapter's
 * oversized title/body are cut and a link that wouldn't pass is dropped,
 * rather than refusing the event.
 */
export function fitHookNotification(n: NormalizedNotification): NormalizedNotification {
  const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  return {
    ...n,
    title: cut(n.title, LIMITS.title),
    body: cut(n.body, LIMITS.body),
    url: webUrl('url', n.url) ? undefined : n.url,
    image: webUrl('image', n.image) ? undefined : n.image,
    appUrl: linkUrl('appUrl', n.appUrl) ? undefined : n.appUrl
  };
}
