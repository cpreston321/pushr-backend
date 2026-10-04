import { v, ConvexError } from 'convex/values';
import { mutation, internalAction, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { requireAuth } from './lib/auth';
import { getSourceAppRole } from './lib/sharing';
import { pushPool } from './lib/workpools';

/**
 * Ack-or-escalate.
 *
 * When a notification is ingested with `ack: { timeoutSec, maxAttempts }`,
 * pushr schedules a `checkAck` run after `timeoutSec`. If the user has not
 * acknowledged by then, we re-deliver the notification at high priority
 * (ignoring quiet hours) and schedule another check. We stop once either
 * the notification is acknowledged or `maxAttempts` re-pushes have been
 * sent (not counting the initial delivery).
 *
 * A notification is acknowledged by calling `ack.acknowledge` from the
 * mobile client. Tapping a row in the feed calls `notifications.markRead`,
 * which in turn calls into `markAcknowledged` when `ack` is set.
 */

/**
 * Public: acknowledge a notification. Safe to call multiple times — the
 * first call wins and subsequent calls are no-ops.
 */
export const acknowledge = mutation({
  args: {
    id: v.id('notifications'),
    deviceId: v.optional(v.id('devices'))
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError('Notification not found');
    const access = await getSourceAppRole(ctx, row.sourceAppId, userId);
    if (!access) throw new ConvexError('Notification not found');
    if (row.acknowledgedAt) return;
    await ctx.db.patch(args.id, {
      acknowledgedAt: Date.now(),
      acknowledgedByDeviceId: args.deviceId
    });
  }
});

/**
 * Internal: used by the notifications feed's markRead to mirror the ack
 * side-effect without going through the public mutation.
 */
export const markAcknowledgedInternal = internalMutation({
  args: {
    id: v.id('notifications'),
    deviceId: v.optional(v.id('devices'))
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.acknowledgedAt || !row.ack) return;
    await ctx.db.patch(args.id, {
      acknowledgedAt: Date.now(),
      acknowledgedByDeviceId: args.deviceId
    });
  }
});

/**
 * Internal: increment the `ack.attempts` counter. Called from checkAck
 * right before it schedules a re-delivery.
 */
export const bumpAttempts = internalMutation({
  args: { id: v.id('notifications') },
  returns: v.object({
    attempts: v.number(),
    maxAttempts: v.number(),
    timeoutSec: v.number()
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || !row.ack) {
      throw new ConvexError('Notification has no ack config');
    }
    const next = row.ack.attempts + 1;
    const esc = row.escalation;
    await ctx.db.patch(args.id, {
      ack: { ...row.ack, attempts: next },
      // On-call: each unanswered round reaches one more person.
      ...(esc && esc.level < esc.order.length - 1 ? { escalation: { ...esc, level: esc.level + 1 } } : {})
    });
    return {
      attempts: next,
      maxAttempts: row.ack.maxAttempts,
      timeoutSec: row.ack.timeoutSec
    };
  }
});

/**
 * Scheduled action. Runs `timeoutSec` after the most recent send.
 * - If already acknowledged → stop.
 * - Otherwise, if attempts < maxAttempts, re-deliver (forced high priority)
 *   and schedule the next check.
 * - Otherwise, stop.
 */
export const checkAck = internalAction({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, { notificationId }) => {
    const notif = await ctx.runQuery(internal.expoPushHelpers.getNotification, {
      id: notificationId
    });
    if (!notif || !notif.ack) return;
    if (notif.acknowledgedAt) return;
    // A replacement carries its own ack, if it asked for one.
    if (notif.replacedBy) return;
    if (notif.ack.attempts >= notif.ack.maxAttempts) return;

    const bumped = await ctx.runMutation(internal.ack.bumpAttempts, {
      id: notificationId
    });
    await pushPool.enqueueAction(ctx, internal.expoPush.deliver, {
      notificationId,
      forceHighPriority: true,
      round: bumped.attempts
    });
    if (bumped.attempts < bumped.maxAttempts) {
      await ctx.scheduler.runAfter(bumped.timeoutSec * 1000, internal.ack.checkAck, {
        notificationId
      });
    }
  }
});
