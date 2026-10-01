import { v, ConvexError } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';

/**
 * Helper queries + mutations for the APNs Live Activity client
 * (see convex/apns.ts). Kept in a separate file because actions
 * running under "use node" cannot colocate with v8-runtime functions.
 */

export const getDispatchContext = internalQuery({
  args: { id: v.id('notifications') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError('notification not found');
    return {
      ownerId: row.ownerId,
      sourceAppId: row.sourceAppId,
      liveActivity: row.liveActivity,
      alert: row.title && row.body ? { title: row.title, body: row.body } : undefined
    };
  }
});

export const getPushToStartTokensForOwner = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(
    v.object({
      deviceId: v.id('devices'),
      pushToStartToken: v.string()
    })
  ),
  handler: async (ctx, args) => {
    const devices = await ctx.db
      .query('devices')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .collect();
    return devices
      .filter((d) => d.liveActivityPushToStartToken !== undefined && d.enabled && !d.invalidatedAt)
      .map((d) => ({
        deviceId: d._id,
        pushToStartToken: d.liveActivityPushToStartToken as string
      }));
  }
});

/**
 * Push-to-start tokens for every device of every user with access to a
 * source app (owner + accepted members). Used by `apns.dispatch` so a
 * Live Activity start fans out to all members.
 */
export const getPushToStartTokensForSourceApp = internalQuery({
  args: { sourceAppId: v.id('sourceApps') },
  returns: v.array(
    v.object({
      deviceId: v.id('devices'),
      pushToStartToken: v.string()
    })
  ),
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.sourceAppId);
    if (!app) return [];
    const memberRows = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app', (q) => q.eq('sourceAppId', args.sourceAppId))
      .collect();
    const userIds = new Set<string>([app.ownerId]);
    for (const m of memberRows) {
      if (m.acceptedAt) userIds.add(m.userId);
    }
    const out: Array<{ deviceId: Id<'devices'>; pushToStartToken: string }> = [];
    for (const uid of userIds) {
      const devices = await ctx.db
        .query('devices')
        .withIndex('by_owner', (q) => q.eq('ownerId', uid))
        .collect();
      for (const d of devices) {
        if (d.liveActivityPushToStartToken === undefined || !d.enabled || d.invalidatedAt) {
          continue;
        }
        out.push({
          deviceId: d._id,
          pushToStartToken: d.liveActivityPushToStartToken
        });
      }
    }
    return out;
  }
});

export const getActivityByOwner = internalQuery({
  args: { ownerId: v.string(), activityId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('liveActivities')
      .withIndex('by_owner_activity', (q) =>
        q.eq('ownerId', args.ownerId).eq('activityId', args.activityId)
      )
      .unique();
    if (!row) return null;
    return {
      activityId: row.activityId,
      pushUpdateToken: row.pushUpdateToken,
      pushUpdateTokenAt: row.pushUpdateTokenAt,
      deviceId: row.deviceId,
      nativeActivityId: row.nativeActivityId,
      startedAt: row.startedAt,
      lastUpdateAt: row.lastUpdateAt,
      endedAt: row.endedAt,
      creationTime: row._creationTime
    };
  }
});

export const getActivityById = internalQuery({
  args: { id: v.id('liveActivities') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    return {
      activityId: row.activityId,
      pushUpdateToken: row.pushUpdateToken,
      lastState: row.lastState,
      endedAt: row.endedAt
    };
  }
});

export const recordStartResults = internalMutation({
  args: {
    notificationId: v.id('notifications'),
    activityId: v.string(),
    results: v.array(
      v.object({
        deviceId: v.id('devices'),
        ok: v.boolean(),
        status: v.number(),
        reason: v.optional(v.string()),
        apnsId: v.optional(v.string())
      })
    )
  },
  handler: async (ctx, args) => {
    const successCount = args.results.filter((r) => r.ok).length;
    const failures = args.results
      .filter((r) => !r.ok)
      .map((r) => `${r.status}${r.reason ? ` ${r.reason}` : ''}`);
    // Append onto the notification row so the feed surfaces delivery status.
    const notif = await ctx.db.get(args.notificationId);
    if (notif) {
      await ctx.db.patch(args.notificationId, {
        attemptedDeviceCount: args.results.length,
        successDeviceCount: successCount,
        failureMessages: failures.length > 0 ? failures : undefined
      });
    }
  }
});

/** APNs reasons meaning this token will never work again. */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'ExpiredToken', 'Unregistered']);

export const recordUpdateResult = internalMutation({
  args: {
    notificationId: v.id('notifications'),
    ownerId: v.string(),
    deadToken: v.optional(v.string()),
    activityId: v.string(),
    ok: v.boolean(),
    status: v.number(),
    reason: v.optional(v.string()),
    apnsId: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    if (!args.ok && args.deadToken && (args.status === 410 || DEAD_TOKEN_REASONS.has(args.reason ?? ''))) {
      const row = await ctx.db
        .query('liveActivities')
        .withIndex('by_owner_activity', (q) => q.eq('ownerId', args.ownerId).eq('activityId', args.activityId))
        .unique();
      // Only clear the token we actually sent to; the device may have
      // reported a fresh one while this push was in flight.
      if (row && row.pushUpdateToken === args.deadToken) {
        await ctx.db.patch(row._id, { pushUpdateToken: undefined, pushUpdateTokenAt: undefined });
      }
    }
    const notif = await ctx.db.get(args.notificationId);
    if (!notif) return;
    await ctx.db.patch(args.notificationId, {
      attemptedDeviceCount: 1,
      successDeviceCount: args.ok ? 1 : 0,
      failureMessages: args.ok
        ? undefined
        : [`APNs ${args.status}${args.reason ? `: ${args.reason}` : ''}`]
    });
  }
});
