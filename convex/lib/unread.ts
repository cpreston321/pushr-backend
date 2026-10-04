import type { Doc } from '../_generated/dataModel';

/**
 * Unread items as the feed shows them: a Live Activity's steps are one card,
 * so they count once, however many arrived.
 */
export function countUnreadEntries(rows: Doc<'notifications'>[]): number {
  const activities = new Set<string>();
  let n = 0;
  for (const r of rows) {
    const id = r.liveActivity?.activityId;
    if (id !== undefined) {
      if (activities.has(id)) continue;
      activities.add(id);
    }
    n++;
  }
  return n;
}
