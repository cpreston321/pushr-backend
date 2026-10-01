import { v, ConvexError } from 'convex/values';
import { unsafeCallbackReason } from './lib/safeUrl';
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx
} from './_generated/server';
import { internal } from './_generated/api';
import { requireAuth } from './lib/auth';
import { getSourceAppRole } from './lib/sharing';
import { resolveActionIdentifier, type NotifAction } from './lib/actionsLayout';
import type { Id, Doc } from './_generated/dataModel';

/**
 * Interactive notification actions.
 *
 * `invoke` is the mobile app's entrypoint for reporting an action tap:
 *   - `open_url`  → recorded, mobile also opens the URL via Linking.
 *   - `callback`  → recorded, pushr POSTs {notificationId, actionId,
 *                    respondedAt} to the source app's callbackUrl with an
 *                    HMAC-SHA256 signature (X-Pushr-Signature).
 *   - `reply`     → same as callback, plus { reply: <userText> } in body.
 *
 * Outbound POSTs are currently unsigned — `X-Pushr-Signature` is omitted
 * pending a dedicated callback-signing key on the source app. The receiver
 * should authenticate via `X-Pushr-Source` + their own bearer/secret on
 * the callbackUrl (e.g. embed it in the URL).
 */

const CALLBACK_TIMEOUT_MS = 10_000;
const MAX_REPLY_CHARS = 2_000;

/**
 * Public action called by the mobile notification response listener.
 */
export const invoke = action({
  args: {
    notificationId: v.id('notifications'),
    actionIdentifier: v.string(), // "act_1" | "act_2" | "reply" | raw action id
    reply: v.optional(v.string()),
    deviceId: v.optional(v.id('devices'))
  },
  returns: v.object({
    ok: v.boolean(),
    kind: v.optional(v.union(v.literal('open_url'), v.literal('callback'), v.literal('reply'))),
    url: v.optional(v.string()),
    /** The action was already spent — nothing was sent this time. */
    alreadyDone: v.optional(v.boolean()),
    /** Another tap is mid-flight; this one deliberately did nothing. */
    pending: v.optional(v.boolean()),
    at: v.optional(v.number()),
    detail: v.optional(v.string()),
    callbackStatus: v.optional(v.number()),
    callbackError: v.optional(v.string())
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    ok: boolean;
    kind?: 'open_url' | 'callback' | 'reply';
    url?: string;
    alreadyDone?: boolean;
    pending?: boolean;
    at?: number;
    detail?: string;
    callbackStatus?: number;
    callbackError?: string;
  }> => {
    const resolved: {
      action: NotifAction | null;
      ownerId: string;
      callerId: string;
      role: string;
    } = await ctx.runQuery(internal.actions.resolveForInvoke, {
      notificationId: args.notificationId,
      actionIdentifier: args.actionIdentifier
    });
    if (!resolved.action) {
      return { ok: false };
    }
    const act = resolved.action;
    if (act.kind !== 'open_url' && resolved.role === 'viewer') {
      throw new ConvexError('Viewers can open links but not run actions');
    }
    if (args.reply !== undefined && args.reply.length > MAX_REPLY_CHARS) {
      throw new ConvexError(`Replies are limited to ${MAX_REPLY_CHARS} characters`);
    }

    // Claim the action under the user who took it — for shared apps this is the
    // member, not the source-app's bill-payer. The claim is what makes a
    // callback fire at most once: a second tap comes back `done` or `pending`
    // instead of POSTing again.
    const claim:
      | { status: 'claimed'; eventId: Id<'actionEvents'> }
      | { status: 'done'; at: number; detail?: string }
      | { status: 'pending' } = await ctx.runMutation(internal.actions.claimEventInternal, {
      notificationId: args.notificationId,
      ownerId: resolved.callerId,
      actionId: act.id,
      actionKind: act.kind,
      deviceId: args.deviceId,
      reply: args.reply
    });
    if (claim.status === 'done') {
      return {
        ok: true,
        kind: act.kind,
        alreadyDone: true,
        at: claim.at,
        detail: claim.detail
      };
    }
    if (claim.status === 'pending') {
      return { ok: true, kind: act.kind, pending: true };
    }
    const eventId: Id<'actionEvents'> = claim.eventId;

    if (act.kind === 'open_url') {
      return { ok: true, kind: 'open_url' as const, url: act.url };
    }

    // callback or reply — POST to source app's callback URL.
    const body = JSON.stringify({
      notificationId: args.notificationId,
      actionId: act.id,
      respondedAt: Date.now(),
      ...(act.kind === 'reply' && args.reply !== undefined ? { reply: args.reply } : {})
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'pushr/1.0',
      'X-Pushr-Source': 'pushr',
      'X-Pushr-Notification': String(args.notificationId),
      'X-Pushr-Action': act.id
    };

    let callbackStatus: number | undefined;
    let callbackError: string | undefined;
    // Re-checked here as well as at /notify: rows stored before the check
    // existed would otherwise still be callable.
    const unsafe = unsafeCallbackReason(act.callbackUrl);
    if (unsafe) {
      callbackError = unsafe;
    } else {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
        const res = await fetch(act.callbackUrl, {
          method: 'POST',
          headers,
          body,
          // A redirect could point anywhere, including addresses the URL check
          // would have refused.
          redirect: 'manual',
          signal: controller.signal
        });
        clearTimeout(timeout);
        callbackStatus = res.status;
        // Only the status is kept; echoing the body back would let a token
        // holder read responses from whatever the URL reaches.
        if (res.status >= 300 && res.status < 400) {
          callbackError = `HTTP ${res.status} (redirects are not followed)`;
        } else if (!res.ok) {
          callbackError = `HTTP ${res.status}`;
        }
      } catch (err) {
        callbackError =
          err instanceof Error && err.name === 'AbortError' ? 'Timed out' : 'Request failed';
      }
    }

    const settled: { ok: boolean; at: number; detail?: string } = await ctx.runMutation(
      internal.actions.settleEventInternal,
      {
        id: eventId,
        callbackStatus,
        callbackError
      }
    );

    return {
      ok: settled.ok,
      kind: act.kind,
      at: settled.at,
      detail: settled.detail,
      callbackStatus,
      callbackError
    };
  }
});

/**
 * Internal: resolve action identifier → action definition for the caller.
 */
export const resolveForInvoke = internalQuery({
  args: {
    notificationId: v.id('notifications'),
    actionIdentifier: v.string()
  },
  handler: async (ctx, args) => {
    const callerId = await requireAuth(ctx);
    const notif = await ctx.db.get(args.notificationId);
    if (!notif) {
      throw new ConvexError('Notification not found');
    }
    const access = await getSourceAppRole(ctx, notif.sourceAppId, callerId);
    if (!access) throw new ConvexError('Notification not found');
    let action: NotifAction | null = null;
    if (notif.actions && notif.actions.length > 0) {
      action = resolveActionIdentifier(notif.actions as NotifAction[], args.actionIdentifier);
      // Also accept a raw user-provided id for programmatic callers that
      // don't know about the act_N mapping.
      if (!action) {
        const exact = (notif.actions as NotifAction[]).find((a) => a.id === args.actionIdentifier);
        if (exact) action = exact;
      }
    } else if (notif.action && args.actionIdentifier === 'open_action_url') {
      // Back-compat: the legacy single-action category.
      action = {
        kind: 'open_url',
        id: 'legacy_action',
        label: notif.action.label,
        url: notif.action.url
      };
    }

    return {
      action,
      ownerId: notif.ownerId,
      callerId,
      role: access.role
    };
  }
});

/** An in-flight claim is stale after the callback's own timeout plus slack. */
const CLAIM_STALE_MS = CALLBACK_TIMEOUT_MS + 5_000;

/** True if the event settled successfully — the state that spends an action. */
function succeeded(e: Doc<'actionEvents'>): boolean {
  if (e.actionKind === 'open_url') return true;
  return (
    e.callbackAt !== undefined &&
    e.callbackError === undefined &&
    e.callbackStatus !== undefined &&
    e.callbackStatus < 400
  );
}

/**
 * Claim the right to run an action, atomically.
 *
 * `invoke` is an action, so a check-then-insert across two calls would let two
 * near-simultaneous taps (two devices, or a double-tap) both pass the check and
 * both POST. Doing it in one mutation makes the claim transactional: exactly one
 * caller gets `claimed`, everyone else is told what already happened.
 *
 * `open_url` is exempt — opening a link twice is harmless, and refusing it would
 * make a tapped link permanently dead.
 */
export const claimEventInternal = internalMutation({
  args: {
    notificationId: v.id('notifications'),
    ownerId: v.string(),
    actionId: v.string(),
    actionKind: v.union(v.literal('open_url'), v.literal('callback'), v.literal('reply')),
    deviceId: v.optional(v.id('devices')),
    reply: v.optional(v.string())
  },
  returns: v.union(
    v.object({ status: v.literal('claimed'), eventId: v.id('actionEvents') }),
    v.object({ status: v.literal('done'), at: v.number(), detail: v.optional(v.string()) }),
    v.object({ status: v.literal('pending') })
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.actionKind !== 'open_url') {
      const prior = await ctx.db
        .query('actionEvents')
        .withIndex('by_notification_action', (q) =>
          q.eq('notificationId', args.notificationId).eq('actionId', args.actionId)
        )
        .collect();
      const done = prior.find(succeeded);
      if (done) {
        return {
          status: 'done' as const,
          at: done.callbackAt ?? done.createdAt,
          detail: resultDetail(done)
        };
      }
      // Another tap is mid-flight. Not spent yet, so don't record an outcome —
      // just decline to fire a second callback.
      const inFlight = prior.find(
        (e) => e.callbackAt === undefined && now - e.createdAt < CLAIM_STALE_MS
      );
      if (inFlight) return { status: 'pending' as const };
    }
    const eventId = await ctx.db.insert('actionEvents', {
      notificationId: args.notificationId,
      ownerId: args.ownerId,
      actionId: args.actionId,
      actionKind: args.actionKind,
      deviceId: args.deviceId,
      reply: args.reply,
      createdAt: now
    });
    // `open_url` has no callback to await, so it settles right here.
    if (args.actionKind === 'open_url') {
      const event = await ctx.db.get(eventId);
      if (event) await mirrorResult(ctx, event, true, now, resultDetail(event));
    }
    return { status: 'claimed' as const, eventId };
  }
});

/** The short human line the feed shows under a button. */
function resultDetail(e: Doc<'actionEvents'>): string | undefined {
  if (e.actionKind === 'open_url') return 'Opened';
  if (e.callbackError !== undefined) return e.callbackError.slice(0, 80);
  if (e.callbackStatus !== undefined && e.callbackStatus >= 400) return `HTTP ${e.callbackStatus}`;
  return e.actionKind === 'reply' ? 'Reply sent' : 'Sent';
}

/**
 * Settle a claimed event and mirror the outcome onto the notification, in one
 * transaction, so the feed's own subscription delivers the result — no local
 * component state to lose on a scroll or a relaunch.
 */
export const settleEventInternal = internalMutation({
  args: {
    id: v.id('actionEvents'),
    callbackStatus: v.optional(v.number()),
    callbackError: v.optional(v.string())
  },
  returns: v.object({ ok: v.boolean(), at: v.number(), detail: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const at = Date.now();
    await ctx.db.patch(args.id, {
      callbackStatus: args.callbackStatus,
      callbackError: args.callbackError,
      callbackAt: at
    });
    const event = await ctx.db.get(args.id);
    if (!event) throw new ConvexError('Action event vanished mid-flight');
    const ok = succeeded(event);
    const detail = resultDetail(event);
    await mirrorResult(ctx, event, ok, at, detail);
    return { ok, at, detail };
  }
});

/**
 * Upsert `notifications.actionResults` for this action. A later attempt
 * overwrites an earlier failure, so a retry that succeeds leaves the button
 * looking succeeded rather than keeping the stale error.
 */
async function mirrorResult(
  ctx: MutationCtx,
  event: Doc<'actionEvents'>,
  ok: boolean,
  at: number,
  detail: string | undefined
) {
  const notif = await ctx.db.get(event.notificationId);
  if (!notif) return;
  const entry = {
    actionId: event.actionId,
    kind: event.actionKind,
    by: event.ownerId,
    at,
    ok,
    ...(detail !== undefined ? { detail } : {})
  };
  const rest = (notif.actionResults ?? []).filter((r) => r.actionId !== event.actionId);
  await ctx.db.patch(event.notificationId, { actionResults: [...rest, entry] });
}


/**
 * Public: action history for a notification the caller owns.
 */
export const listForNotification = query({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const notif = await ctx.db.get(args.notificationId);
    if (!notif) throw new ConvexError('Notification not found');
    const access = await getSourceAppRole(ctx, notif.sourceAppId, userId);
    if (!access) throw new ConvexError('Notification not found');
    const rows: Doc<'actionEvents'>[] = await ctx.db
      .query('actionEvents')
      .withIndex('by_notification', (q) => q.eq('notificationId', args.notificationId))
      .collect();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows;
  }
});

export type { NotifAction };
