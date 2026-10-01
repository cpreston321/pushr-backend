import { v } from 'convex/values';
import { mutation, internalMutation, type MutationCtx } from './_generated/server';
import { components, internal } from './_generated/api';
import { requireAuthIdentity } from './lib/auth';
import { purgeAppSecrets } from './sourceApps';

const BATCH_SIZE = 100;

/**
 * Pushr-side account deletion. Marks every source app the user owns as
 * revoked, schedules the per-app cascade (`sweepDeletedAppData`) for each,
 * and then schedules `sweepUserData` to chase down every remaining
 * `ownerId`-keyed row that the per-app sweep wouldn't reach (devices,
 * memberships in other users' apps, tier rows, IAP events, etc.).
 * Also deletes the Better Auth user, sessions and linked accounts.
 */
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, email } = await requireAuthIdentity(ctx);
    await wipeAccountData(ctx, userId, email);
    // Same transaction as the wipe, so a failure can't leave a live login
    // with no data behind it.
    await deleteAuthUser(ctx, userId);
  }
});

async function wipeAccountData(ctx: MutationCtx, userId: string, email: string | null) {
  const now = Date.now();
  const ownedApps = await ctx.db
    .query('sourceApps')
    .withIndex('by_owner', (q) => q.eq('ownerId', userId))
    .collect();
  for (const app of ownedApps) {
    await purgeAppSecrets(ctx, app);
    if (app.revokedAt === undefined) {
      await ctx.db.patch(app._id, { revokedAt: now, enabled: false });
    }
    await ctx.scheduler.runAfter(0, internal.sourceApps.sweepDeletedAppData, {
      appId: app._id
    });
  }
  await ctx.scheduler.runAfter(0, internal.account.sweepUserData, { userId, email });
}

async function deleteAuthUser(ctx: MutationCtx, userId: string) {
  for (const model of ['session', 'account'] as const) {
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model, where: [{ field: 'userId', value: userId }] },
      paginationOpts: { cursor: null, numItems: 1000 }
    });
  }
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: 'user', where: [{ field: '_id', value: userId }] }
  });
}

/**
 * Internal (CLI): delete an account by email, sign-in included. Used to remove
 * the App Review demo account (scripts/create-demo-account.ts --delete), which
 * works even when its password has been lost.
 */
export const deleteByEmailInternal = internalMutation({
  args: { email: v.string() },
  returns: v.object({ found: v.boolean(), userId: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }]
    });
    if (!user) return { found: false, userId: null };
    const userId = String(user._id);

    await wipeAccountData(ctx, userId, email);
    await deleteAuthUser(ctx, userId);
    return { found: true, userId };
  }
});

/**
 * Batched cascade for `deleteAccount`. Each pass deletes up to BATCH_SIZE
 * rows from every relevant table and self-reschedules until everything is
 * empty. Owned source apps are handled separately via
 * `sourceApps.sweepDeletedAppData` — this sweep only touches rows keyed
 * directly by `userId` / `email`.
 */
export const sweepUserData = internalMutation({
  args: { userId: v.string(), email: v.union(v.string(), v.null()) },
  handler: async (ctx, { userId, email }) => {
    let workDone = 0;

    const devices = await ctx.db
      .query('devices')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .take(BATCH_SIZE);
    for (const d of devices) await ctx.db.delete(d._id);
    workDone += devices.length;

    // Notifications still indexed to this user — typically none reach here
    // because their parent sourceApp's sweep took them, but covers the
    // shared-app case and any historical drift.
    const notifications = await ctx.db
      .query('notifications')
      .withIndex('by_owner_created', (q) => q.eq('ownerId', userId))
      .take(BATCH_SIZE);
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
    }
    workDone += notifications.length;

    // Stray deliveries / actionEvents whose parent was deleted out from
    // under them in a previous failed run.
    const strayDeliveries = await ctx.db
      .query('deliveries')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .take(BATCH_SIZE);
    for (const d of strayDeliveries) await ctx.db.delete(d._id);
    workDone += strayDeliveries.length;

    const strayEvents = await ctx.db
      .query('actionEvents')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .take(BATCH_SIZE);
    for (const e of strayEvents) await ctx.db.delete(e._id);
    workDone += strayEvents.length;

    const activities = await ctx.db
      .query('liveActivities')
      .withIndex('by_owner_started', (q) => q.eq('ownerId', userId))
      .take(BATCH_SIZE);
    for (const a of activities) await ctx.db.delete(a._id);
    workDone += activities.length;

    const memberships = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(BATCH_SIZE);
    for (const m of memberships) await ctx.db.delete(m._id);
    workDone += memberships.length;

    if (email) {
      const invites = await ctx.db
        .query('sourceAppInvites')
        .withIndex('by_email', (q) => q.eq('email', email))
        .take(BATCH_SIZE);
      for (const i of invites) await ctx.db.delete(i._id);
      workDone += invites.length;
    }

    const prefs = await ctx.db
      .query('userPrefs')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .take(BATCH_SIZE);
    for (const p of prefs) await ctx.db.delete(p._id);
    workDone += prefs.length;


    if (workDone > 0) {
      await ctx.scheduler.runAfter(0, internal.account.sweepUserData, { userId, email });
    }
  }
});
