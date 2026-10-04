import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { components } from './_generated/api';

/**
 * Better Auth stores the key that signs Convex tokens encrypted with
 * BETTER_AUTH_SECRET. After the secret changes, every token request fails with
 * "Failed to decrypt private key" and nobody can use the app, though sign-in
 * itself still works. Deleting the stored key makes Better Auth generate a new
 * one with the current secret on the next request; existing tokens stop
 * working and the app quietly fetches new ones.
 *
 *   bunx convex run maintenance:resetAuthKeys
 */
export const resetAuthKeys = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const result = await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: 'jwks' },
      paginationOpts: { cursor: null, numItems: 100 }
    });
    return { deleted: result.count ?? 0 };
  }
});
