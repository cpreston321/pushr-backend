import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';
import { sha256Hex } from './lib/tokens';

/**
 * Wrong passwords, counted per email address. Better Auth's own rate limiter
 * keys on the client IP, which a direct caller of the Convex site URL can set
 * to anything, and keeps its counts in memory that Convex doesn't carry
 * between requests; this doesn't depend on either.
 *
 * A lock only stops password sign-in for the address. Apple sign-in and
 * password reset still work, so someone guessing at another person's
 * address can't keep them out of their account.
 */

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES = 10;

const keyOf = (email: string) => sha256Hex(email.trim().toLowerCase());

export const isLocked = internalQuery({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { email }) => {
    const key = await keyOf(email);
    const recent = await ctx.db
      .query('signInFailures')
      .withIndex('by_key_at', (q) => q.eq('key', key).gt('at', Date.now() - WINDOW_MS))
      .take(MAX_FAILURES);
    return recent.length >= MAX_FAILURES;
  }
});

export const recordFailure = internalMutation({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, { email }) => {
    await ctx.db.insert('signInFailures', { key: await keyOf(email), at: Date.now() });
    return null;
  }
});

/** A right password starts the count over. */
export const clear = internalMutation({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, { email }) => {
    const key = await keyOf(email);
    const rows = await ctx.db
      .query('signInFailures')
      .withIndex('by_key_at', (q) => q.eq('key', key))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  }
});

export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query('signInFailures')
      .withIndex('by_at', (q) => q.lt('at', Date.now() - WINDOW_MS))
      .take(200);
    for (const row of stale) await ctx.db.delete(row._id);
    if (stale.length === 200) await ctx.scheduler.runAfter(0, internal.signInThrottle.sweep, {});
    return null;
  }
});
