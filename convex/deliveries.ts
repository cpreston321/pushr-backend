import { v, ConvexError } from 'convex/values';
import { query, internalMutation, internalQuery } from './_generated/server';
import { requireAuth } from './lib/auth';
import { getSourceAppRole } from './lib/sharing';
import type { Id, Doc } from './_generated/dataModel';

/**
 * Per-device delivery rows. Inserted up-front when a notification is about
 * to be sent, then updated once Expo returns a ticket, then finalized by
 * the receipts poller.
 *
 * See schema.ts for the status lifecycle.
 */

/**
 * Bulk-insert `pending` rows for every device we're about to push to.
 * Returns the inserted row ids in the same order as the input devices so the
 * caller can correlate them with Expo ticket responses.
 */
export const insertPending = internalMutation({
  args: {
    notificationId: v.id('notifications'),
    deviceOwners: v.array(
      v.object({
        deviceId: v.id('devices'),
        ownerId: v.string()
      })
    ),
    round: v.optional(v.number())
  },
  returns: v.array(v.object({ id: v.id('deliveries'), status: v.string() })),
  // Idempotent: the push pool retries `deliver`, and a retry must reuse the
  // rows (and skip devices already sent to) rather than add a second set.
  handler: async (ctx, args) => {
    const now = Date.now();
    const round = args.round ?? 0;
    const existing = new Map(
      (
        await ctx.db
          .query('deliveries')
          .withIndex('by_notification', (q) => q.eq('notificationId', args.notificationId))
          .collect()
      ).map((d) => [d.deviceId, d])
    );
    const out: { id: Id<'deliveries'>; status: string }[] = [];
    for (const { deviceId, ownerId } of args.deviceOwners) {
      const prev = existing.get(deviceId);
      // An escalation round re-sends to every device, but a pool retry within
      // the same round must still skip devices that round already reached.
      if (prev && round > (prev.round ?? 0)) {
        await ctx.db.patch(prev._id, {
          status: 'pending',
          round,
          attempts: prev.attempts + 1,
          lastAttemptAt: now,
          expoTicketId: undefined,
          errorCode: undefined,
          errorMessage: undefined,
          finalizedAt: undefined
        });
        out.push({ id: prev._id, status: 'pending' });
        continue;
      }
      if (prev) {
        if (prev.status === 'pending') {
          await ctx.db.patch(prev._id, { attempts: prev.attempts + 1, lastAttemptAt: now });
        }
        out.push({ id: prev._id, status: prev.status });
        continue;
      }
      const id = await ctx.db.insert('deliveries', {
        notificationId: args.notificationId,
        deviceId,
        ownerId,
        status: 'pending',
        attempts: 1,
        firstAttemptAt: now,
        lastAttemptAt: now,
        round
      });
      out.push({ id, status: 'pending' });
    }
    return out;
  }
});

/**
 * Apply Expo ticket outcomes to previously-inserted delivery rows.
 * `outcomes[i]` corresponds to `deliveryIds[i]` in order.
 */
export const applyTicketOutcomes = internalMutation({
  args: {
    outcomes: v.array(
      v.object({
        deliveryId: v.id('deliveries'),
        status: v.union(v.literal('queued'), v.literal('failed'), v.literal('invalid')),
        expoTicketId: v.optional(v.string()),
        errorCode: v.optional(v.string()),
        errorMessage: v.optional(v.string())
      })
    )
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const o of args.outcomes) {
      const patch: Partial<Doc<'deliveries'>> = {
        status: o.status,
        expoTicketId: o.expoTicketId,
        errorCode: o.errorCode,
        errorMessage: o.errorMessage,
        lastAttemptAt: now
      };
      if (o.status !== 'queued') patch.finalizedAt = now;
      await ctx.db.patch(o.deliveryId, patch);
    }
  }
});

/**
 * Apply Expo receipt outcomes. Receipts are fetched ~15 min after send to
 * distinguish actually-delivered from accepted-but-dropped-by-APNs.
 */
export const applyReceiptOutcomes = internalMutation({
  args: {
    outcomes: v.array(
      v.object({
        deliveryId: v.id('deliveries'),
        status: v.union(v.literal('delivered'), v.literal('failed'), v.literal('invalid')),
        errorCode: v.optional(v.string()),
        errorMessage: v.optional(v.string())
      })
    )
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const o of args.outcomes) {
      await ctx.db.patch(o.deliveryId, {
        status: o.status,
        errorCode: o.errorCode,
        errorMessage: o.errorMessage,
        finalizedAt: now
      });
    }
  }
});

/**
 * Internal: list `queued` deliveries for a notification, for the receipts
 * poller to batch-fetch.
 */
export const queuedForNotification = internalQuery({
  args: { notificationId: v.id('notifications') },
  returns: v.array(
    v.object({
      deliveryId: v.id('deliveries'),
      deviceId: v.id('devices'),
      expoTicketId: v.string()
    })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('deliveries')
      .withIndex('by_notification', (q) => q.eq('notificationId', args.notificationId))
      .collect();
    return rows
      .filter((r) => r.status === 'queued' && r.expoTicketId !== undefined)
      .map((r) => ({
        deliveryId: r._id,
        deviceId: r.deviceId,
        expoTicketId: r.expoTicketId!
      }));
  }
});

/**
 * Public: list per-device delivery rows for one notification the caller owns.
 * Used by the mobile UI's notification-detail view.
 */
export const listForNotification = query({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const notif = await ctx.db.get(args.notificationId);
    if (!notif) throw new ConvexError('Notification not found');
    const access = await getSourceAppRole(ctx, notif.sourceAppId, userId);
    if (!access) throw new ConvexError('Notification not found');
    const rows = await ctx.db
      .query('deliveries')
      .withIndex('by_notification', (q) => q.eq('notificationId', args.notificationId))
      .collect();
    const deviceCache = new Map<Id<'devices'>, Doc<'devices'> | null>();
    const out = [];
    for (const r of rows) {
      let device = deviceCache.get(r.deviceId);
      if (device === undefined) {
        device = await ctx.db.get(r.deviceId);
        deviceCache.set(r.deviceId, device);
      }
      out.push({
        ...r,
        deviceName: device?.name ?? null,
        devicePlatform: device?.platform ?? null,
        deviceModel: device?.model ?? null
      });
    }
    out.sort((a, b) => a.firstAttemptAt - b.firstAttemptAt);
    return out;
  }
});
