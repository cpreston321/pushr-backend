import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { listAccessibleSourceApps } from './lib/sharing';

// Queries used by the "use node" expoPush.ts action. Lives in a separate file
// because actions can't colocate queries/mutations.

/**
 * Count unread notifications across every source app the given owner can
 * see (apps they own + apps shared with them). Used by `expoPush.deliver`
 * to stamp `badge` on the APNs payload so iOS updates the home-screen icon
 * even when the app is closed.
 *
 * Mirrors the public `notifications.unreadCount` query without the auth
 * gate (we already trust the caller — it's an internal action with a
 * known ownerId).
 */
export const unreadCountForOwner = internalQuery({
  args: { ownerId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const accessible = await listAccessibleSourceApps(ctx, args.ownerId);
    let total = 0;
    for (const { app } of accessible) {
      const unread = await ctx.db
        .query('notifications')
        .withIndex('by_sourceApp_read', (q) => q.eq('sourceAppId', app._id).eq('readAt', undefined))
        .take(500);
      total += unread.length;
    }
    return total;
  }
});

export const getNotification = internalQuery({
  args: { id: v.id('notifications') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  }
});

export const getSourceAppLogoUrl = internalQuery({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.id);
    if (!app?.logoStorageId) return null;
    return await ctx.storage.getUrl(app.logoStorageId);
  }
});

export const getSourceAppInfo = internalQuery({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.id);
    if (!app) return null;
    const logoUrl = app.logoStorageId ? await ctx.storage.getUrl(app.logoStorageId) : null;
    return {
      name: app.name,
      logoUrl,
      quietStart: app.quietStart,
      quietEnd: app.quietEnd,
      quietTimeZone: app.quietTimeZone
    };
  }
});

export const isSourceAppMuted = internalQuery({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.id);
    if (!app?.mutedUntil) return false;
    return Date.now() < app.mutedUntil;
  }
});

export const activeDevicesForOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('devices')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .collect();
    return rows.filter((d) => d.enabled && !d.invalidatedAt);
  }
});

/**
 * All enabled devices that should receive a push from a given source app:
 * the bill-payer owner's devices PLUS every accepted member's devices.
 * This is the fan-out used by `expoPush.deliver`.
 */
export const activeDevicesForSourceApp = internalQuery({
  args: { sourceAppId: v.id('sourceApps') },
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
    const out: Array<{
      _id: import('./_generated/dataModel').Id<'devices'>;
      expoPushToken: string;
      ownerId: string;
    }> = [];
    for (const uid of userIds) {
      const rows = await ctx.db
        .query('devices')
        .withIndex('by_owner', (q) => q.eq('ownerId', uid))
        .collect();
      for (const d of rows) {
        if (!d.enabled || d.invalidatedAt) continue;
        out.push({
          _id: d._id,
          expoPushToken: d.expoPushToken,
          ownerId: d.ownerId
        });
      }
    }
    return out;
  }
});
