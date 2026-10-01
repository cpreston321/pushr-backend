import { v, ConvexError } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { mergedStream, stream } from 'convex-helpers/server/stream';
import schema from './schema';
import {
  query,
  mutation,
  internalMutation,
  type MutationCtx,
  type QueryCtx
} from './_generated/server';
import { internal } from './_generated/api';
import { requireAuth } from './lib/auth';
import { getSourceAppRole, listAccessibleSourceApps } from './lib/sharing';
import { publicAction, type NotifAction } from './lib/actionsLayout';
import { touchLastUsed } from './lib/lastUsed';
import type { Doc, Id } from './_generated/dataModel';

/**
 * Decorate raw notification rows with their source app's display fields.
 *
 * Logo URLs are resolved only for the apps actually present in `rows` — the
 * feed's page is a handful of apps even when the user can see dozens, and each
 * unresolved logo is a storage lookup on every re-run of a reactive query.
 */
async function withSourceApp(
  ctx: QueryCtx,
  rows: Doc<'notifications'>[],
  apps: Doc<'sourceApps'>[]
) {
  const appMap = new Map(apps.map((a) => [a._id, a]));
  const present = new Set(rows.map((r) => r.sourceAppId));
  const logoUrlCache = new Map<string, string | null>();
  for (const app of apps) {
    if (!present.has(app._id)) continue;
    if (app.logoStorageId && !logoUrlCache.has(app.logoStorageId)) {
      logoUrlCache.set(app.logoStorageId, await ctx.storage.getUrl(app.logoStorageId));
    }
  }
  return rows.map((r) => {
    const app = appMap.get(r.sourceAppId);
    return {
      ...r,
      actions: r.actions ? (r.actions as NotifAction[]).map(publicAction) : r.actions,
      sourceAppName: app?.name ?? 'unknown',
      sourceAppLogoUrl: app?.logoStorageId ? (logoUrlCache.get(app.logoStorageId) ?? null) : null,
      sourceAppLogoColor: app?.logoColor ?? null
    };
  });
}

/**
 * Feed for the mobile app. Newest first, paginated. Includes notifications
 * from apps the user owns AND apps shared with them.
 *
 * There's no single index over "notifications visible to this viewer" —
 * `notifications.ownerId` is the bill-paying owner, not the viewer — so the
 * feed is a merge across one indexed stream per accessible app.
 *
 * This used to `take(limit)` from every app and slice the merged result, which
 * read `limit × accessible-app-count` documents to return `limit`: ten apps at
 * a 100-row page read 1,000 rows to show 100, and "load older" re-read the
 * whole prefix at a larger limit. `mergedStream` walks the same per-app indexes
 * lazily, pulling only as far into each as the page actually needs, and gives
 * real cursors so a second page starts where the first stopped.
 */
export const listMine = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const accessible = await listAccessibleSourceApps(ctx, userId);
    if (accessible.length === 0) {
      return { page: [], isDone: true, continueCursor: '' };
    }

    const streams = accessible.map(({ app }) =>
      stream(ctx.db, schema)
        .query('notifications')
        .withIndex('by_sourceApp_created', (q) => q.eq('sourceAppId', app._id))
        .order('desc')
    );
    const result = await mergedStream(streams, ['createdAt']).paginate(args.paginationOpts);

    return {
      ...result,
      page: await withSourceApp(
        ctx,
        result.page,
        accessible.map(({ app }) => app)
      )
    };
  }
});

/**
 * The newest notifications across every accessible app, bounded and
 * unpaginated — for consumers that want a small fixed window rather than a
 * scrollable feed (the home-screen widget snapshot).
 *
 * Keeps the merge-and-slice shape on purpose: at this size the read is
 * `limit × app-count` with a small limit, and a cursor would buy nothing.
 */
export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const limit = Math.min(args.limit ?? 20, LIST_RECENT_MAX);
    const accessible = await listAccessibleSourceApps(ctx, userId);
    if (accessible.length === 0) return [];

    const perApp = await Promise.all(
      accessible.map(({ app }) =>
        ctx.db
          .query('notifications')
          .withIndex('by_sourceApp_created', (q) => q.eq('sourceAppId', app._id))
          .order('desc')
          .take(limit)
      )
    );
    const rows = perApp
      .flat()
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return await withSourceApp(
      ctx,
      rows,
      accessible.map(({ app }) => app)
    );
  }
});

/** Hard ceiling for `listRecent`, which reads this many rows per app. */
const LIST_RECENT_MAX = 50;

export const markRead = mutation({
  args: {
    id: v.id('notifications'),
    // Optional: the device that surfaced this notification, recorded on
    // the row when it also acknowledges an ack-required notification.
    deviceId: v.optional(v.id('devices'))
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError('Notification not found');
    const access = await getSourceAppRole(ctx, row.sourceAppId, userId);
    if (!access) throw new ConvexError('Notification not found');
    const now = Date.now();
    const patch: {
      readAt?: number;
      acknowledgedAt?: number;
      acknowledgedByDeviceId?: Id<'devices'>;
    } = {};
    if (!row.readAt) patch.readAt = now;
    // Tapping a row counts as an acknowledgement — this is what stops the
    // escalation loop for ack-required notifications.
    if (row.ack && !row.acknowledgedAt) {
      patch.acknowledgedAt = now;
      if (args.deviceId) patch.acknowledgedByDeviceId = args.deviceId;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch);
    }
  }
});

/**
 * Toggle a single notification's read state — backs the feed's leading
 * swipe (mark read / mark unread). Clearing `readAt` returns the row to the
 * unread state; `patch` with `undefined` removes the optional field.
 */
export const setRead = mutation({
  args: {
    id: v.id('notifications'),
    read: v.boolean()
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError('Notification not found');
    const access = await getSourceAppRole(ctx, row.sourceAppId, userId);
    if (!access) throw new ConvexError('Notification not found');
    if (args.read && !row.readAt) {
      await ctx.db.patch(args.id, { readAt: Date.now() });
    } else if (!args.read && row.readAt) {
      await ctx.db.patch(args.id, { readAt: undefined });
    }
  }
});

/**
 * Mark the feed read. Covers every app the caller can see — owned and shared —
 * since `readAt` is per-notification, not per-viewer.
 *
 * Pass `sourceAppId` to mark a single app read; the mobile feed sends the app
 * it's filtered to so the button acts on exactly what's on screen. An id the
 * caller has no access to marks nothing.
 */
export const markAllRead = mutation({
  args: { sourceAppId: v.optional(v.id('sourceApps')) },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const all = await listAccessibleSourceApps(ctx, userId);
    const accessible = args.sourceAppId
      ? all.filter(({ app }) => app._id === args.sourceAppId)
      : all;
    const now = Date.now();
    let total = 0;
    for (const { app } of accessible) {
      const unread = await ctx.db
        .query('notifications')
        .withIndex('by_sourceApp_read', (q) => q.eq('sourceAppId', app._id).eq('readAt', undefined))
        .take(500);
      for (const n of unread) {
        await ctx.db.patch(n._id, { readAt: now });
      }
      total += unread.length;
    }
    return total;
  }
});

// Cascade-delete a notification's per-device delivery rows and action events,
// then the notification itself. Direct callers (deleteOne / clearAll) need
// this because the daily cleanup cron is the only other code path that knows
// to chase the children.
async function deleteNotificationCascade(ctx: MutationCtx, id: Id<'notifications'>) {
  const deliveries = await ctx.db
    .query('deliveries')
    .withIndex('by_notification', (q) => q.eq('notificationId', id))
    .collect();
  for (const d of deliveries) await ctx.db.delete(d._id);
  const events = await ctx.db
    .query('actionEvents')
    .withIndex('by_notification', (q) => q.eq('notificationId', id))
    .collect();
  for (const e of events) await ctx.db.delete(e._id);
  await ctx.db.delete(id);
}

export const deleteOne = mutation({
  args: { id: v.id('notifications') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError('Notification not found');
    // Only the source-app owner can delete — members would otherwise be
    // able to wipe a notification from every other member's feed.
    if (row.ownerId !== userId) {
      throw new ConvexError('Only the app owner can delete notifications');
    }
    await deleteNotificationCascade(ctx, args.id);
  }
});

/**
 * Clear the feed. Only deletes notifications from apps the caller owns —
 * shared apps stay visible because clearing them would affect other members.
 *
 * Pass `sourceAppId` to clear a single app — the mobile feed sends the app
 * it's filtered to, so Clear wipes exactly what's on screen and nothing else.
 */
const CLEAR_BATCH = 200;

/** One bounded batch of `clearAll`; returns how many notifications it deleted. */
async function clearBatch(ctx: MutationCtx, ownerId: string, sourceAppId?: Id<'sourceApps'>) {
  const batch = sourceAppId
    ? await ctx.db
        .query('notifications')
        .withIndex('by_sourceApp_created', (q) => q.eq('sourceAppId', sourceAppId))
        // The by-app index isn't scoped to the caller, so drop anything
        // they don't own — same rule the unfiltered path gets for free.
        .filter((q) => q.eq(q.field('ownerId'), ownerId))
        .take(CLEAR_BATCH)
    : await ctx.db
        .query('notifications')
        .withIndex('by_owner_created', (q) => q.eq('ownerId', ownerId))
        .take(CLEAR_BATCH);
  for (const n of batch) {
    await deleteNotificationCascade(ctx, n._id);
  }
  return batch.length;
}

/**
 * Clears the first batch now and the rest in the background, one batch per
 * transaction — a single loop over thousands of rows hits Convex's write limits
 * and fails every time. Returns 0 only when there was nothing to clear.
 */
export const clearAll = mutation({
  args: { sourceAppId: v.optional(v.id('sourceApps')) },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const deleted = await clearBatch(ctx, ownerId, args.sourceAppId);
    if (deleted === CLEAR_BATCH) {
      await ctx.scheduler.runAfter(0, internal.notifications.clearAllContinue, {
        ownerId,
        sourceAppId: args.sourceAppId
      });
    }
    return deleted;
  }
});

export const clearAllContinue = internalMutation({
  args: { ownerId: v.string(), sourceAppId: v.optional(v.id('sourceApps')) },
  handler: async (ctx, args) => {
    const deleted = await clearBatch(ctx, args.ownerId, args.sourceAppId);
    if (deleted === CLEAR_BATCH) {
      await ctx.scheduler.runAfter(0, internal.notifications.clearAllContinue, args);
    }
  }
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const accessible = await listAccessibleSourceApps(ctx, userId);
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

/**
 * Send a test push from one of the caller's source apps to their own devices.
 * Mirrors the /notify pipeline (quota check, notifications row, scheduled
 * delivery) but skips the bearer-token step since the caller is already
 * authenticated. Counts against the bill-paying owner's monthly quota the
 * same way an HTTP /notify call would.
 */
export const sendTest = mutation({
  args: { sourceAppId: v.id('sourceApps') },
  returns: v.object({ id: v.id('notifications') }),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const access = await getSourceAppRole(ctx, args.sourceAppId, userId);
    if (!access || (access.role !== 'owner' && access.role !== 'editor')) {
      throw new ConvexError('Only owners and editors can send test pushes');
    }
    const app = access.app;
    if (!app.enabled) {
      throw new ConvexError('Source app is disabled — re-enable it first');
    }

    await touchLastUsed(ctx, app);

    const notificationId = await ctx.db.insert('notifications', {
      ownerId: app.ownerId,
      sourceAppId: app._id,
      title: `Test push from ${app.name}`,
      body: "If you're seeing this on your phone, pushr is working.",
      priority: 5,
      createdAt: Date.now(),
      attemptedDeviceCount: 0,
      successDeviceCount: 0
    });
    await ctx.scheduler.runAfter(0, internal.expoPush.deliver, {
      notificationId
    });
    return { id: notificationId };
  }
});

/**
 * Dev-only: drop a feed notification with a full set of actions so the action
 * button styling can be eyeballed in the app. Clones owner/sourceApp from the
 * most recent notification so it lands in the current user's feed. Run with
 * `npx convex run notifications:devSeedActionDemo`. Not wired to any UI.
 */
export const devSeedActionDemo = internalMutation({
  args: {},
  returns: v.id('notifications'),
  handler: async (ctx) => {
    const recent = await ctx.db.query('notifications').order('desc').first();
    if (!recent) {
      throw new ConvexError('No existing notification to clone owner/app from');
    }
    return await ctx.db.insert('notifications', {
      ownerId: recent.ownerId,
      sourceAppId: recent.sourceAppId,
      title: 'Order #4821 needs review',
      body: 'Christian Preston placed an order — $207.60 (1 item). Choose an action below.',
      priority: 5,
      createdAt: Date.now(),
      attemptedDeviceCount: 0,
      successDeviceCount: 0,
      actions: [
        {
          kind: 'callback',
          id: 'confirm',
          label: 'Confirm payment',
          callbackUrl: 'https://example.com/cb'
        },
        {
          kind: 'reply',
          id: 'reply',
          label: 'Reply',
          callbackUrl: 'https://example.com/cb',
          placeholder: 'Type a reply'
        },
        {
          kind: 'open_url',
          id: 'view',
          label: 'View order',
          url: 'https://example.com'
        },
        {
          kind: 'callback',
          id: 'dismiss',
          label: 'Dismiss',
          callbackUrl: 'https://example.com/cb',
          destructive: true
        }
      ]
    });
  }
});

/**
 * Internal: record delivery outcome after Expo Push responds.
 */
export const recordDelivery = internalMutation({
  args: {
    id: v.id('notifications'),
    attemptedDeviceCount: v.number(),
    successDeviceCount: v.number(),
    failureMessages: v.optional(v.array(v.string()))
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      attemptedDeviceCount: args.attemptedDeviceCount,
      successDeviceCount: args.successDeviceCount,
      failureMessages: args.failureMessages
    });
  }
});
