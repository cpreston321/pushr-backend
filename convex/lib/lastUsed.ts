import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/**
 * How stale `sourceApps.lastUsedAt` is allowed to get.
 *
 * It used to be patched on every accepted push, which put a write to the app
 * document in every ingest transaction — a second contention point next to the
 * usage counter, and an invalidation of every subscription that reads source
 * apps (the apps list, the feed's app join, the unread badge) on every single
 * notification. The value is only ever rendered as coarse relative time
 * ("Last used 7h ago"), so a minute of staleness is invisible.
 */
const LAST_USED_COALESCE_MS = 60_000;

/** Patch `lastUsedAt` only when the stored value has actually gone stale. */
export async function touchLastUsed(
  ctx: MutationCtx,
  app: { _id: Id<'sourceApps'>; lastUsedAt?: number }
): Promise<void> {
  const now = Date.now();
  if (app.lastUsedAt !== undefined && now - app.lastUsedAt < LAST_USED_COALESCE_MS) {
    return;
  }
  await ctx.db.patch(app._id, { lastUsedAt: now });
}
