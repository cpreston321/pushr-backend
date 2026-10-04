import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { listAccessibleSourceApps, pushRecipients } from './lib/sharing';
import { soundFor } from './userPrefs';
import { countUnreadEntries } from './lib/unread';

// Queries used by the expoPush.ts actions, which can't read the database themselves.

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
  handler: (ctx, args) => unreadCount(ctx, args.ownerId)
});

async function unreadCount(ctx: QueryCtx, ownerId: string): Promise<number> {
  const accessible = await listAccessibleSourceApps(ctx, ownerId);
  let total = 0;
  for (const { app } of accessible) {
    const unread = await ctx.db
      .query('notifications')
      .withIndex('by_sourceApp_read', (q) => q.eq('sourceAppId', app._id).eq('readAt', undefined))
      .filter((q) => q.neq(q.field('pending'), true))
      .take(500);
    total += countUnreadEntries(unread);
  }
  return total;
}

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
    return app ? await sourceAppInfo(ctx, app) : null;
  }
});

async function sourceAppInfo(ctx: QueryCtx, app: Doc<'sourceApps'>) {
  const logoUrl = app.logoStorageId ? await ctx.storage.getUrl(app.logoStorageId) : null;
  let criticalAlerts = app.criticalAlerts ?? 'off';
  return {
    name: app.name,
    logoUrl,
    quietStart: app.quietStart,
    quietEnd: app.quietEnd,
    quietTimeZone: app.quietTimeZone,
    criticalAlerts
  };
}

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
  args: {
    sourceAppId: v.id('sourceApps'),
    /** On-call: only these of the app's recipients. Everyone when none of them still is one. */
    onlyUserIds: v.optional(v.array(v.string()))
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.sourceAppId);
    return app ? await devicesForApp(ctx, app, args.onlyUserIds) : [];
  }
});

type PushDevice = { _id: Id<'devices'>; expoPushToken: string; ownerId: string };

async function devicesForApp(ctx: QueryCtx, app: Doc<'sourceApps'>, onlyUserIds: string[] | undefined): Promise<PushDevice[]> {
  const recipients = await pushRecipients(ctx, app);
  const chosen = onlyUserIds ? recipients.filter((id) => onlyUserIds.includes(id)) : [];
  const userIds = chosen.length > 0 ? chosen : recipients;
  const out: PushDevice[] = [];
  for (const uid of userIds) {
    const rows = await ctx.db
      .query('devices')
      .withIndex('by_owner', (q) => q.eq('ownerId', uid))
      .collect();
    for (const d of rows) {
      if (!d.enabled || d.invalidatedAt) continue;
      out.push({ _id: d._id, expoPushToken: d.expoPushToken, ownerId: d.ownerId });
    }
  }
  return out;
}

/**
 * Everything `expoPush.deliver` reads before calling Expo, in one query
 * rather than one round trip each: each one from an action is a separate
 * call, and they ran one after another ahead of every push.
 */
export const deliveryContext = internalQuery({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, args) => {
    const notif = await ctx.db.get(args.notificationId);
    if (!notif) return null;
    const app = await ctx.db.get(notif.sourceAppId);
    if (app?.mutedUntil && Date.now() < app.mutedUntil) return { kind: 'muted' as const, notif };
    const esc = notif.escalation;
    const devices = app ? await devicesForApp(ctx, app, esc ? esc.order.slice(0, esc.level + 1) : undefined) : [];
    if (devices.length === 0) return { kind: 'none' as const, notif };
    const owners = [...new Set(devices.map((d) => d.ownerId))];
    const [appInfo, { sound }, badges] = await Promise.all([
      app ? sourceAppInfo(ctx, app) : null,
      soundFor(ctx, notif.ownerId, notif.priority),
      Promise.all(owners.map(async (o) => [o, await unreadCount(ctx, o)] as const))
    ]);
    return { kind: 'send' as const, notif, devices, appInfo, sound, badges: Object.fromEntries(badges) as Record<string, number> };
  }
});
