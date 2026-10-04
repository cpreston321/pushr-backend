import type { QueryCtx } from '../_generated/server';
import { components } from '../_generated/api';

/** Whether `userId` owns this self-hosted server. */
export async function isServerOwner(ctx: QueryCtx, userId: string): Promise<boolean> {
  if (await ctx.db.query('serverOwners').first()) {
    return !!(await ctx.db
      .query('serverOwners')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique());
  }
  // A server set up before owners were recorded: its first account is the owner.
  const oldest = await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: 'user',
    sortBy: { field: 'createdAt', direction: 'asc' },
    paginationOpts: { cursor: null, numItems: 1 }
  });
  const first = oldest.page[0] as { _id: string } | undefined;
  return !!first && String(first._id) === userId;
}
