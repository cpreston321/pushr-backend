import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

/**
 * Expo Push receipts. The push-send response (ticket) only means Expo
 * accepted the message — not that APNs/FCM delivered it. To learn the true
 * delivery outcome we must poll
 *
 *   POST https://exp.host/--/api/v2/push/getReceipts
 *
 * 15+ minutes after send. Receipts older than a day are discarded by Expo,
 * so we only check once.
 *
 * Ref: https://docs.expo.dev/push-notifications/sending-notifications/#push-receipt-response-format
 */

const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

type Receipt =
  | { status: 'ok' }
  | {
      status: 'error';
      message?: string;
      details?: { error?: string };
    };

export const checkForNotification = internalAction({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, { notificationId }) => {
    const queued = await ctx.runQuery(internal.deliveries.queuedForNotification, {
      notificationId
    });
    if (queued.length === 0) return;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (process.env.EXPO_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    }

    // Expo recommends chunking receipts requests to <= 1000 ids.
    type ReceiptMap = Record<string, Receipt>;
    const receiptsById: ReceiptMap = {};
    for (let i = 0; i < queued.length; i += 1000) {
      const chunk = queued.slice(i, i + 1000);
      const res = await fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: chunk.map((q) => q.expoTicketId) })
      });
      if (!res.ok) {
        // Leave rows as "queued" so a future manual check can re-try.
        // Surface the error for observability.
        const text = await res.text();
        throw new Error(`Expo receipts fetch failed: ${res.status} ${text}`);
      }
      const json = (await res.json()) as { data: ReceiptMap };
      Object.assign(receiptsById, json.data ?? {});
    }

    const outcomes: Array<{
      deliveryId: Id<'deliveries'>;
      status: 'delivered' | 'failed' | 'invalid';
      errorCode?: string;
      errorMessage?: string;
    }> = [];
    const invalidDeviceIds: Id<'devices'>[] = [];

    for (const q of queued) {
      const r = receiptsById[q.expoTicketId];
      // Missing receipts are ignored — Expo may not have one yet. A future
      // enhancement could reschedule another poll; for now we leave the row
      // as "queued" rather than fabricating a status.
      if (!r) continue;
      if (r.status === 'ok') {
        outcomes.push({ deliveryId: q.deliveryId, status: 'delivered' });
        continue;
      }
      const code = r.details?.error;
      const message = r.message;
      if (code === 'DeviceNotRegistered') {
        outcomes.push({
          deliveryId: q.deliveryId,
          status: 'invalid',
          errorCode: code,
          errorMessage: message
        });
        invalidDeviceIds.push(q.deviceId);
      } else {
        outcomes.push({
          deliveryId: q.deliveryId,
          status: 'failed',
          errorCode: code,
          errorMessage: message
        });
      }
    }

    if (outcomes.length > 0) {
      await ctx.runMutation(internal.deliveries.applyReceiptOutcomes, {
        outcomes
      });
    }
    for (const id of invalidDeviceIds) {
      await ctx.runMutation(internal.devices.markInvalid, { id });
    }
  }
});
