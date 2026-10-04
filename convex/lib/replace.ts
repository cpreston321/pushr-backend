import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { deleteNotificationCascade } from './notificationCascade';

export const REPLACE_KEY_MAX_LENGTH = 128;
/** Earlier versions kept behind the latest under one key; older ones are deleted. */
export const HISTORY_MAX = 50;
/** Deleted per arrival. More than one, so a key that predates the cap drains. */
const PRUNE_BATCH = 5;

/**
 * Retire the earlier notifications that `notif` replaces: hidden from the
 * feed and marked read, so the badge counts the newest one only. Runs when
 * `notif` becomes visible, so a scheduled replacement doesn't retire its
 * predecessor before it has arrived.
 */
export async function supersedeEarlier(ctx: MutationCtx, notif: Doc<'notifications'>): Promise<void> {
  const key = notif.replaceKey;
  if (!key) return;
  const earlier = await ctx.db
    .query('notifications')
    .withIndex('by_sourceApp_replaceKey', (q) =>
      q.eq('sourceAppId', notif.sourceAppId).eq('replaceKey', key).lte('createdAt', notif.createdAt)
    )
    .order('desc')
    // Each arrival retires the one before it, so only the newest few can
    // still be live; the rest were retired by an earlier arrival.
    .take(10);
  const now = Date.now();
  const previous = earlier.find((row) => row._id !== notif._id && !row.pending);
  if (previous) await ctx.db.patch(notif._id, { revision: (previous.revision ?? 1) + 1 });
  for (const row of earlier) {
    if (row._id === notif._id || row.replacedBy || row.pending) continue;
    await ctx.db.patch(row._id, { replacedBy: notif._id, readAt: row.readAt ?? now });
  }

  // Replaced versions stay in the table, hidden, and the feed's queries step
  // over them. A key updated every few minutes would leave thousands behind
  // and push those reads past Convex's limits, so each key keeps a bounded
  // timeline.
  const beyond = await ctx.db
    .query('notifications')
    .withIndex('by_sourceApp_replaceKey', (q) =>
      q.eq('sourceAppId', notif.sourceAppId).eq('replaceKey', key).lt('createdAt', notif.createdAt)
    )
    .order('desc')
    .take(HISTORY_MAX + PRUNE_BATCH);
  for (const row of beyond.slice(HISTORY_MAX)) {
    if (row.replacedBy) await deleteNotificationCascade(ctx, row._id);
  }
}
