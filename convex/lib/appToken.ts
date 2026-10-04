import { ConvexError } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { hashToken } from './tokens';

/** The source app a bearer token belongs to, for the token-authenticated HTTP API. */
export async function appForToken(ctx: QueryCtx, token: string): Promise<Doc<'sourceApps'>> {
  const tokenHash = await hashToken(token);
  const app = await ctx.db
    .query('sourceApps')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
    .first();
  if (!app || app.revokedAt) {
    throw new ConvexError({ code: 'INVALID_TOKEN', message: 'Invalid or revoked token' });
  }
  if (!app.enabled) {
    throw new ConvexError({ code: 'APP_DISABLED', message: 'Source app is disabled' });
  }
  return app;
}
