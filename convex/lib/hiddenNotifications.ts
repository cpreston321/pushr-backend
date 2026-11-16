import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { AccessibleApp } from './sharing';

/** Whether a push is in this user's feed: not cleared or deleted by them as a viewer. Owners and editors delete instead. */
export async function inMemberFeed(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  access: AccessibleApp,
  n: Doc<'notifications'>
): Promise<boolean> {
  if (access.role !== 'viewer') return true;
  if (access.clearedBefore !== undefined && n.createdAt <= access.clearedBefore) return false;
  return !(await isHidden(ctx, userId, n._id));
}

async function isHidden(ctx: QueryCtx | MutationCtx, userId: string, notificationId: Id<'notifications'>) {
  const row = await ctx.db
    .query('hiddenNotifications')
    .withIndex('by_user_notification', (q) => q.eq('userId', userId).eq('notificationId', notificationId))
    .first();
  return row !== null;
}

export async function hideFromMember(ctx: MutationCtx, userId: string, notificationId: Id<'notifications'>) {
  if (await isHidden(ctx, userId, notificationId)) return;
  await ctx.db.insert('hiddenNotifications', { userId, notificationId });
}
