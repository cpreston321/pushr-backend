import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/**
 * A monitor's outage history goes with it: incidents can carry error text
 * and a job's failure output, and their updates the owner's words. Bounded by
 * retention to 90 days of outages.
 */
export async function deleteIncidents(ctx: MutationCtx, kind: 'heartbeat' | 'uptime', id: string): Promise<void> {
  const rows = await ctx.db
    .query('monitorIncidents')
    .withIndex('by_monitor_and_startedAt', (q) => q.eq('monitorKind', kind).eq('monitorId', id))
    .take(500);
  for (const r of rows) {
    await deleteIncidentUpdates(ctx, r._id);
    await ctx.db.delete(r._id);
  }
}

/** An incident's written updates; capped per incident (incidents.ts UPDATES_MAX). */
export async function deleteIncidentUpdates(ctx: MutationCtx, incidentId: Id<'monitorIncidents'>): Promise<void> {
  const updates = await ctx.db
    .query('incidentUpdates')
    .withIndex('by_incident_and_at', (q) => q.eq('incidentId', incidentId))
    .take(100);
  for (const u of updates) await ctx.db.delete(u._id);
}
