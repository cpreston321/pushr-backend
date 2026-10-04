import { v, ConvexError } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireAuth } from './lib/auth';
import { requireSourceAppRole } from './lib/sharing';
import { ON_CALL_MAX_PEOPLE, onCallOrder } from './lib/onCall';

/**
 * A source app's on-call rotation and critical alerts: who urgent pushes
 * reach first, and which pushes may ring through mute. Owner-set, Pro.
 */

export const ESCALATE_MIN_SEC = 60;
export const ESCALATE_MAX_SEC = 3_600;

export const getSettings = query({
  args: { sourceAppId: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app, role } = await requireSourceAppRole(ctx, args.sourceAppId, userId, 'viewer');
    const members = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
      .collect();
    const people = [
      { userId: app.ownerId, email: null as string | null, isOwner: true, isMe: app.ownerId === userId },
      ...members
        .filter((m) => m.acceptedAt)
        .map((m) => ({ userId: m.userId, email: m.email ?? null, isOwner: false, isMe: m.userId === userId }))
    ];
    return {
      canEdit: role === 'owner',
      onCall: app.onCall ?? null,
      onCallNow: onCallOrder(app, Date.now()),
      criticalAlerts: app.criticalAlerts ?? 'off',
      people
    };
  }
});

export const setOnCall = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    enabled: v.boolean(),
    userIds: v.array(v.string()),
    escalateAfterSec: v.number(),
    rotation: v.union(v.literal('none'), v.literal('weekly'))
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ownedApp(ctx, args.sourceAppId);
    if (new Set(args.userIds).size !== args.userIds.length) throw new ConvexError('Each person can be on the rotation once.');
    if (args.userIds.length > ON_CALL_MAX_PEOPLE) throw new ConvexError(`A rotation has at most ${ON_CALL_MAX_PEOPLE} people.`);
    if (args.enabled && args.userIds.length < 2) throw new ConvexError('On-call needs at least two people to escalate between.');
    if (args.escalateAfterSec < ESCALATE_MIN_SEC || args.escalateAfterSec > ESCALATE_MAX_SEC) {
      throw new ConvexError('Escalate after 1 to 60 minutes.');
    }
    const members = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
      .collect();
    const allowed = new Set([app.ownerId, ...members.filter((m) => m.acceptedAt).map((m) => m.userId)]);
    if (args.userIds.some((id) => !allowed.has(id))) throw new ConvexError('Everyone on call must be on this app.');

    const sameRotation =
      app.onCall?.rotation === args.rotation && app.onCall.userIds.join() === args.userIds.join();
    await ctx.db.patch(app._id, {
      onCall: {
        enabled: args.enabled,
        userIds: args.userIds,
        escalateAfterSec: args.escalateAfterSec,
        rotation: args.rotation,
        // A changed list starts with its first person this week.
        rotationStartedAt: sameRotation ? app.onCall!.rotationStartedAt : Date.now()
      }
    });
    return null;
  }
});

export const setCriticalAlerts = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    mode: v.union(v.literal('off'), v.literal('marked'), v.literal('urgent'))
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ownedApp(ctx, args.sourceAppId, args.mode === 'off');
    await ctx.db.patch(app._id, { criticalAlerts: args.mode });
    return null;
  }
});

async function ownedApp(ctx: MutationCtx, sourceAppId: Id<'sourceApps'>, turningOff = false) {
  const userId = await requireAuth(ctx);
  const { app } = await requireSourceAppRole(ctx, sourceAppId, userId, 'owner');
  void turningOff;
  return app;
}
