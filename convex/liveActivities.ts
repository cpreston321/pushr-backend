import { v, ConvexError } from 'convex/values';
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { sha256Hex } from './lib/tokens';
import { internal } from './_generated/api';
import { requireAuth } from './lib/auth';
import { getSourceAppRole, listAccessibleSourceApps } from './lib/sharing';

/**
 * Live Activity registration surface used by the mobile client.
 *
 * Push-to-start tokens live on `devices` (one per enrolled device). The
 * per-activity update token lives here on `liveActivities` — it's reported
 * by the device after `Activity.request(...)` returns.
 *
 * Server-initiated start/update/end lifecycle happens in convex/apns.ts.
 */

/**
 * Report the ActivityKit-assigned id + per-activity push update token
 * after the device has started the activity. The activity row is normally
 * created up-front by notifyInternal.ingest when /notify fires an action
 * with `liveActivity.action: "start"`, so we expect it to exist.
 *
 * The row is found by `activityId` and then access-checked against its source
 * app — deliberately *not* scoped to the caller's own id. On a shared app the
 * row's `ownerId` is the app's bill-payer while the device reporting the token
 * belongs to a member, so an owner-scoped lookup would miss the real row, write
 * a second one under the member, and leave `apns.dispatch` — which looks up by
 * the notification's owner — pushing to a row that has no token forever.
 */
export const registerUpdateToken = mutation({
  args: {
    activityId: v.string(),
    nativeActivityId: v.string(),
    pushUpdateToken: v.string(),
    deviceId: v.id('devices')
  },
  handler: async (ctx, args) => {
    await recordUpdateToken(ctx, await requireAuth(ctx), args);
  }
});

/**
 * The same, reported by the app's native code with the device's Live
 * Activity key (`devices.issueLiveActivityKey`), through
 * `POST /live-activity/token`. That's how the token arrives when iOS starts
 * an activity from a push with pushr closed and the phone locked. Resolves
 * whether the key matched a device.
 */
export const registerUpdateTokenWithKey = internalMutation({
  args: {
    key: v.string(),
    activityId: v.string(),
    nativeActivityId: v.string(),
    pushUpdateToken: v.string()
  },
  returns: v.boolean(),
  handler: async (ctx, { key, ...args }) => {
    const keyHash = await sha256Hex(key);
    const device = await ctx.db
      .query('devices')
      .withIndex('by_liveActivityKey', (q) => q.eq('liveActivityKeyHash', keyHash))
      .unique();
    if (!device || !device.enabled || device.invalidatedAt) return false;
    await recordUpdateToken(ctx, device.ownerId, { ...args, deviceId: device._id });
    return true;
  }
});

async function recordUpdateToken(
  ctx: MutationCtx,
  callerId: string,
  args: { activityId: string; nativeActivityId: string; pushUpdateToken: string; deviceId: Id<'devices'> }
) {
  // Only for the caller's own phone: anyone on a shared app could otherwise
  // point its activity's updates at a token of their choosing under someone
  // else's device.
  const device = await ctx.db.get(args.deviceId);
  if (!device || device.ownerId !== callerId) {
    throw new ConvexError('Device not found');
  }
  const candidates = await ctx.db
    .query('liveActivities')
    .withIndex('by_activity', (q) => q.eq('activityId', args.activityId))
    .collect();
  // `activityId` is caller-supplied, so two unrelated users can pick the same
  // one. Match on the row this caller can actually reach.
  let row = null as (typeof candidates)[number] | null;
  for (const candidate of candidates) {
    const access = await getSourceAppRole(ctx, candidate.sourceAppId, callerId);
    if (access) {
      row = candidate;
      break;
    }
  }
  if (!row) {
    // The activity row doesn't exist yet — this can happen if the device
    // started an activity locally (e.g. from a debug button) before the
    // server recorded it. Create a stub so future updates work.
    // We don't have a sourceAppId here — leave it unset via a sentinel
    // lookup isn't possible, so require the row to exist in normal flows.
    // For the "local start without server row" case we still want a row
    // so APNs updates can find a token: point at the user's first app.
    const anyApp = await ctx.db
      .query('sourceApps')
      .withIndex('by_owner', (q) => q.eq('ownerId', callerId))
      .first();
    if (!anyApp) {
      throw new ConvexError(
        'No source app found for owner — create one before starting activities'
      );
    }
    await ctx.db.insert('liveActivities', {
      ownerId: callerId,
      sourceAppId: anyApp._id,
      activityId: args.activityId,
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      nativeActivityId: args.nativeActivityId,
      pushUpdateToken: args.pushUpdateToken,
      pushUpdateTokenAt: Date.now(),
      deviceId: args.deviceId
    });
    return;
  }
  const isNewToken = row.pushUpdateToken !== args.pushUpdateToken;
  await ctx.db.patch(row._id, {
    nativeActivityId: args.nativeActivityId,
    pushUpdateToken: args.pushUpdateToken,
    pushUpdateTokenAt: Date.now(),
    deviceId: args.deviceId
  });
  // Updates sent before the device reported this token were dropped (there
  // was nowhere to send them). Replay the latest state so the activity jumps
  // to where the job actually is instead of staying frozen at its start.
  if (isNewToken && row.lastState && row.endedAt === undefined) {
    await ctx.scheduler.runAfter(0, internal.apns.catchUp, { liveActivityId: row._id });
  }
  // `ownerId` is intentionally left as-is: it's the app's bill-payer, and
  // `apns.dispatch` resolves this row from the notification's owner.
}

/**
 * List activities the caller can see. Useful for a debug screen; the mobile
 * app can display current activity state.
 *
 * Scoped by source-app access rather than by `ownerId`: an activity's owner is
 * the app's bill-payer, so an owner-scoped query would hide every activity on
 * a shared app from the member whose phone is actually running it.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const accessible = await listAccessibleSourceApps(ctx, userId);
    const perApp = await Promise.all(
      accessible.map(({ app }) =>
        ctx.db
          .query('liveActivities')
          .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', app._id))
          .collect()
      )
    );
    return perApp
      .flat()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
      .map(({ pushUpdateToken: _token, ...row }) => row);
  }
});
