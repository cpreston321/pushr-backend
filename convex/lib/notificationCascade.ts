import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/**
 * Delete a notification with its per-device delivery rows and action events.
 * Direct deletes need this: the daily cleanup cron is the only other code
 * path that knows to chase the children.
 */
export async function deleteNotificationCascade(ctx: MutationCtx, id: Id<'notifications'>) {
  const deliveries = await ctx.db
    .query('deliveries')
    .withIndex('by_notification', (q) => q.eq('notificationId', id))
    .collect();
  for (const d of deliveries) await ctx.db.delete(d._id);
  const events = await ctx.db
    .query('actionEvents')
    .withIndex('by_notification', (q) => q.eq('notificationId', id))
    .collect();
  for (const e of events) await ctx.db.delete(e._id);
  await ctx.db.delete(id);
}
