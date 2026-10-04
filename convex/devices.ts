import { v, ConvexError } from 'convex/values';
import { query, mutation, internalMutation } from './_generated/server';
import { requireAuth } from './lib/auth';
import { queueEmail, userContact } from './lib/accountMail';
import { phoneStoppedEmail } from './lib/email';
import { sha256Hex } from './lib/tokens';

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
    appVersion: v.optional(v.string()),
    apnsEnvironment: v.optional(v.union(v.literal('sandbox'), v.literal('production')))
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
        // A key the previous user's session was given mustn't report as this one.
        ...(existing.ownerId !== ownerId ? { liveActivityKeyHash: undefined } : {}),
        platform: args.platform,
        model: args.model ?? existing.model,
        osVersion: args.osVersion ?? existing.osVersion,
        appVersion: args.appVersion ?? existing.appVersion,
        apnsEnvironment: args.apnsEnvironment ?? existing.apnsEnvironment,
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
      apnsEnvironment: args.apnsEnvironment,
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
    token: v.string(),
    apnsEnvironment: v.optional(v.union(v.literal('sandbox'), v.literal('production')))
  },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.ownerId !== ownerId) {
      throw new ConvexError('Device not found');
    }
    await ctx.db.patch(args.deviceId, {
      liveActivityPushToStartToken: args.token,
      liveActivityPushToStartAt: Date.now(),
      ...(args.apnsEnvironment ? { apnsEnvironment: args.apnsEnvironment } : {})
    });
  }
});

/**
 * A key this device's native code can report Live Activity update tokens
 * with, on its own: when iOS starts an activity from a push while pushr is
 * closed, it wakes the app only briefly, too briefly for a signed-in session.
 * Issuing a new key replaces the old one; only its hash is kept.
 */
export const issueLiveActivityKey = mutation({
  args: { deviceId: v.id('devices') },
  returns: v.string(),
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.ownerId !== ownerId) {
      throw new ConvexError('Device not found');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = `plak_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    await ctx.db.patch(args.deviceId, { liveActivityKeyHash: await sha256Hex(key) });
    return key;
  }
});

/**
 * Called by the Expo Push action when a token is rejected with
 * DeviceNotRegistered so we stop attempting delivery, and tells the owner,
 * since their alerts would otherwise stop without a sign.
 */
export const markInvalid = internalMutation({
  args: { id: v.id('devices') },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.id);
    if (!device) return;
    const wasLive = device.enabled && device.invalidatedAt === undefined;
    await ctx.db.patch(args.id, {
      enabled: false,
      invalidatedAt: Date.now()
    });
    if (!wasLive) return;

    const others = (
      await ctx.db
        .query('devices')
        .withIndex('by_owner', (q) => q.eq('ownerId', device.ownerId))
        .take(50)
    ).filter((d) => d._id !== device._id && d.enabled && d.invalidatedAt === undefined);
    // A phone registered after this one last checked in is almost always its
    // replacement (a reinstall gets a new token), so the owner already knows.
    if (others.some((d) => d.createdAt >= device.lastSeenAt)) return;
    const owner = await userContact(ctx, device.ownerId);
    if (!owner) return;
    await queueEmail(
      ctx,
      phoneStoppedEmail(owner.email, {
        phoneName: device.name || device.model || 'your iPhone',
        lastSeenAt: device.lastSeenAt,
        otherPhones: others.length
      })
    );
  }
});
