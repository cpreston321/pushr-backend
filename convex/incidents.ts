import { v, ConvexError } from 'convex/values';
import { internalMutation, mutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { requireAuth } from './lib/auth';
import { getSourceAppRole, requireSourceAppRole } from './lib/sharing';

/**
 * What an app's people tell status page visitors about an outage: a title for
 * it, and updates as it goes (investigating, identified, monitoring,
 * resolved). Outages themselves are recorded by the monitors
 * (lib/monitors.ts); these are the words around them. Any editor of the app
 * can write them, so whoever is on call can, from the dashboard, the app or
 * an agent.
 */

export const UPDATES_MAX = 30;
const BODY_MAX = 1000;
const TITLE_MAX = 80;
/** An agent posts to a monitor's latest incident only while it's going or just over. */
const AGENT_RECENT_MS = 24 * 3_600_000;

export const updateStatus = v.union(v.literal('investigating'), v.literal('identified'), v.literal('monitoring'), v.literal('resolved'));
export type UpdateStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export const postUpdate = mutation({
  args: {
    incidentId: v.id('monitorIncidents'),
    status: updateStatus,
    body: v.string(),
    /** Left out keeps the title; an empty one clears it. */
    title: v.optional(v.string())
  },
  returns: v.id('incidentUpdates'),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const incident = await ctx.db.get(args.incidentId);
    if (!incident) throw new ConvexError('Incident not found');
    await requireSourceAppRole(ctx, incident.sourceAppId, userId, 'editor');
    return await addUpdate(ctx, incident, userId, args);
  }
});

export const setTitle = mutation({
  args: { incidentId: v.id('monitorIncidents'), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const incident = await ctx.db.get(args.incidentId);
    if (!incident) throw new ConvexError('Incident not found');
    const { app } = await requireSourceAppRole(ctx, incident.sourceAppId, userId, 'editor');
    void app;
    await ctx.db.patch(incident._id, { title: cleanTitle(args.title) });
    return null;
  }
});

export const deleteUpdate = mutation({
  args: { id: v.id('incidentUpdates') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const update = await ctx.db.get(args.id);
    if (!update) return null;
    await requireSourceAppRole(ctx, update.sourceAppId, userId, 'editor');
    await ctx.db.delete(update._id);
    return null;
  }
});

/**
 * An agent's update (the MCP `incident_update` tool), to the latest incident
 * of a monitor it names, among the apps it was granted.
 */
export const postUpdateFromAgent = internalMutation({
  args: {
    userId: v.string(),
    appIds: v.array(v.id('sourceApps')),
    monitor: v.string(),
    status: updateStatus,
    body: v.string(),
    title: v.optional(v.string())
  },
  returns: v.object({ monitor: v.string(), startedAt: v.number(), ongoing: v.boolean() }),
  handler: async (ctx, args) => {
    const name = args.monitor.trim();
    for (const appId of args.appIds) {
      const access = await getSourceAppRole(ctx, appId, args.userId);
      if (!access || access.role === 'viewer') continue;
      const found = await monitorNamed(ctx, appId, name);
      if (!found) continue;
      const incident = await ctx.db
        .query('monitorIncidents')
        .withIndex('by_monitor_and_startedAt', (q) => q.eq('monitorKind', found.kind).eq('monitorId', found.id))
        .order('desc')
        .first();
      if (!incident || (incident.endedAt !== undefined && incident.endedAt < Date.now() - AGENT_RECENT_MS)) {
        throw new ConvexError(`${found.name} has no incident going on or in the last day.`);
      }
      await addUpdate(ctx, incident, args.userId, args);
      return { monitor: found.name, startedAt: incident.startedAt, ongoing: incident.endedAt === undefined };
    }
    throw new ConvexError(`No monitor named “${name}” in the apps this agent can write to.`);
  }
});

async function addUpdate(
  ctx: MutationCtx,
  incident: Doc<'monitorIncidents'>,
  authorId: string,
  args: { status: UpdateStatus; body: string; title?: string }
): Promise<Id<'incidentUpdates'>> {
  const app = await ctx.db.get(incident.sourceAppId);
  if (!app) throw new ConvexError('Incident not found');
  const body = args.body.trim();
  if (!body) throw new ConvexError('Write what’s happening.');
  if (body.length > BODY_MAX) throw new ConvexError(`An update is at most ${BODY_MAX} characters.`);
  const existing = await ctx.db
    .query('incidentUpdates')
    .withIndex('by_incident_and_at', (q) => q.eq('incidentId', incident._id))
    .take(UPDATES_MAX);
  if (existing.length >= UPDATES_MAX) throw new ConvexError(`An incident has at most ${UPDATES_MAX} updates.`);
  if (args.title !== undefined) await ctx.db.patch(incident._id, { title: cleanTitle(args.title) });
  return await ctx.db.insert('incidentUpdates', {
    incidentId: incident._id,
    sourceAppId: incident.sourceAppId,
    status: args.status,
    body,
    at: Date.now(),
    authorId
  });
}

function cleanTitle(raw: string): string | undefined {
  const title = raw.trim().replace(/\s+/g, ' ');
  if (title.length > TITLE_MAX) throw new ConvexError(`A title is at most ${TITLE_MAX} characters.`);
  return title || undefined;
}


async function monitorNamed(ctx: QueryCtx, appId: Id<'sourceApps'>, name: string) {
  const check = await ctx.db
    .query('uptimeChecks')
    .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', appId).eq('name', name))
    .unique();
  if (check) return { kind: 'uptime' as const, id: check._id as string, name: check.name };
  const beat = await ctx.db
    .query('heartbeats')
    .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', appId).eq('name', name))
    .unique();
  return beat ? { kind: 'heartbeat' as const, id: beat._id as string, name: beat.name } : null;
}

/** An incident's updates, oldest first, for the people on its app. */
export async function updatesOf(ctx: QueryCtx, incidentId: Id<'monitorIncidents'>) {
  const rows = await ctx.db
    .query('incidentUpdates')
    .withIndex('by_incident_and_at', (q) => q.eq('incidentId', incidentId))
    .take(UPDATES_MAX);
  return rows.map((u) => ({ _id: u._id, status: u.status, body: u.body, at: u.at }));
}
