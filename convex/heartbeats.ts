import { v, ConvexError } from 'convex/values';
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { appForToken } from './lib/appToken';
import { requireAuth } from './lib/auth';
import { appLocked, listAccessibleSourceApps, requireSourceAppRole } from './lib/sharing';
import { addToAutoPages } from './statusPages';
import { closeIncident, formatDuration, monitorAlert, openIncident, recentOutages, type MonitorRef } from './lib/monitors';
import { deleteIncidents } from './lib/monitorCleanup';

export { formatDuration };

/**
 * Heartbeats: a job pings `/heartbeat/<name>` each time it runs, and pushr
 * alerts when a ping is late or the job reports a failure, then again when
 * it recovers. The first ping creates the heartbeat.
 *
 * Alerts are system pushes from the heartbeat's source app and don't spend
 * quota: they fire only on a change of state, so a chatty job can't run
 * them up.
 */

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const EVERY_MIN_SEC = 60;
export const EVERY_MAX_SEC = 30 * 86_400;
export const GRACE_MAX_SEC = 7 * 86_400;
export const PER_APP_LIMIT = 50;
/** Repeat success pings closer than this change nothing, so they write nothing. */
const PING_COALESCE_MS = 10_000;
const MESSAGE_MAX = 500;
const CHECK_BATCH = 100;

export function defaultGraceSec(everySec: number): number {
  return Math.min(3_600, Math.max(60, Math.round(everySec * 0.2)));
}

const statusValidator = v.union(v.literal('up'), v.literal('down'), v.literal('paused'));

export const ping = internalMutation({
  args: {
    token: v.string(),
    name: v.string(),
    kind: v.union(v.literal('success'), v.literal('start'), v.literal('fail')),
    everySec: v.optional(v.number()),
    graceSec: v.optional(v.number()),
    message: v.optional(v.string())
  },
  returns: v.object({
    status: statusValidator,
    everySec: v.number(),
    graceSec: v.number(),
    dueAt: v.union(v.number(), v.null())
  }),
  handler: async (ctx, args) => {
    const app = await appForToken(ctx, args.token);
    const now = Date.now();
    // The end of a job's output is where its error is.
    const message = args.message?.trim().slice(-MESSAGE_MAX) || undefined;
    let hb = await ctx.db
      .query('heartbeats')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id).eq('name', args.name))
      .unique();

    if (!hb) {
      if (args.everySec === undefined) {
        throw new ConvexError({
          code: 'EVERY_REQUIRED',
          message: `No heartbeat named "${args.name}" yet. Create it by pinging with ?every=<interval>, e.g. ?every=1h`
        });
      }
      hb = await createHeartbeat(ctx, app, args.name, args.everySec, args.graceSec);
      if (args.kind === 'start') {
        await ctx.db.patch(hb._id, { lastStartedAt: now });
        return result(hb);
      }
    }

    const everySec = args.everySec ?? hb.everySec;
    const graceSec = args.graceSec ?? (args.everySec !== undefined ? defaultGraceSec(everySec) : hb.graceSec);
    const config = { everySec, graceSec };

    if (args.kind === 'start') {
      await ctx.db.patch(hb._id, { ...config, lastStartedAt: now });
      return result({ ...hb, ...config });
    }

    if (hb.status === 'paused') {
      // Paused for maintenance means the job may still run and ping: record
      // it, but only Resume ends the pause.
      const seen =
        args.kind === 'success' || args.kind === 'fail'
          ? {
              ...config,
              lastPingAt: now,
              lastStartedAt: undefined,
              lastMessage: message,
              lastDurationMs: hb.lastStartedAt ? now - hb.lastStartedAt : undefined
            }
          : config;
      await ctx.db.patch(hb._id, seen);
      return result({ ...hb, ...seen });
    }

    if (args.kind === 'fail') {
      const patch = {
        ...config,
        lastPingAt: now,
        lastStartedAt: undefined,
        lastMessage: message,
        lastDurationMs: hb.lastStartedAt ? now - hb.lastStartedAt : undefined
      };
      if (hb.status === 'down') {
        // Already alerted; a second failure in a row stays quiet.
        await ctx.db.patch(hb._id, patch);
        return result({ ...hb, ...patch });
      }
      const down = { ...patch, status: 'down' as const, dueAt: undefined, downSince: now, downReason: 'failed' as const };
      await ctx.db.patch(hb._id, down);
      await alert(ctx, app, { ...hb, ...down }, 'failed');
      return result({ ...hb, ...down });
    }

    if (
      hb.status === 'up' &&
      hb.lastPingAt !== undefined &&
      now - hb.lastPingAt < PING_COALESCE_MS &&
      !hb.lastStartedAt &&
      everySec === hb.everySec &&
      graceSec === hb.graceSec
    ) {
      return result(hb);
    }

    const up = {
      ...config,
      status: 'up' as const,
      dueAt: now + (everySec + graceSec) * 1000,
      lastPingAt: now,
      lastStartedAt: undefined,
      lastDurationMs: hb.lastStartedAt ? now - hb.lastStartedAt : undefined,
      lastMessage: message,
      downSince: undefined,
      downReason: undefined
    };
    await ctx.db.patch(hb._id, up);
    if (hb.status === 'down') await alert(ctx, app, { ...hb, ...up }, 'recovered', hb.downSince);
    return result({ ...hb, ...up });
  }
});

export const remove = internalMutation({
  args: { token: v.string(), name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const app = await appForToken(ctx, args.token);
    const hb = await ctx.db
      .query('heartbeats')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id).eq('name', args.name))
      .unique();
    if (!hb) return false;
    await deleteIncidents(ctx, 'heartbeat', hb._id);
    await ctx.db.delete(hb._id);
    return true;
  }
});

/** Minute cron: mark every heartbeat whose window has closed as down, and alert. */
export const checkDue = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('heartbeats')
      .withIndex('by_dueAt', (q) => q.gte('dueAt', 0).lte('dueAt', now))
      .take(CHECK_BATCH);
    for (const hb of due) {
      const app = await ctx.db.get(hb.sourceAppId);
      if (!app || app.revokedAt) {
        await deleteIncidents(ctx, 'heartbeat', hb._id);
    await ctx.db.delete(hb._id);
        continue;
      }
      const down = { status: 'down' as const, dueAt: undefined, downSince: now, downReason: 'late' as const };
      await ctx.db.patch(hb._id, down);
      // dueAt carries the grace; the check-in itself was due that much earlier.
      await alert(ctx, app, { ...hb, ...down }, 'late', undefined, hb.dueAt !== undefined ? hb.dueAt - hb.graceSec * 1000 : undefined);
    }
    if (due.length === CHECK_BATCH) await ctx.scheduler.runAfter(0, internal.heartbeats.checkDue, {});
    return null;
  }
});


/**
 * A new heartbeat, within the app's and the plan's limits, joined to the
 * app's status pages that take new monitors.
 */
async function createHeartbeat(
  ctx: MutationCtx,
  app: Doc<'sourceApps'>,
  name: string,
  everySec: number,
  graceArg: number | undefined
): Promise<Doc<'heartbeats'>> {
  const count = (
    await ctx.db
      .query('heartbeats')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id))
      .take(PER_APP_LIMIT)
  ).length;
  if (count >= PER_APP_LIMIT) {
    throw new ConvexError({
      code: 'HEARTBEAT_LIMIT',
      message: `A source app can have at most ${PER_APP_LIMIT} heartbeats. Delete one first.`
    });
  }
  const graceSec = graceArg ?? defaultGraceSec(everySec);
  const now = Date.now();
  const id = await ctx.db.insert('heartbeats', {
    ownerId: app.ownerId,
    sourceAppId: app._id,
    name,
    everySec,
    graceSec,
    status: 'up',
    dueAt: now + (everySec + graceSec) * 1000,
    createdAt: now
  });
  await addToAutoPages(ctx, app._id, { kind: 'heartbeat', id });
  return (await ctx.db.get(id))!;
}

/**
 * Create a heartbeat from the app, before its job first pings: it shows as
 * waiting, and alerts as "never pinged" if no ping arrives in its window.
 */
export const create = mutation({
  args: { sourceAppId: v.id('sourceApps'), name: v.string(), everySec: v.number(), graceSec: v.optional(v.number()) },
  returns: v.id('heartbeats'),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.sourceAppId, userId, 'editor');
    const name = args.name.trim();
    if (!NAME_PATTERN.test(name)) throw new ConvexError('Use letters, digits, dots, dashes or underscores, up to 64.');
    if (args.everySec < EVERY_MIN_SEC || args.everySec > EVERY_MAX_SEC) throw new ConvexError('Every 1 minute to 30 days.');
    if (args.graceSec !== undefined && (args.graceSec < 0 || args.graceSec > GRACE_MAX_SEC)) throw new ConvexError('Grace is up to 7 days.');
    const taken = await ctx.db
      .query('heartbeats')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id).eq('name', name))
      .unique();
    if (taken) throw new ConvexError(`There's already a heartbeat called ${name}.`);
    return (await createHeartbeat(ctx, app, name, args.everySec, args.graceSec))._id;
  }
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const accessible = await listAccessibleSourceApps(ctx, userId);
    const out: Array<Doc<'heartbeats'> & { sourceAppName: string; canEdit: boolean; outages: { startedAt: number; endedAt: number | null }[] }> = [];
    for (const { app, role } of accessible) {
      const rows = await ctx.db
        .query('heartbeats')
        .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id))
        .take(PER_APP_LIMIT);
      const locked = rows.length ? await appLocked(ctx, app._id) : false;
      for (const hb of rows) {
        out.push({ ...hb, sourceAppName: app.name, canEdit: role !== 'viewer' && !locked, outages: await recentOutages(ctx, 'heartbeat', hb._id) });
      }
    }
    return out;
  }
});

export const setPaused = mutation({
  args: { id: v.id('heartbeats'), paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const hb = await editableHeartbeat(ctx, args.id);
    if (args.paused) {
      if (hb.status === 'down') await closeIncident(ctx, ref(hb));
      await ctx.db.patch(hb._id, { status: 'paused', dueAt: undefined, downSince: undefined, downReason: undefined });
    } else if (hb.status === 'paused') {
      // A fresh window from now: the job may not have run while paused.
      await ctx.db.patch(hb._id, { status: 'up', dueAt: Date.now() + (hb.everySec + hb.graceSec) * 1000 });
    }
    return null;
  }
});

export const deleteOne = mutation({
  args: { id: v.id('heartbeats') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const hb = await editableHeartbeat(ctx, args.id);
    await deleteIncidents(ctx, 'heartbeat', hb._id);
    await ctx.db.delete(hb._id);
    return null;
  }
});

async function editableHeartbeat(ctx: MutationCtx, id: Doc<'heartbeats'>['_id']) {
  const userId = await requireAuth(ctx);
  const hb = await ctx.db.get(id);
  if (!hb) throw new ConvexError('Heartbeat not found');
  await requireSourceAppRole(ctx, hb.sourceAppId, userId, 'editor');
  return hb;
}

function result(hb: Pick<Doc<'heartbeats'>, 'status' | 'everySec' | 'graceSec' | 'dueAt'>) {
  return { status: hb.status, everySec: hb.everySec, graceSec: hb.graceSec, dueAt: hb.dueAt ?? null };
}

export function heartbeatReplaceKey(name: string): string {
  return `heartbeat:${name}`;
}

function ref(hb: Doc<'heartbeats'>): MonitorRef {
  return { kind: 'heartbeat', id: hb._id, name: hb.name, replaceKey: heartbeatReplaceKey(hb.name) };
}

async function alert(
  ctx: MutationCtx,
  app: Doc<'sourceApps'>,
  hb: Doc<'heartbeats'>,
  kind: 'late' | 'failed' | 'recovered',
  downSince?: number,
  expectedAt?: number
): Promise<void> {
  const now = Date.now();
  if (kind === 'recovered') await closeIncident(ctx, ref(hb));
  else {
    await openIncident(ctx, app._id, ref(hb), kind === 'late' ? 'Missed its check-in' : (hb.lastMessage ?? 'Failed'), {
      firstFailedAt: kind === 'late' ? expectedAt : undefined
    });
  }
  const took = hb.lastDurationMs !== undefined ? ` Took ${formatDuration(hb.lastDurationMs)}.` : '';
  await monitorAlert(
    ctx,
    app,
    ref(hb),
    kind === 'late'
      ? {
          status: 'late',
          title: `${hb.name} missed its check-in`,
          body: `Expected every ${formatDuration(hb.everySec * 1000)}. ${
            hb.lastPingAt ? `Last ping ${formatDuration(now - hb.lastPingAt)} ago.` : 'It never pinged.'
          }`,
          priority: 8
        }
      : kind === 'failed'
        ? { status: 'failed', title: `${hb.name} failed`, body: (hb.lastMessage ?? 'The job reported a failure.') + took, priority: 8 }
        : {
            status: 'recovered',
            title: `${hb.name} is back up`,
            body: `${downSince ? `Down for ${formatDuration(now - downSince)}.` : 'Pinging again.'}${took}`,
            priority: 5
          }
  );
}
