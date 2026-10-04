import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { deleteInviteLinks } from './lib/sharing';
import { components, internal } from './_generated/api';
import { isLogoBlob } from './lib/logoBlob';

/**
 * Scheduled cleanup of stale rows. Wired up in convex/crons.ts.
 *
 * Each sweep reads the oldest batch of rows, deletes those past their
 * retention cutoff, and self-reschedules if the whole batch was stale
 * (implying more stale rows may remain). If any row in the batch is
 * still within retention, we're done — the rest of the table is newer.
 *
 * Batches are small enough to fit comfortably inside a single mutation
 * transaction; the scheduler pattern handles unbounded backlogs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Notification retention is tier-aware (Free: 7 days, Pro: 90 days — see
// `TIER_LIMITS.historyDays`). MIN bounds the early-break: a row younger
// than the shortest tier window is fresh for every tier. MAX bounds the
// "stale regardless of tier" fast path so we can skip the userTiers
// lookup for rows that are obviously past retention.
const MIN_NOTIFICATION_RETAIN_MS = 7 * DAY_MS;
const MAX_NOTIFICATION_RETAIN_MS = 90 * DAY_MS;

// Live Activities — ActivityKit activities don't run for weeks; drop shadow
// rows after 14 days regardless of end state.
const LIVE_ACTIVITY_RETAIN_MS = 14 * DAY_MS;

// Devices marked invalid (DeviceNotRegistered) get purged after 30 days.
// Active devices are never touched here.
const INVALID_DEVICE_RETAIN_MS = 30 * DAY_MS;

// Resolved invites (accepted / declined / canceled) and invites whose
// `expiresAt` has lapsed get purged 30 days after the terminal event. Pending,
// unexpired invites are kept indefinitely.
const INVITE_RETAIN_MS = 30 * DAY_MS;

/**
 * How long a `/notify` idempotency key stays honoured. Past this a retry with
 * the same key creates a new notification — the standard trade for not keeping
 * every key ever issued.
 */
const IDEMPOTENCY_RETAIN_MS = DAY_MS;



const BATCH_SIZE = 100;

const EMAIL_SEND_RETAIN_MS = DAY_MS;

export const sweepNotifications = internalMutation({
  // `after` resumes past rows already examined. Without it, a head of retained
  // Pro rows (stale for Free, fresh for Pro) is re-read every run and the Free
  // rows behind it are never reached.
  args: { after: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const minFreshFloor = now - MIN_NOTIFICATION_RETAIN_MS;
    const alwaysStaleCutoff = now - MAX_NOTIFICATION_RETAIN_MS;
    const batch = await ctx.db
      .query('notifications')
      .withIndex('by_creation_time', (q) =>
        args.after === undefined ? q : q.gt('_creationTime', args.after)
      )
      .take(BATCH_SIZE);
    let deleted = 0;
    let allStale = true;
    for (const n of batch) {
      // Rows are returned oldest-first; once we hit one fresh for every tier,
      // nothing further could be stale.
      if (n.createdAt >= minFreshFloor) {
        allStale = false;
        break;
      }
      const anchor = Math.max(n.createdAt, n.deliverAt ?? 0);
      let stale = anchor < alwaysStaleCutoff;
      if (!stale) continue;
      const deliveries = await ctx.db
        .query('deliveries')
        .withIndex('by_notification', (q) => q.eq('notificationId', n._id))
        .collect();
      for (const d of deliveries) await ctx.db.delete(d._id);
      const actionEvents = await ctx.db
        .query('actionEvents')
        .withIndex('by_notification', (q) => q.eq('notificationId', n._id))
        .collect();
      for (const e of actionEvents) await ctx.db.delete(e._id);
      await ctx.db.delete(n._id);
      deleted++;
    }
    if (allStale && batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepNotifications, {
        after: batch[batch.length - 1]._creationTime
      });
    }
    return deleted;
  }
});

export const sweepLiveActivities = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - LIVE_ACTIVITY_RETAIN_MS;
    const batch = await ctx.db
      .query('liveActivities')
      .withIndex('by_started', (q) => q.lt('startedAt', cutoff))
      .take(BATCH_SIZE);
    let deleted = 0;
    for (const row of batch) {
      await ctx.db.delete(row._id);
      deleted++;
    }
    if (deleted === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepLiveActivities, {});
    }
    return deleted;
  }
});

export const sweepInvalidDevices = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - INVALID_DEVICE_RETAIN_MS;
    // No index on invalidatedAt — walk the whole table via `_creationTime`
    // cursor, deleting invalidated devices past retention as we go. Active
    // devices are skipped in-place. Cursor prevents an infinite reschedule
    // on a prefix of all-active rows.
    const batch = await ctx.db
      .query('devices')
      .withIndex('by_creation_time', (q) =>
        args.cursor === undefined ? q : q.gt('_creationTime', args.cursor)
      )
      .take(BATCH_SIZE);
    for (const d of batch) {
      if (d.invalidatedAt !== undefined && d.invalidatedAt < cutoff) {
        await ctx.db.delete(d._id);
      }
    }
    if (batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepInvalidDevices, {
        cursor: batch[batch.length - 1]._creationTime
      });
    }
    return batch.length;
  }
});

/**
 * Sweep deliveries / actionEvents whose parent notification no longer exists.
 * Before notifications.ts was patched to cascade, direct deletes (deleteOne,
 * clearAll) left children behind — this catches the historical backlog and
 * any future drift from a missed cascade.
 *
 * Walks the table via `_creationTime` cursor so non-orphan-heavy regions
 * don't trap us in an infinite reschedule on the same prefix.
 */
export const sweepOrphanDeliveries = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query('deliveries')
      .withIndex('by_creation_time', (q) =>
        args.cursor === undefined ? q : q.gt('_creationTime', args.cursor)
      )
      .take(BATCH_SIZE);
    let deleted = 0;
    for (const d of batch) {
      const parent = await ctx.db.get(d.notificationId);
      if (parent === null) {
        await ctx.db.delete(d._id);
        deleted++;
      }
    }
    if (batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepOrphanDeliveries, {
        cursor: batch[batch.length - 1]._creationTime
      });
    }
    return deleted;
  }
});

export const sweepOrphanActionEvents = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query('actionEvents')
      .withIndex('by_creation_time', (q) =>
        args.cursor === undefined ? q : q.gt('_creationTime', args.cursor)
      )
      .take(BATCH_SIZE);
    let deleted = 0;
    for (const e of batch) {
      const parent = await ctx.db.get(e.notificationId);
      if (parent === null) {
        await ctx.db.delete(e._id);
        deleted++;
      }
    }
    if (batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepOrphanActionEvents, {
        cursor: batch[batch.length - 1]._creationTime
      });
    }
    return deleted;
  }
});

/**
 * `/notify` replay guards. 24h is the conventional window: long enough to
 * cover a retrying cron or webhook receiver, short enough that the table
 * doesn't grow with every push forever.
 */
export const sweepIdempotencyKeys = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - IDEMPOTENCY_RETAIN_MS;
    const batch = await ctx.db.query('idempotencyKeys').take(BATCH_SIZE);
    let deleted = 0;
    let allStale = true;
    for (const row of batch) {
      if (row.createdAt >= cutoff) {
        allStale = false;
        continue;
      }
      await ctx.db.delete(row._id);
      deleted++;
    }
    if (allStale && deleted > 0 && batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepIdempotencyKeys, {});
    }
    return deleted;
  }
});

export const sweepInvites = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - INVITE_RETAIN_MS;
    const batch = await ctx.db.query('sourceAppInvites').take(BATCH_SIZE);
    let deleted = 0;
    let allStale = true;
    for (const invite of batch) {
      // Any deletable invite must have been created at least INVITE_RETAIN_MS
      // ago (the terminal event can't precede creation). Once we hit a fresh
      // row, nothing later in the table can qualify either.
      if (invite._creationTime >= cutoff) {
        allStale = false;
        break;
      }
      const terminalAt =
        invite.acceptedAt ??
        invite.declinedAt ??
        invite.canceledAt ??
        (invite.expiresAt < now ? invite.expiresAt : undefined);
      if (terminalAt === undefined || terminalAt >= cutoff) continue;
      await deleteInviteLinks(ctx, invite._id);
      await ctx.db.delete(invite._id);
      deleted++;
    }
    if (allStale && deleted > 0 && batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepInvites, {});
    }
    return deleted;
  }
});


export const sweepEmailSends = internalMutation({
  args: {},
  handler: async (ctx) => {
    const batch = await ctx.db
      .query('emailSends')
      .withIndex('by_sent', (q) => q.lt('sentAt', Date.now() - EMAIL_SEND_RETAIN_MS))
      .take(BATCH_SIZE);
    for (const row of batch) await ctx.db.delete(row._id);
    if (batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepEmailSends, {});
    }
  }
});

/**
 * Uploads nothing points at. Storage URLs are public, so an upload that was
 * never attached (or was refused: that mutation's own delete would roll back)
 * is deleted rather than hosted forever. A day's grace covers an upload still
 * waiting for its attach; one that couldn't be a logo gets an hour.
 *
 * Logos on `sourceApps` and `statusPages` are the only things that hold a
 * storage id. A new field that does must be checked here.
 */
const ORPHAN_UPLOAD_GRACE_MS = DAY_MS;
const REFUSED_UPLOAD_GRACE_MS = 60 * 60 * 1000;

export const sweepStorage = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db.system
      .query('_storage')
      .paginate({ numItems: BATCH_SIZE, cursor: args.cursor ?? null });
    let deleted = 0;
    let reachedFresh = false;
    for (const blob of page.page) {
      const age = now - blob._creationTime;
      const grace = isLogoBlob(blob) ? ORPHAN_UPLOAD_GRACE_MS : REFUSED_UPLOAD_GRACE_MS;
      if (age < REFUSED_UPLOAD_GRACE_MS) {
        reachedFresh = true;
        break;
      }
      if (age < grace) continue;
      const app = await ctx.db
        .query('sourceApps')
        .withIndex('by_logo', (q) => q.eq('logoStorageId', blob._id))
        .first();
      if (app) continue;
      const statusPage = await ctx.db
        .query('statusPages')
        .withIndex('by_logo', (q) => q.eq('logoStorageId', blob._id))
        .first();
      if (statusPage) continue;
      await ctx.storage.delete(blob._id);
      deleted++;
    }
    if (!page.isDone && !reachedFresh) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepStorage, { cursor: page.continueCursor });
    }
    return deleted;
  }
});

/**
 * Expired Better Auth sessions (which hold an IP address and user agent) and
 * verification tokens. Better Auth only removes them when they're looked up,
 * so a session from a phone that never comes back would stay forever.
 */
export const sweepExpiredAuth = internalMutation({
  args: {
    model: v.union(v.literal('session'), v.literal('verification')),
    cursor: v.union(v.string(), v.null())
  },
  handler: async (ctx, args) => {
    const result = await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: args.model,
        where: [{ field: 'expiresAt', operator: 'lt', value: Date.now() }]
      },
      paginationOpts: { cursor: args.cursor, numItems: BATCH_SIZE }
    });
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.cleanup.sweepExpiredAuth, {
        model: args.model,
        cursor: result.continueCursor
      });
    }
  }
});

/**
 * Entry point kicked off by the cron. Fires each sweep; they self-reschedule
 * if there's more to do.
 */
export const runAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepNotifications, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepLiveActivities, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepInvalidDevices, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepInvites, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepIdempotencyKeys, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepEmailSends, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepStorage, {});
    await ctx.scheduler.runAfter(0, internal.pairing.sweep, {});
    await ctx.scheduler.runAfter(0, internal.signInThrottle.sweep, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepExpiredAuth, { model: 'session', cursor: null });
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepExpiredAuth, { model: 'verification', cursor: null });
  }
});

/**
 * Weekly orphan sweep. Both sweeps walk their entire table via
 * `_creationTime` cursor — one `db.get` per row — so they're meaningfully
 * more expensive than the daily sweeps as the tables grow. Now that
 * `notifications.deleteOne` / `clearAll` and `sourceApps.deleteApp` all
 * cascade correctly, the only source of new orphans would be a regression,
 * so weekly is plenty.
 */
export const runOrphanSweeps = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepOrphanDeliveries, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.sweepOrphanActionEvents, {});
  }
});

/** Manual trigger validators — usable from the Convex dashboard. */
export const runAllManual = internalMutation({
  args: { confirm: v.literal(true) },
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.cleanup.runAll, {});
    await ctx.scheduler.runAfter(0, internal.cleanup.runOrphanSweeps, {});
  }
});
