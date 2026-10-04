import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { pushPool } from './workpools';
import type { NormalizedNotification } from '../hooks/types';

export type LiveActivityPayload = {
  action: 'start' | 'update' | 'end';
  activityId: string;
  state: {
    title?: string;
    status?: string;
    progress?: number;
    icon?: string;
    outcome?: 'success' | 'failure';
  };
  attributes?: { name?: string; logoUrl?: string };
  staleDate?: number;
  dismissAfter?: number;
  relevanceScore?: number;
};

export type SendArgs = {
  /** The app sending: by its bearer token, or by id when the caller already authorized it. */
  token?: string;
  sourceAppId?: Id<'sourceApps'>;
  normalized: NormalizedNotification;
  ack?: { timeoutSec: number; maxAttempts: number };
  liveActivity?: LiveActivityPayload;
  replaceKey?: string;
  critical?: boolean;
  deliverAt?: number;
  webhookProvider?: string;
  webhookEventType?: string;
  idempotencyKey?: string;
};

/**
 * Ingest → schedule delivery → schedule the first ack check. Shared by
 * /notify, the provider hooks and the MCP connector. Throws the ingest's
 * ConvexErrors (INVALID_TOKEN, QUOTA_EXCEEDED, …) for the caller to map.
 */
export async function sendNotification(
  ctx: ActionCtx,
  args: SendArgs
): Promise<{ notificationId: Id<'notifications'>; scheduledFor: number | null; replayed: boolean }> {
  const { notificationId, replayed, scheduledFor, ack } = await ctx.runMutation(internal.notifyInternal.ingest, {
    token: args.token,
    sourceAppId: args.sourceAppId,
    title: args.normalized.title,
    body: args.normalized.body,
    priority: args.normalized.priority,
    url: args.normalized.url,
    appUrl: args.normalized.appUrl,
    data: args.normalized.data,
    image: args.normalized.image,
    action: args.normalized.action,
    actions: args.normalized.actions,
    ack: args.ack,
    liveActivity: args.liveActivity,
    replaceKey: args.replaceKey,
    critical: args.critical,
    webhookProvider: args.webhookProvider,
    webhookEventType: args.webhookEventType ?? args.normalized.eventType,
    idempotencyKey: args.idempotencyKey,
    deliverAt: args.deliverAt
  });

  // A replay must not schedule anything: the original request already
  // enqueued delivery, forwarders and the ack check. Scheduling again is
  // exactly the double-push the key exists to prevent.
  if (replayed) return { notificationId, scheduledFor: scheduledFor ?? null, replayed: true };

  // A Live Activity step shows on the Lock Screen and Dynamic Island in
  // place of a banner; apns.dispatch sends the banner only when no device
  // can take the activity.
  if (args.deliverAt && args.deliverAt > Date.now() + 1_000) {
    if (!args.liveActivity) {
      await ctx.scheduler.runAt(args.deliverAt, internal.expoPush.deliver, {
        notificationId
      });
    }
    if (args.liveActivity) {
      await ctx.scheduler.runAt(args.deliverAt, internal.apns.dispatch, {
        notificationId
      });
    }
    // Forwarders (Slack/Discord) fire at the same time as device delivery —
    // a Pro/self-hosted feature, no-op when the source app has no
    // forwarders configured.
    await ctx.scheduler.runAt(args.deliverAt, internal.forwarders.fanOut, {
      notificationId
    });
  } else {
    if (!args.liveActivity) {
      await pushPool.enqueueAction(ctx, internal.expoPush.deliver, {
        notificationId
      });
    }
    if (args.liveActivity) {
      // APNs Live Activity — sent directly, not via Expo Push.
      await ctx.scheduler.runAfter(0, internal.apns.dispatch, {
        notificationId
      });
    }
    await ctx.scheduler.runAfter(0, internal.forwarders.fanOut, {
      notificationId
    });
  }

  // The ack the notification ended up with: the sender's, or one on-call added.
  if (ack) {
    // First escalation check fires `timeoutSec` after the initial send.
    // Anchor it on the scheduled delivery time so a future `deliverAt`
    // notification still gets a sane window.
    const baseline = args.deliverAt && args.deliverAt > Date.now() ? args.deliverAt : Date.now();
    await ctx.scheduler.runAt(baseline + ack.timeoutSec * 1000, internal.ack.checkAck, {
      notificationId
    });
  }


  return { notificationId, scheduledFor: args.deliverAt ?? null, replayed: false };
}
