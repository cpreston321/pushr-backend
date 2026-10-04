import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx, ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { components } from '../_generated/api';

/**
 * Return the Better Auth user subject (stable user id) or null.
 * This is what we use as `userId` in pushr — we don't mirror users into a
 * separate table, the BA component holds the source of truth.
 */
export async function getAuthUserId(
  ctx: Pick<QueryCtx | MutationCtx | ActionCtx, 'auth'>
): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.subject ?? null;
}

export async function requireAuth(
  ctx: Pick<QueryCtx | MutationCtx | ActionCtx, 'auth'>
): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError('Not authenticated');
  return userId;
}

/**
 * Like requireAuth but also returns the user's email (lowercased) when
 * available. Used for matching email-keyed invites.
 */
export async function requireAuthIdentity(
  ctx: Pick<QueryCtx | MutationCtx | ActionCtx, 'auth'>
): Promise<{ userId: string; email: string | null }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError('Not authenticated');
  const email =
    typeof identity.email === 'string' && identity.email.length > 0
      ? identity.email.toLowerCase()
      : null;
  return { userId: identity.subject, email };
}

export type PushrUserId = string;

// Re-exports for type unification across files
export type { Id };

/**
 * Whether the user has confirmed their email. Read from the Better Auth user
 * record rather than the JWT claim, which can lag behind by the token's
 * 30-day lifetime.
 */
export async function isEmailVerified(
  ctx: Pick<QueryCtx | MutationCtx, 'runQuery'>,
  userId: string
): Promise<boolean> {
  const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: '_id', value: userId }]
  });
  return user?.emailVerified === true;
}
