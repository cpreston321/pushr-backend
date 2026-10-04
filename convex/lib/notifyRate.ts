import { ConvexError } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

export const NOTIFY_RATE_LIMIT = 120;
const WINDOW_MS = 60_000;

/**
 * Counts one push against the source app's fixed one-minute window and throws
 * RATE_LIMITED past the limit. One row per app, reset when the minute turns,
 * so the table never outgrows the number of apps.
 */
export async function chargeNotifyRate(ctx: MutationCtx, app: Doc<'sourceApps'>, now: number): Promise<void> {
  const windowStart = now - (now % WINDOW_MS);
  const row = await ctx.db
    .query('notifyRate')
    .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', app._id))
    .unique();
  if (!row) {
    await ctx.db.insert('notifyRate', { sourceAppId: app._id, windowStart, count: 1 });
    return;
  }
  if (row.windowStart !== windowStart) {
    await ctx.db.patch(row._id, { windowStart, count: 1 });
    return;
  }
  if (row.count >= NOTIFY_RATE_LIMIT) {
    throw new ConvexError({
      code: 'RATE_LIMITED',
      message: `Too many pushes from this app: the limit is ${NOTIFY_RATE_LIMIT} per minute.`,
      retryAfterSec: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000))
    });
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
}
