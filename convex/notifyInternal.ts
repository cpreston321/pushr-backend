import { v, ConvexError } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { hashToken, sha256Hex } from './lib/tokens';
import { touchLastUsed } from './lib/lastUsed';

const liveActivityValidator = v.object({
  action: v.union(v.literal('start'), v.literal('update'), v.literal('end')),
  activityId: v.string(),
  state: v.object({
    title: v.optional(v.string()),
    status: v.optional(v.string()),
    progress: v.optional(v.number()),
    icon: v.optional(v.string())
  }),
  attributes: v.optional(
    v.object({
      name: v.optional(v.string()),
      logoUrl: v.optional(v.string())
    })
  ),
  staleDate: v.optional(v.number()),
  relevanceScore: v.optional(v.number())
});

/**
 * Validator for one entry in notifications.actions. Mirrored from the
 * schema so /notify can accept it without parsing indirection.
 */
const actionValidator = v.union(
  v.object({
    kind: v.literal('open_url'),
    id: v.string(),
    label: v.string(),
    url: v.string(),
    destructive: v.optional(v.boolean())
  }),
  v.object({
    kind: v.literal('callback'),
    id: v.string(),
    label: v.string(),
    callbackUrl: v.string(),
    destructive: v.optional(v.boolean()),
    authRequired: v.optional(v.boolean())
  }),
  v.object({
    kind: v.literal('reply'),
    id: v.string(),
    label: v.string(),
    callbackUrl: v.string(),
    placeholder: v.optional(v.string())
  })
);

/**
 * Called by the /notify HTTP endpoint. Authenticates the bearer token by
 * hash, inserts a notifications row, and returns both the row id and
 * ownerId so the HTTP action can schedule delivery.
 */
export const ingest = internalMutation({
  args: {
    token: v.string(),
    title: v.string(),
    body: v.string(),
    priority: v.optional(v.number()),
    url: v.optional(v.string()),
    appUrl: v.optional(v.string()),
    data: v.optional(v.any()),
    image: v.optional(v.string()),
    action: v.optional(v.object({ label: v.string(), url: v.string() })),
    actions: v.optional(v.array(actionValidator)),
    ack: v.optional(
      v.object({
        timeoutSec: v.number(),
        maxAttempts: v.number()
      })
    ),
    liveActivity: v.optional(liveActivityValidator),
    webhookProvider: v.optional(v.string()),
    webhookEventType: v.optional(v.string()),
    /** Caller-supplied replay guard, from the `Idempotency-Key` header. */
    idempotencyKey: v.optional(v.string()),
    /** Only stored, so a replay can echo the original response exactly. */
    deliverAt: v.optional(v.number())
  },
  returns: v.object({
    notificationId: v.id('notifications'),
    ownerId: v.string(),
    ack: v.optional(
      v.object({
        timeoutSec: v.number(),
        maxAttempts: v.number()
      })
    ),
    /** True when this call matched an existing key — nothing was written. */
    replayed: v.optional(v.boolean()),
    /** The original request's `deliverAt`, on a replay. */
    scheduledFor: v.optional(v.number())
  }),
  handler: async (ctx, args) => {
    const tokenHash = await hashToken(args.token);
    const app = await ctx.db
      .query('sourceApps')
      .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
      .first();
    if (!app || app.revokedAt) {
      throw new ConvexError({ code: 'INVALID_TOKEN', message: 'Invalid or revoked token' });
    }
    if (!app.enabled) {
      throw new ConvexError({ code: 'APP_DISABLED', message: 'Source app is disabled' });
    }

    // Replay guard first: before quota (a retry shouldn't spend the caller's
    // monthly allowance) and before any write. Convex mutations are
    // transactional, so two simultaneous retries can't both pass this — the
    // loser conflicts and re-runs, then sees the winner's row.
    const requestHash = args.idempotencyKey
      ? await sha256Hex(
          JSON.stringify([
            args.title,
            args.body,
            args.priority ?? null,
            args.url ?? null,
            args.appUrl ?? null,
            args.data ?? null,
            args.image ?? null,
            args.action ?? null,
            args.actions ?? null,
            args.ack ?? null,
            args.liveActivity ?? null,
            args.deliverAt ?? null
          ])
        )
      : null;
    if (args.idempotencyKey && requestHash) {
      const prior = await ctx.db
        .query('idempotencyKeys')
        .withIndex('by_app_key', (q) =>
          q.eq('sourceAppId', app._id).eq('key', args.idempotencyKey!)
        )
        .unique();
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new ConvexError({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'This Idempotency-Key was already used with a different payload. Use a new key for a new message.'
          });
        }
        return {
          notificationId: prior.notificationId,
          ownerId: app.ownerId,
          ack: args.ack,
          replayed: true,
          scheduledFor: prior.scheduledFor
        };
      }
    }


    await touchLastUsed(ctx, app);

    const notificationId = await ctx.db.insert('notifications', {
      ownerId: app.ownerId,
      sourceAppId: app._id,
      title: args.title,
      body: args.body,
      priority: args.priority,
      url: args.url,
      appUrl: args.appUrl,
      data: args.data,
      image: args.image,
      action: args.action,
      actions: args.actions,
      liveActivity: args.liveActivity,
      createdAt: Date.now(),
      deliverAt: args.deliverAt,
      attemptedDeviceCount: 0,
      successDeviceCount: 0,
      ack: args.ack
        ? {
            timeoutSec: args.ack.timeoutSec,
            maxAttempts: args.ack.maxAttempts,
            attempts: 0
          }
        : undefined,
      webhookProvider: args.webhookProvider,
      webhookEventType: args.webhookEventType
    });

    // Shadow the live-activity lifecycle server-side for observability.
    if (args.liveActivity) {
      const la = args.liveActivity;
      const existing = await ctx.db
        .query('liveActivities')
        .withIndex('by_owner_activity', (q) =>
          q.eq('ownerId', app.ownerId).eq('activityId', la.activityId)
        )
        .unique();
      const now = Date.now();
      if (existing && la.action === 'start') {
        // A reused activityId is a new native activity with a new update token.
        // Keeping the previous run's token would send every update to an ended
        // activity until the device reports again — APNs accepts those and they
        // vanish, which reads as "it worked once, then froze".
        await ctx.db.patch(existing._id, {
          sourceAppId: app._id,
          startedAt: now,
          lastUpdateAt: now,
          lastState: la.state,
          lastAttributes: la.attributes,
          endedAt: undefined,
          nativeActivityId: undefined,
          pushUpdateToken: undefined,
          pushUpdateTokenAt: undefined,
          deviceId: undefined
        });
      } else if (existing) {
        await ctx.db.patch(existing._id, {
          lastUpdateAt: now,
          lastState: la.state,
          lastAttributes: la.attributes ?? existing.lastAttributes,
          endedAt: la.action === 'end' ? now : existing.endedAt
        });
      } else if (la.action === 'start') {
        await ctx.db.insert('liveActivities', {
          ownerId: app.ownerId,
          sourceAppId: app._id,
          activityId: la.activityId,
          startedAt: now,
          lastUpdateAt: now,
          lastState: la.state,
          lastAttributes: la.attributes
        });
      }
      // `update`/`end` for an unknown activityId: ignore — the device either
      // never saw the start or already ended it. Payload still flows through
      // to the push so the device can decide what to do.
    }

    if (args.idempotencyKey && requestHash) {
      await ctx.db.insert('idempotencyKeys', {
        sourceAppId: app._id,
        key: args.idempotencyKey,
        notificationId,
        scheduledFor: args.deliverAt,
        requestHash,
        createdAt: Date.now()
      });
    }

    return { notificationId, ownerId: app.ownerId, ack: args.ack };
  }
});

/**
 * Internal: resolve a bearer token + provider name to the sourceApp's
 * configured signing secret for that provider (if any). Used by the /hooks
 * dispatcher to verify signed webhooks BEFORE ingesting.
 *
 * Returns null when the token is invalid OR when no secret is configured
 * for that provider — both cases skip signature verification (the caller's
 * subsequent ingest call will surface INVALID_TOKEN consistently).
 */
export const webhookSecretForToken = internalQuery({
  args: { token: v.string(), provider: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const tokenHash = await hashToken(args.token);
    const app = await ctx.db
      .query('sourceApps')
      .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
      .first();
    if (!app || app.revokedAt) return null;
    const config = await ctx.db
      .query('webhookConfigs')
      .withIndex('by_app_provider', (q) =>
        q.eq('sourceAppId', app._id).eq('provider', args.provider)
      )
      .unique();
    return config?.secret ?? null;
  }
});
