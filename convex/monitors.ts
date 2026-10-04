import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { requireAuth } from './lib/auth';
import { appLocked, getSourceAppRole, requireSourceAppRole } from './lib/sharing';
import { uptimeAllowance } from './uptime';
import { updatesOf } from './incidents';

const DAY_MS = 86_400_000;
const LABEL_MAX = 60;

const labelArgs = { kind: v.union(v.literal('heartbeat'), v.literal('uptime')), id: v.string(), label: v.string() };

async function writeLabel(ctx: MutationCtx, args: { kind: 'heartbeat' | 'uptime'; id: string; label: string }, userId: string | null) {
  const id = args.kind === 'uptime' ? ctx.db.normalizeId('uptimeChecks', args.id) : ctx.db.normalizeId('heartbeats', args.id);
  const row = id ? await ctx.db.get(id) : null;
  if (!row) throw new ConvexError('Monitor not found');
  if (userId !== null) await requireSourceAppRole(ctx, row.sourceAppId, userId, 'editor');
  const label = args.label.trim();
  if (label.length > LABEL_MAX) throw new ConvexError(`A name is at most ${LABEL_MAX} characters.`);
  await ctx.db.patch(row._id, { label: label || undefined });
}

/** The name the app shows for a monitor; empty goes back to its `name`. */
export const setLabel = mutation({
  args: labelArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeLabel(ctx, args, await requireAuth(ctx));
    return null;
  }
});

/** The same from the backend, for monitors no client can change (a locked app's, see lib/sharing). */
export const setLabelInternal = internalMutation({
  args: labelArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeLabel(ctx, args, null);
    return null;
  }
});

const WINDOW_MS = 90 * DAY_MS;

/**
 * One heartbeat or uptime check for its detail screen: the monitor, its
 * recent incidents (with the full reason, since the viewer is on the app, and
 * the updates written for visitors),
 * uptime over 90 days, and the status pages showing it.
 */
export const detail = query({
  args: { kind: v.union(v.literal('heartbeat'), v.literal('uptime')), id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    let row: Doc<'heartbeats'> | Doc<'uptimeChecks'> | null = null;
    if (args.kind === 'heartbeat') {
      const id = ctx.db.normalizeId('heartbeats', args.id);
      row = id ? await ctx.db.get(id) : null;
    } else {
      const id = ctx.db.normalizeId('uptimeChecks', args.id);
      row = id ? await ctx.db.get(id) : null;
    }
    if (!row) return null;
    const access = await getSourceAppRole(ctx, row.sourceAppId, userId);
    if (!access) return null;

    const now = Date.now();
    const incidents = await ctx.db
      .query('monitorIncidents')
      .withIndex('by_monitor_and_startedAt', (q) => q.eq('monitorKind', args.kind).eq('monitorId', args.id).gte('startedAt', now - WINDOW_MS))
      .order('desc')
      .take(200);
    const from = Math.max(now - WINDOW_MS, row.createdAt);
    let down = 0;
    for (const i of incidents) {
      const overlap = (i.endedAt ?? now) - Math.max(i.startedAt, from);
      if (overlap > 0) down += overlap;
    }
    const observed = now - from;

    const pages = await ctx.db
      .query('statusPages')
      .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', row.sourceAppId))
      .collect();

    const onHold = args.kind === 'uptime' && (await uptimeAllowance(ctx, access.app.ownerId)).held.has(args.id);
    return {
      kind: args.kind,
      onHold,
      monitor: row,
      sourceAppName: access.app.name,
      canEdit: access.role !== 'viewer' && !(await appLocked(ctx, access.app._id)),
      uptime: observed > 60_000 ? Math.max(0, 1 - down / observed) : null,
      incidents: await Promise.all(
        incidents.slice(0, 20).map(async (i) => ({
          _id: i._id,
          startedAt: i.startedAt,
          endedAt: i.endedAt ?? null,
          reason: i.reason,
          title: i.title ?? null,
          firstFailedAt: i.firstFailedAt ?? null,
          statusCode: i.statusCode ?? null,
          latencyMs: i.latencyMs ?? null,
          recoveredStatusCode: i.recoveredStatusCode ?? null,
          recoveredLatencyMs: i.recoveredLatencyMs ?? null,
          updates: await updatesOf(ctx, i._id)
        }))
      ),
      pages: pages
        .filter((p) => p.monitors.some((m) => m.kind === args.kind && m.id === args.id))
        .map((p) => ({ _id: p._id as Id<'statusPages'>, title: p.title, slug: p.slug, enabled: p.enabled }))
    };
  }
});
