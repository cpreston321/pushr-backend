import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireAuth } from './lib/auth';

/**
 * Self-hosted deployments have no plans: every account gets everything. The
 * app asks the server whether it's self-hosted rather than deciding from the
 * URL, so this answer is what unlocks Pro features in the app.
 */
export const getMyPlan = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireAuth(ctx);
    const apps = await ctx.db
      .query('sourceApps')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .collect();
    return {
      tier: 'pro' as const,
      selfHosted: true as boolean,
      pushesPerMonth: 0,
      pushesThisMonth: 0,
      sourceAppLimit: null,
      sourceAppCount: apps.filter((a) => !a.revokedAt).length,
      sharedUsersPerAppLimit: null,
      historyDays: 90,
      uptimeCheckLimit: 50,
      uptimeMinIntervalSec: 60,
      heartbeatLimit: 50,
      statusPageLimit: null as number | null,
      teamAlerts: true as boolean,
      proUntil: null,
      activeSourceAppIds: null,
      canSwitchActiveAt: null
    };
  }
});

/** The cloud build syncs admin grants here; self-hosted has nothing to sync. */
export const syncMyPlan = mutation({
  args: {},
  returns: v.object({ admin: v.boolean() }),
  handler: async () => ({ admin: false })
});
