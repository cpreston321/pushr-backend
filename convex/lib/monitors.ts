import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { supersedeEarlier } from './replace';
import { escalationFor } from './onCall';

/**
 * Alerting shared by heartbeats and uptime checks. Each monitor's alerts use
 * one replace key, so a recovery replaces its alert and the feed keeps the
 * history, and each outage is recorded as an incident for status pages.
 */

export type MonitorRef = {
  kind: 'heartbeat' | 'uptime';
  id: string;
  name: string;
  replaceKey: string;
};

/**
 * Alerts are free of quota, so a monitor flapping between down and up would
 * otherwise push without limit. Past this many down alerts in an hour the
 * state still changes; only the push is skipped. A recovery is always sent
 * after a down alert that was.
 */
export const DOWN_ALERTS_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

type Alert = {
  /** `late`/`failed` for heartbeats, `down` for uptime checks, or `recovered`. */
  status: 'late' | 'failed' | 'down' | 'recovered';
  title: string;
  body: string;
  priority: number;
};

export function alertStatus(n: Doc<'notifications'>): string | undefined {
  const data = n.data as { monitor?: { status?: string }; heartbeat?: { status?: string } } | undefined;
  return data?.monitor?.status ?? data?.heartbeat?.status;
}

export async function monitorAlert(ctx: MutationCtx, app: Doc<'sourceApps'>, ref: MonitorRef, alert: Alert): Promise<void> {
  if (!app.enabled) return;
  const now = Date.now();
  if (alert.status === 'recovered') {
    // Only a down alert that reached the phone needs replacing; without one
    // (the cap, or the app was off) "back up" would come out of nowhere.
    const latest = await ctx.db
      .query('notifications')
      .withIndex('by_sourceApp_replaceKey', (q) => q.eq('sourceAppId', app._id).eq('replaceKey', ref.replaceKey))
      .order('desc')
      .first();
    const status = latest && alertStatus(latest);
    if (!status || status === 'recovered') return;
  } else {
    // Each down alert is followed by at most one recovery, so this window
    // holds every down alert of the last hour.
    const recent = await ctx.db
      .query('notifications')
      .withIndex('by_sourceApp_replaceKey', (q) =>
        q.eq('sourceAppId', app._id).eq('replaceKey', ref.replaceKey).gt('createdAt', now - HOUR_MS)
      )
      .take(DOWN_ALERTS_PER_HOUR * 2);
    if (recent.filter((n) => alertStatus(n) !== 'recovered').length >= DOWN_ALERTS_PER_HOUR) return;
  }

  let teamFeatures = true;
  const { escalation, ack } =
    alert.status === 'recovered' || !teamFeatures ? {} : escalationFor(app, { priority: alert.priority }, now);

  const notificationId = await ctx.db.insert('notifications', {
    ownerId: app.ownerId,
    sourceAppId: app._id,
    title: alert.title,
    body: alert.body,
    priority: alert.priority,
    data: { monitor: { kind: ref.kind, name: ref.name, status: alert.status } },
    replaceKey: ref.replaceKey,
    escalation,
    ack: ack ? { ...ack, attempts: 0 } : undefined,
    createdAt: now,
    attemptedDeviceCount: 0,
    successDeviceCount: 0
  });
  const inserted = await ctx.db.get(notificationId);
  if (inserted) await supersedeEarlier(ctx, inserted);
  await ctx.scheduler.runAfter(0, internal.expoPush.deliver, { notificationId });
  await ctx.scheduler.runAfter(0, internal.forwarders.fanOut, { notificationId });
  if (ack) await ctx.scheduler.runAfter(ack.timeoutSec * 1000, internal.ack.checkAck, { notificationId });
}

/** What a check saw at an incident's start or end, kept for its timeline. */
export type IncidentDetail = { firstFailedAt?: number; statusCode?: number; latencyMs?: number };

export async function openIncident(
  ctx: MutationCtx,
  sourceAppId: Doc<'sourceApps'>['_id'],
  ref: MonitorRef,
  reason: string,
  detail: IncidentDetail = {}
) {
  const open = await latestIncident(ctx, ref);
  if (open && open.endedAt === undefined) return;
  const now = Date.now();
  await ctx.db.insert('monitorIncidents', {
    sourceAppId,
    monitorKind: ref.kind,
    monitorId: ref.id,
    startedAt: now,
    reason,
    firstFailedAt: detail.firstFailedAt !== undefined && detail.firstFailedAt < now ? detail.firstFailedAt : undefined,
    statusCode: detail.statusCode,
    latencyMs: detail.latencyMs
  });
}

export async function closeIncident(ctx: MutationCtx, ref: MonitorRef, detail: Omit<IncidentDetail, 'firstFailedAt'> = {}) {
  const open = await latestIncident(ctx, ref);
  if (!open || open.endedAt !== undefined) return;
  await ctx.db.patch(open._id, { endedAt: Date.now(), recoveredStatusCode: detail.statusCode, recoveredLatencyMs: detail.latencyMs });
}

function latestIncident(ctx: MutationCtx, ref: MonitorRef) {
  return ctx.db
    .query('monitorIncidents')
    .withIndex('by_monitor_and_startedAt', (q) => q.eq('monitorKind', ref.kind).eq('monitorId', ref.id))
    .order('desc')
    .first();
}

/** "1h 12m", "45s", "3d 2h": the two largest units. */
/** A monitor's outages that overlap the last `days` days, oldest first, for the list's day strip. */
export async function recentOutages(
  ctx: QueryCtx,
  kind: MonitorRef['kind'],
  id: string,
  days = 7
): Promise<{ startedAt: number; endedAt: number | null }[]> {
  const since = Date.now() - days * 86_400_000;
  const rows = await ctx.db
    .query('monitorIncidents')
    .withIndex('by_monitor_and_startedAt', (q) => q.eq('monitorKind', kind).eq('monitorId', id))
    .order('desc')
    .take(50);
  return rows
    .filter((r) => (r.endedAt ?? Infinity) > since)
    .map((r) => ({ startedAt: r.startedAt, endedAt: r.endedAt ?? null }))
    .reverse();
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const units: [number, string][] = [
    [Math.floor(s / 86_400), 'd'],
    [Math.floor((s % 86_400) / 3_600), 'h'],
    [Math.floor((s % 3_600) / 60), 'm'],
    [s % 60, 's']
  ];
  const first = units.findIndex(([n]) => n > 0);
  if (first === -1) return '0s';
  return units
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, u]) => `${n}${u}`)
    .join(' ');
}
