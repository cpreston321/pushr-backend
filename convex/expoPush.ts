'use node';

import { v } from 'convex/values';
import { isInQuietHours } from './lib/quietHours';
import { interruptionLevelFor, type InterruptionLevel } from './lib/interruption';
import { publicAction } from './lib/actionsLayout';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { categoryForActions, layoutActions, type NotifAction } from './lib/actionsLayout';

type ExpoMessage = {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  priority?: 'default' | 'normal' | 'high';
  // iOS accepts "default", null, or the filename of a sound bundled in the app
  // binary (e.g. "chime.caf"). Android sounds are managed via notification
  // channels and this field is largely ignored.
  sound?: string | null;
  channelId?: string;
  badge?: number;
  richContent?: { image?: string };
  // iOS: the notification category id — maps to the actions the mobile app
  // registers with `Notifications.setNotificationCategoryAsync`.
  categoryId?: string;
  // iOS: flip `mutable-content: 1` in the APNs payload so our NSE runs.
  // Expo sets this automatically when richContent.image is present; we set
  // it explicitly to guarantee the NSE fires even for pushes without a
  // logo or attachment (it can still rewrite subtitle / title).
  mutableContent?: boolean;
  // iOS: flip `content-available: 1` so iOS briefly wakes the main app in
  // the background when the push arrives. Used for Live Activity flows so
  // the activity observer can register the per-activity push-update token
  // even if the app was terminated when the push-to-start landed.
  _contentAvailable?: boolean;
  interruptionLevel?: InterruptionLevel;
};

const CATEGORY_ID = 'pushr.default';
const ACTION_CATEGORY_ID = 'pushr.action';

type ExpoTicket =
  | { status: 'ok'; id: string }
  | {
      status: 'error';
      message: string;
      details?: { error?: string; expoPushToken?: string };
    };

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Wait this long after sending before polling Expo for delivery receipts.
// Expo recommends >= 15 minutes; receipts are retained for a day.
const RECEIPTS_DELAY_MS = 15 * 60 * 1000;

/**
 * Deliver one pushr notification to every enabled device of the owner.
 * Called from the /notify HTTP endpoint via the push workpool so delivery
 * retries don't block the HTTP response.
 *
 * `opts.forceHighPriority` is used by the ack-or-escalate re-push path:
 * when true, delivery ignores quiet hours and the user's priority-bucket
 * sound mapping, sending as high-priority with default sound. The
 * notification row's `priority` is not mutated.
 */
export const deliver = internalAction({
  args: {
    notificationId: v.id('notifications'),
    forceHighPriority: v.optional(v.boolean()),
    /** Ack escalation round; a new round re-sends to devices already pushed. */
    round: v.optional(v.number())
  },
  handler: async (ctx, { notificationId, forceHighPriority, round }) => {
    const notif = await ctx.runQuery(internal.expoPushHelpers.getNotification, {
      id: notificationId
    });
    if (!notif) return;

    const muted = await ctx.runQuery(internal.expoPushHelpers.isSourceAppMuted, {
      id: notif.sourceAppId
    });
    if (muted) {
      await ctx.runMutation(internal.notifications.recordDelivery, {
        id: notificationId,
        attemptedDeviceCount: 0,
        successDeviceCount: 0,
        failureMessages: ['source app muted']
      });
      return;
    }

    const devices = await ctx.runQuery(internal.expoPushHelpers.activeDevicesForSourceApp, {
      sourceAppId: notif.sourceAppId
    });
    if (devices.length === 0) {
      await ctx.runMutation(internal.notifications.recordDelivery, {
        id: notificationId,
        attemptedDeviceCount: 0,
        successDeviceCount: 0
      });
      return;
    }

    const appInfo = await ctx.runQuery(internal.expoPushHelpers.getSourceAppInfo, {
      id: notif.sourceAppId
    });
    // Escalation re-pushes must break through quiet hours — that's the whole
    // point of an un-acked alarm.
    const quiet = forceHighPriority
      ? false
      : isInQuietHours(appInfo?.quietStart, appInfo?.quietEnd, appInfo?.quietTimeZone);

    const priority = forceHighPriority ? 'high' : quiet ? 'default' : mapPriority(notif.priority);
    const { sound: rawSound } = await ctx.runQuery(internal.userPrefs.soundForDelivery, {
      ownerId: notif.ownerId,
      priority: notif.priority
    });
    const sound = forceHighPriority ? 'default' : quiet ? null : rawSound;
    const logoUrl = appInfo?.logoUrl ?? null;
    const sourceAppName = appInfo?.name ?? 'unknown';
    const richActions = (notif.actions ?? undefined) as NotifAction[] | undefined;
    const categoryId = richActions
      ? categoryForActions(richActions)
      : notif.action
        ? ACTION_CATEGORY_ID
        : CATEGORY_ID;
    // Slots carry the ios identifier assignment (act_1/act_2/reply) so the
    // mobile response listener can map back to the user-provided action.
    const actionSlots = richActions
      ? layoutActions(richActions).map((s) => ({
          identifier: s.identifier,
          action: publicAction(s.action)
        }))
      : undefined;
    const data = {
      ...notif.data,
      notificationId,
      sourceAppId: notif.sourceAppId,
      sourceAppName,
      url: notif.url,
      appUrl: notif.appUrl,
      logoUrl,
      contentImage: notif.image,
      action: notif.action,
      actions: actionSlots,
      ackRequired: notif.ack !== undefined && notif.acknowledgedAt === undefined
      // `liveActivity` is intentionally NOT included in the Expo push data.
      // Live Activity lifecycle is driven by the APNs direct-path action
      // (see convex/apns.ts) so the activity can start/update/end even
      // when the app is terminated.
    };

    // Insert per-device delivery rows BEFORE hitting Expo so we can correlate
    // each ticket back to a device. `rows[i]` maps to `devices[i]`.
    // Each delivery row is stamped with its device's owner so members'
    // deliveries are scoped to them, not the source-app's bill-payer.
    const rows: { id: Id<'deliveries'>; status: string }[] = await ctx.runMutation(
      internal.deliveries.insertPending,
      {
        notificationId,
        round,
        deviceOwners: devices.map((d) => ({
          deviceId: d._id,
          ownerId: d.ownerId
        }))
      }
    );

    // `richContent.image` is what Expo uses to flip `mutable-content: 1` in
    // the APNs payload, which is what invokes our NSE (for sender avatars).
    // So we always set it — but the NSE ignores this field and only attaches
    // the separate `data.contentImage` field if the caller explicitly passed
    // `image` to /notify. Result: NSE always runs, attachment only shows
    // when requested.
    const richImage = notif.image ?? logoUrl;
    const wakeApp = notif.liveActivity !== undefined;
    if (wakeApp) {
      console.log(
        `[expo] live activity flow — setting _contentAvailable=true on ${devices.length} message(s)`
      );
    }

    // Per-recipient unread count → APNs `badge` so the home-screen icon
    // updates when the push arrives, even with the app terminated. Each
    // recipient (bill-paying owner + members) sees their own count, so we
    // dedupe by ownerId before querying.
    const uniqueOwners = Array.from(new Set(devices.map((d) => d.ownerId)));
    const badgeByOwner = new Map<string, number>();
    await Promise.all(
      uniqueOwners.map(async (ownerId) => {
        const count = await ctx.runQuery(internal.expoPushHelpers.unreadCountForOwner, { ownerId });
        badgeByOwner.set(ownerId, count);
      })
    );

    const level = interruptionLevelFor({
      priority: notif.priority,
      needsAck: notif.ack !== undefined && notif.acknowledgedAt === undefined,
      escalation: !!forceHighPriority,
      quiet
    });
    const message = (d: (typeof devices)[number]): ExpoMessage => ({
      to: d.expoPushToken,
      title: notif.title,
      body: notif.body,
      data,
      priority,
      sound,
      channelId: 'default',
      categoryId,
      badge: badgeByOwner.get(d.ownerId),
      richContent: richImage ? { image: richImage } : undefined,
      mutableContent: true,
      interruptionLevel: level,
      // Wake the main app in the background for Live Activity flows so the
      // ActivityKit observer can emit the per-activity update token even
      // when the app was terminated at start-push time.
      _contentAvailable: wakeApp ? true : undefined
    });

    // Rows settled by an earlier attempt already count; only pending ones are sent.
    let success = rows.filter((r) => r.status === 'queued' || r.status === 'delivered').length;
    const pending = devices
      .map((device, i) => ({ device, deliveryId: rows[i].id, status: rows[i].status }))
      .filter((p) => p.status === 'pending');
    const failures: string[] = [];

    // Outcomes are recorded per chunk, so if a later chunk throws and the pool
    // retries, devices in earlier chunks are no longer pending and aren't
    // pushed twice.
    for (let i = 0; i < pending.length; i += EXPO_CHUNK) {
      const chunk = pending.slice(i, i + EXPO_CHUNK);
      let tickets: ExpoTicket[];
      try {
        tickets = await sendToExpo(chunk.map((p) => message(p.device)));
      } catch (err) {
        await ctx.runMutation(internal.notifications.recordDelivery, {
          id: notificationId,
          attemptedDeviceCount: devices.length,
          successDeviceCount: success,
          failureMessages: [...failures, `Expo unavailable: ${err instanceof Error ? err.message : String(err)}`]
        });
        throw err;
      }

      const invalidDeviceIds: Id<'devices'>[] = [];
      const outcomes: Array<{
        deliveryId: Id<'deliveries'>;
        status: 'queued' | 'failed' | 'invalid';
        expoTicketId?: string;
        errorCode?: string;
        errorMessage?: string;
      }> = [];
      tickets.forEach((ticket, j) => {
        const { device, deliveryId } = chunk[j];
        if (ticket.status === 'ok') {
          success += 1;
          outcomes.push({ deliveryId, status: 'queued', expoTicketId: ticket.id });
          return;
        }
        failures.push(`${device.expoPushToken.slice(0, 20)}…: ${ticket.message}`);
        const invalid = ticket.details?.error === 'DeviceNotRegistered';
        if (invalid) invalidDeviceIds.push(device._id);
        outcomes.push({
          deliveryId,
          status: invalid ? 'invalid' : 'failed',
          errorCode: ticket.details?.error,
          errorMessage: ticket.message
        });
      });
      await ctx.runMutation(internal.deliveries.applyTicketOutcomes, { outcomes });
      for (const id of invalidDeviceIds) {
        await ctx.runMutation(internal.devices.markInvalid, { id });
      }
    }

    await ctx.runMutation(internal.notifications.recordDelivery, {
      id: notificationId,
      attemptedDeviceCount: devices.length,
      successDeviceCount: success,
      failureMessages: failures.length > 0 ? failures : undefined
    });

    // Schedule receipts poll so we can finalize delivered/failed statuses.
    // Only bother if at least one ticket was accepted.
    if (success > 0) {
      await ctx.scheduler.runAfter(RECEIPTS_DELAY_MS, internal.expoReceipts.checkForNotification, {
        notificationId
      });
    }
  }
});

function mapPriority(p: number | undefined): 'default' | 'high' {
  if (p === undefined) return 'default';
  return p >= 7 ? 'high' : 'default';
}

const EXPO_CHUNK = 100;

/** One Expo request; callers keep chunks at or under EXPO_CHUNK messages. */
async function sendToExpo(messages: ExpoMessage[]): Promise<ExpoTicket[]> {
  if (messages.length === 0) return [];
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    Accept: 'application/json'
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(messages)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Expo push failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data: ExpoTicket[] };
  return json.data;
}
