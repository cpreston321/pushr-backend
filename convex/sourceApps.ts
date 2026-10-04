import { v, ConvexError } from 'convex/values';
import { query, mutation, internalMutation, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { requireAuth } from './lib/auth';
import {
  appLocked,
  deleteInviteLinks,
  getSourceAppRole,
  listAccessibleSourceApps,
  requireSourceAppRole
} from './lib/sharing';
import { generateToken, hashToken, tokenDisplayPrefix } from './lib/tokens';
import type { Doc } from './_generated/dataModel';
import { deleteIncidents } from './lib/monitorCleanup';
import { requireLogoBlob } from './lib/logoBlob';

/**
 * Decorate a source-app document for the mobile UI: resolve the logo URL,
 * stamp on the caller's role, and (for owners only) attach the per-provider
 * webhook signing configs. Non-owners get an empty `webhookConfigs` array
 * so the UI can render without conditional shape checks.
 */
async function decorateApp(
  ctx: Parameters<typeof getSourceAppRole>[0],
  app: Doc<'sourceApps'>,
  role: 'owner' | 'editor' | 'viewer',
  userId: string
) {
  // Why pushes from this app aren't reaching the caller: the owner has more
  // apps than their plan sends from, or more members than it has seats.
  let paused: 'app' | 'seat' | null = null;
  const logoUrl = app.logoStorageId ? await ctx.storage.getUrl(app.logoStorageId) : null;
  const locked = await appLocked(ctx, app._id);
  const webhookConfigs =
    role === 'owner'
      ? (
          await ctx.db
            .query('webhookConfigs')
            .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
            .collect()
        ).map((c) => ({ provider: c.provider, secret: c.secret }))
      : [];
  return {
    ...app,
    logoUrl,
    logoColor: app.logoColor ?? null,
    role,
    webhookConfigs,
    paused,
    /** Can't be deleted. */
    locked
  };
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const accessible = await listAccessibleSourceApps(ctx, userId);
    const sorted = accessible.toSorted((a, b) => b.app.createdAt - a.app.createdAt);
    return await Promise.all(sorted.map(({ app, role }) => decorateApp(ctx, app, role, userId)));
  }
});

/**
 * Single app for the detail screen. Returns null if the caller has no
 * access (so the UI can render a friendly "not found"). Does not throw.
 */
export const getById = query({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const access = await getSourceAppRole(ctx, args.id, userId);
    if (!access) return null;
    return await decorateApp(ctx, access.app, access.role, userId);
  }
});

/**
 * Lightweight stats for the mini dashboard in source app detail.
 * Uses bounded index queries only. Good enough for recent activity views.
 */
export const getStats = query({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, { id }) => {
    const userId = await requireAuth(ctx);
    const access = await getSourceAppRole(ctx, id, userId);
    if (!access) return null;

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    // Recent notifications (bounded)
    const recent = await ctx.db
      .query('notifications')
      .withIndex('by_sourceApp_created', (q) => q.eq('sourceAppId', id))
      .order('desc')
      .take(100);

    const count7d = recent.filter((n) => n.createdAt >= sevenDaysAgo).length;
    const count30d = recent.filter((n) => n.createdAt >= thirtyDaysAgo).length;
    const lastAt = recent.length > 0 ? recent[0].createdAt : undefined;

    // Rough ack rate from recent items that had ack requested
    const ackRequested = recent.filter((n) => n.ack);
    const acked = ackRequested.filter((n) => n.acknowledgedAt);
    const ackRate = ackRequested.length > 0 ? acked.length / ackRequested.length : undefined;

    // Delivery success rate from aggregates already stored on notifications
    const withAttempts = recent.filter((n) => n.attemptedDeviceCount > 0);
    const totalAttempted = withAttempts.reduce((sum, n) => sum + n.attemptedDeviceCount, 0);
    const totalSuccess = withAttempts.reduce((sum, n) => sum + n.successDeviceCount, 0);
    const deliverySuccessRate = totalAttempted > 0 ? Math.round((totalSuccess / totalAttempted) * 100) : undefined;

    // Infer primary provider from recent webhook activity (great for branding/recipes)
    const providers = recent
      .map((n) => n.webhookProvider)
      .filter(Boolean) as string[];
    const primaryProvider = providers.length > 0
      ? providers.reduce((a, b, _, arr) =>
          arr.filter(v => v === a).length >= arr.filter(v => v === b).length ? a : b
        )
      : undefined;

    return {
      notificationCount7d: count7d,
      notificationCount30d: count30d,
      lastNotificationAt: lastAt,
      ackRate: ackRate !== undefined ? Math.round(ackRate * 100) : undefined,
      deliverySuccessRate,
      primaryProvider,
    };
  }
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    logoStorageId: v.optional(v.id('_storage'))
  },
  returns: v.object({
    id: v.id('sourceApps'),
    token: v.string()
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    if (args.name.trim().length === 0) {
      throw new ConvexError('Name is required');
    }
    if (args.logoStorageId) await requireLogoBlob(ctx, args.logoStorageId);


    const token = generateToken();
    const tokenHash = await hashToken(token);
    const tokenPrefix = tokenDisplayPrefix(token);
    const id = await ctx.db.insert('sourceApps', {
      ownerId,
      name: args.name.trim(),
      description: args.description?.trim() || undefined,
      tokenHash,
      tokenPrefix,
      enabled: true,
      createdAt: Date.now(),
      logoStorageId: args.logoStorageId
    });
    if (args.logoStorageId) {
      await ctx.scheduler.runAfter(0, internal.logoColor.extract, {
        id,
        storageId: args.logoStorageId
      });
    }
    return { id, token };
  }
});

/**
 * Internal (CLI): find-or-create an owner's source app by name and return a
 * fresh token. Hashes are one-way, so an existing app's token is rotated.
 */
export const provisionForOwner = internalMutation({
  args: { ownerId: v.string(), name: v.string(), description: v.optional(v.string()) },
  returns: v.object({ id: v.id('sourceApps'), token: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const tokenPrefix = tokenDisplayPrefix(token);
    const existing = (
      await ctx.db
        .query('sourceApps')
        .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
        .collect()
    ).find((a) => a.name === args.name && !a.revokedAt);
    if (existing) {
      await ctx.db.patch(existing._id, { tokenHash, tokenPrefix, enabled: true });
      return { id: existing._id, token, created: false };
    }
    const id = await ctx.db.insert('sourceApps', {
      ownerId: args.ownerId,
      name: args.name,
      description: args.description,
      tokenHash,
      tokenPrefix,
      enabled: true,
      createdAt: Date.now()
    });
    return { id, token, created: true };
  }
});

export const setEnabled = mutation({
  args: { id: v.id('sourceApps'), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    await requireSourceAppRole(ctx, args.id, userId, 'editor');
    await ctx.db.patch(args.id, { enabled: args.enabled });
  }
});

/**
 * Mute a source app until `until` (ms since epoch). Pass `null` to clear.
 * Muted apps still accept pushes into the feed but Expo delivery is skipped.
 */
export const setMute = mutation({
  args: {
    id: v.id('sourceApps'),
    until: v.union(v.null(), v.number())
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    await requireSourceAppRole(ctx, args.id, userId, 'editor');
    await ctx.db.patch(args.id, {
      mutedUntil: args.until ?? undefined
    });
  }
});

export const setQuietHours = mutation({
  args: {
    id: v.id('sourceApps'),
    // minutes since midnight (0-1439), or null to clear
    start: v.union(v.null(), v.number()),
    end: v.union(v.null(), v.number()),
    timeZone: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.id, userId, 'editor');
    void app; // referenced inside the stripped block; keep handler input alive
    const valid = (n: number | null) => n === null || (Number.isInteger(n) && n >= 0 && n < 1440);
    if (!valid(args.start) || !valid(args.end)) {
      throw new ConvexError('Quiet hours must be integers between 0 and 1439');
    }
    if (args.timeZone !== undefined && !isValidTimeZone(args.timeZone)) {
      throw new ConvexError('Unknown time zone');
    }
    await ctx.db.patch(args.id, {
      quietStart: args.start ?? undefined,
      quietEnd: args.end ?? undefined,
      quietTimeZone: args.start === null ? undefined : args.timeZone
    });
  }
});

function isValidTimeZone(tz: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone !== undefined;
  } catch {
    return false;
  }
}

export const rename = mutation({
  args: {
    id: v.id('sourceApps'),
    name: v.string(),
    description: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    await requireSourceAppRole(ctx, args.id, userId, 'editor');
    await ctx.db.patch(args.id, {
      name: args.name.trim(),
      description: args.description?.trim() || undefined
    });
  }
});

/**
 * Set or clear the inbound HMAC signing secret for ONE provider on a source
 * app. Pass `secret: null` to clear that provider's row. Other providers
 * already configured on the same app are unaffected — a single source app
 * can have entries for github, sentry, etc., each with its own key.
 *
 * Owner-only.
 */
export const setProviderWebhookSecret = mutation({
  args: {
    id: v.id('sourceApps'),
    provider: v.string(),
    secret: v.union(v.null(), v.string())
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    await requireSourceAppRole(ctx, args.id, userId, 'owner');
    const provider = args.provider.trim();
    if (!provider) throw new ConvexError('Provider is required');
    const trimmed = args.secret?.trim();
    const existing = await ctx.db
      .query('webhookConfigs')
      .withIndex('by_app_provider', (q) => q.eq('sourceAppId', args.id).eq('provider', provider))
      .unique();
    if (!trimmed || trimmed.length === 0) {
      if (existing) await ctx.db.delete(existing._id);
      return;
    }
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { secret: trimmed, updatedAt: now });
    } else {
      await ctx.db.insert('webhookConfigs', {
        sourceAppId: args.id,
        provider,
        secret: trimmed,
        createdAt: now,
        updatedAt: now
      });
    }
  }
});

/**
 * Rotate the bearer token for a source app. Owner only — sensitive: any
 * caller still using the old token immediately stops working. Returns the
 * fresh token, which is the only chance to capture it (we only persist a
 * hash). The notification feed history and configuration are preserved.
 */
export const rotateToken = mutation({
  args: { id: v.id('sourceApps') },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.id, userId, 'owner');
    if (app.revokedAt) {
      throw new ConvexError('Cannot rotate a revoked app — create a new one');
    }
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const tokenPrefix = tokenDisplayPrefix(token);
    await ctx.db.patch(args.id, { tokenHash, tokenPrefix });
    return { token };
  }
});

/**
 * Hard-delete a source app and every record tied to it: members, invites,
 * notifications + their deliveries + actionEvents, live activities, the
 * uploaded logo, and finally the sourceApps row itself.
 *
 * Two-phase to fit unbounded data within Convex's per-mutation transaction
 * limit:
 *   1. This public mutation deletes the bounded data (members/invites/logo)
 *      and marks `revokedAt` so the app immediately disappears from
 *      `listAccessibleSourceApps` (and therefore the feed/UI).
 *   2. `internal.sourceApps.sweepDeletedAppData` runs in the background,
 *      deleting batches of notifications + dependent rows, self-rescheduling
 *      until everything is gone — at which point it deletes the sourceApps
 *      row itself.
 *
 * Owner-only. Idempotent on repeat calls only until phase 1 commits — once
 * `revokedAt` is set, `requireSourceAppRole` returns "not found" so a retry
 * surfaces as a benign error to the caller.
 */
/**
 * Delete everything tied to an app that isn't swept with its notifications:
 * members, invites, webhook signing secrets, forwarder URLs and the logo.
 * Shared by app deletion and account deletion — the latter must not leave
 * Slack/Discord webhook URLs or signing secrets behind.
 */
export async function purgeAppSecrets(ctx: MutationCtx, app: Doc<'sourceApps'>) {
  // Bounded synchronous deletes — sharedUsersLimit caps both members and
  // invites, so these are small enough to handle in one transaction.
  const members = await ctx.db
    .query('sourceAppMembers')
    .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
    .collect();
  for (const m of members) await ctx.db.delete(m._id);

  const invites = await ctx.db
    .query('sourceAppInvites')
    .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
    .collect();
  for (const i of invites) {
    await deleteInviteLinks(ctx, i._id);
    await ctx.db.delete(i._id);
  }

  // Webhook signing configs — at most a handful per app (one per supported
  // provider), bounded enough to handle synchronously.
  const configs = await ctx.db
    .query('webhookConfigs')
    .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
    .collect();
  for (const c of configs) await ctx.db.delete(c._id);

  // Outbound forwarders — also bounded (users wire up a handful of Slack /
  // Discord webhooks per app). If you ever grow this beyond a few hundred
  // per app, move it into `sweepDeletedAppData` like notifications.
  const forwarders = await ctx.db
    .query('sourceAppForwarders')
    .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', app._id))
    .collect();
  for (const f of forwarders) await ctx.db.delete(f._id);

  // Capped per app (heartbeats.PER_APP_LIMIT).
  const heartbeats = await ctx.db
    .query('heartbeats')
    .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id))
    .collect();
  for (const h of heartbeats) {
    await deleteIncidents(ctx, 'heartbeat', h._id);
    await ctx.db.delete(h._id);
  }
  // Capped per owner by plan.
  const checks = await ctx.db
    .query('uptimeChecks')
    .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id))
    .collect();
  for (const c of checks) {
    await deleteIncidents(ctx, 'uptime', c._id);
    await ctx.db.delete(c._id);
  }
  const pages = await ctx.db
    .query('statusPages')
    .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', app._id))
    .collect();
  for (const p of pages) {
    if (p.logoStorageId) await ctx.storage.delete(p.logoStorageId).catch(() => {});
    await ctx.db.delete(p._id);
  }

  if (app.logoStorageId) {
    try {
      await ctx.storage.delete(app.logoStorageId);
    } catch {
      // Already gone — ignore.
    }
  }
}

export const deleteApp = mutation({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.id, userId, 'owner');

    await purgeAppSecrets(ctx, app);

    // Hide the app from every UI surface immediately. The row itself stays
    // around until the sweep finishes deleting all dependent data, then the
    // sweep deletes this row too.
    await ctx.db.patch(app._id, {
      revokedAt: Date.now(),
      enabled: false
    });

    await ctx.scheduler.runAfter(0, internal.sourceApps.sweepDeletedAppData, { appId: app._id });
  }
});

const SWEEP_BATCH = 50;

/**
 * Internal cascade sweep for `deleteApp`. One batch per fire; self-reschedules
 * while there's work left, then deletes the sourceApps row itself.
 *
 * Safe to run on a non-existent app — completes as a no-op.
 */
export const sweepDeletedAppData = internalMutation({
  args: { appId: v.id('sourceApps') },
  handler: async (ctx, { appId }) => {
    let workDone = 0;

    const notifications = await ctx.db
      .query('notifications')
      .withIndex('by_sourceApp_created', (q) => q.eq('sourceAppId', appId))
      .take(SWEEP_BATCH);
    for (const n of notifications) {
      const deliveries = await ctx.db
        .query('deliveries')
        .withIndex('by_notification', (q) => q.eq('notificationId', n._id))
        .collect();
      for (const d of deliveries) await ctx.db.delete(d._id);
      const events = await ctx.db
        .query('actionEvents')
        .withIndex('by_notification', (q) => q.eq('notificationId', n._id))
        .collect();
      for (const e of events) await ctx.db.delete(e._id);
      await ctx.db.delete(n._id);
      workDone++;
    }

    const activities = await ctx.db
      .query('liveActivities')
      .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', appId))
      .take(SWEEP_BATCH);
    for (const a of activities) {
      await ctx.db.delete(a._id);
      workDone++;
    }

    const rate = await ctx.db
      .query('notifyRate')
      .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', appId))
      .take(SWEEP_BATCH);
    for (const r of rate) await ctx.db.delete(r._id);

    if (workDone > 0) {
      await ctx.scheduler.runAfter(0, internal.sourceApps.sweepDeletedAppData, { appId });
      return;
    }

    // No dependent data left — finally delete the sourceApps row itself.
    const app = await ctx.db.get(appId);
    if (app) await ctx.db.delete(appId);
  }
});

/**
 * Returns a single-use upload URL the mobile client POSTs the logo bytes to.
 * After upload completes, call `setLogo` with the returned storageId.
 */
export const generateLogoUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    return await ctx.storage.generateUploadUrl();
  }
});

export const setLogo = mutation({
  args: {
    id: v.id('sourceApps'),
    storageId: v.id('_storage')
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.id, userId, 'editor');
    await requireLogoBlob(ctx, args.storageId, { sourceApp: app._id });
    // Replace any previous logo to avoid orphaned blobs.
    if (app.logoStorageId && app.logoStorageId !== args.storageId) {
      try {
        await ctx.storage.delete(app.logoStorageId);
      } catch {
        // Already gone — ignore.
      }
    }
    // Clear the previous color up front — a stale one is worse than none while
    // the new logo's color is still being derived.
    await ctx.db.patch(args.id, {
      logoStorageId: args.storageId,
      logoColor: undefined,
      logoShape: undefined
    });
    // Decoding needs the Node runtime, so it can't happen inside this
    // transaction. Scheduling it keeps the upload fast and lets a failure to
    // read the image be non-fatal.
    await ctx.scheduler.runAfter(0, internal.logoColor.extract, {
      id: args.id,
      storageId: args.storageId
    });
  }
});

/**
 * Write back a color derived by `logoColor.extract`.
 *
 * `storageId` guards against a race: if the user replaced the logo again while
 * the first extraction was in flight, the late result would otherwise stamp the
 * old logo's color onto the new one.
 */
export const setLogoColorInternal = internalMutation({
  args: {
    id: v.id('sourceApps'),
    storageId: v.id('_storage'),
    color: v.union(v.string(), v.null()),
    shape: v.optional(v.union(v.literal('circle'), v.literal('free'), v.literal('square'), v.null()))
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.id);
    if (!app) return;
    if (app.logoStorageId !== args.storageId) return;
    await ctx.db.patch(args.id, { logoColor: args.color ?? undefined, logoShape: args.shape ?? undefined });
  }
});

/**
 * Derive colors for logos uploaded before `logoColor` existed.
 *
 * Batched and self-rescheduling so it stays inside a single transaction's
 * read/write limits however many apps exist. Run once from the dashboard:
 * `npx convex run sourceApps:backfillLogoColors '{}'`
 */
export const backfillLogoColors = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const BATCH = 50;
    const page = await ctx.db.query('sourceApps').paginate({
      numItems: BATCH,
      cursor: args.cursor ?? null
    });

    let scheduled = 0;
    for (const app of page.page) {
      if (!app.logoStorageId || (app.logoColor !== undefined && app.logoShape !== undefined)) continue;
      await ctx.scheduler.runAfter(0, internal.logoColor.extract, {
        id: app._id,
        storageId: app.logoStorageId
      });
      scheduled++;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.sourceApps.backfillLogoColors, {
        cursor: page.continueCursor
      });
    }
    return { scheduled, done: page.isDone };
  }
});

export const removeLogo = mutation({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.id, userId, 'editor');
    if (app.logoStorageId) {
      try {
        await ctx.storage.delete(app.logoStorageId);
      } catch {
        // Already gone — ignore.
      }
    }
    await ctx.db.patch(args.id, {
      logoStorageId: undefined,
      logoColor: undefined,
      logoShape: undefined
    });
  }
});
