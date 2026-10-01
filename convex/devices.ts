import { v, ConvexError } from 'convex/values';
import { query, mutation, internalMutation } from './_generated/server';
import { requireAuth } from './lib/auth';

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireAuth(ctx);
    const rows = await ctx.db
      .query('devices')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .collect();
    return rows.toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
});

/**
 * Called from the mobile app every time it gets a fresh Expo push token.
 * Upserts on `expoPushToken` so re-registering is idempotent.
 */
export const register = mutation({
  args: {
    expoPushToken: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android'), v.literal('web')),
    name: v.optional(v.string()),
    model: v.optional(v.string()),
    osVersion: v.optional(v.string()),
    appVersion: v.optional(v.string())
  },
  returns: v.id('devices'),
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const existing = await ctx.db
      .query('devices')
      .withIndex('by_token', (q) => q.eq('expoPushToken', args.expoPushToken))
      .first();

    const now = Date.now();
    if (existing) {
      // If the token was previously registered to a different user, take it over.
      // `name` is intentionally NOT overwritten on re-register: the mobile
      // client always sends the OS hardware name (Device.deviceName), which
      // would clobber any user rename via `devices.rename`. The hardware
      // name is only used to seed the initial insert below.
      await ctx.db.patch(existing._id, {
        ownerId,
        platform: args.platform,
        model: args.model ?? existing.model,
        osVersion: args.osVersion ?? existing.osVersion,
        appVersion: args.appVersion ?? existing.appVersion,
        enabled: true,
        invalidatedAt: undefined,
        lastSeenAt: now
      });
      return existing._id;
    }
    return await ctx.db.insert('devices', {
      ownerId,
      expoPushToken: args.expoPushToken,
      platform: args.platform,
      name: args.name,
      model: args.model,
      osVersion: args.osVersion,
      appVersion: args.appVersion,
      enabled: true,
      lastSeenAt: now,
      createdAt: now
    });
  }
});

/**
 * Called on sign-out so a phone stops receiving the account's pushes. Keyed
 * by push token rather than device id: the client always knows its own token,
 * and a token row owned by someone else is left alone.
 */
export const unregister = mutation({
  args: { expoPushToken: v.string() },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const rows = await ctx.db
      .query('devices')
      .withIndex('by_token', (q) => q.eq('expoPushToken', args.expoPushToken))
      .collect();
    for (const row of rows) {
      if (row.ownerId === ownerId) await ctx.db.delete(row._id);
    }
  }
});

export const rename = mutation({
  args: { id: v.id('devices'), name: v.string() },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const device = await ctx.db.get(args.id);
    if (!device || device.ownerId !== ownerId) {
      throw new ConvexError('Device not found');
    }
    await ctx.db.patch(args.id, { name: args.name.trim() });
  }
});

export const setEnabled = mutation({
  args: { id: v.id('devices'), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const device = await ctx.db.get(args.id);
    if (!device || device.ownerId !== ownerId) {
      throw new ConvexError('Device not found');
    }
    await ctx.db.patch(args.id, { enabled: args.enabled });
  }
});

export const remove = mutation({
  args: { id: v.id('devices') },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const device = await ctx.db.get(args.id);
    if (!device || device.ownerId !== ownerId) {
      throw new ConvexError('Device not found');
    }
    await ctx.db.delete(args.id);
  }
});

/**
 * Register/refresh the APNs push-to-start token for Live Activities.
 * The mobile client reports this from `Activity<PushrActivityAttributes>
 * .pushToStartTokenUpdates`. Token can change over time; we store the most
 * recent value.
 */
export const registerLiveActivityPushToStartToken = mutation({
  args: {
    deviceId: v.id('devices'),
    token: v.string()
  },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.ownerId !== ownerId) {
      throw new ConvexError('Device not found');
    }
    await ctx.db.patch(args.deviceId, {
      liveActivityPushToStartToken: args.token,
      liveActivityPushToStartAt: Date.now()
    });
  }
});

/**
 * Called by the Expo Push action when a token is rejected with
 * DeviceNotRegistered so we stop attempting delivery.
 */
export const markInvalid = internalMutation({
  args: { id: v.id('devices') },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.id);
    if (!device) return;
    await ctx.db.patch(args.id, {
      enabled: false,
      invalidatedAt: Date.now()
    });
  }
});
