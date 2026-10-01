import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

const HOUR = 60 * 60 * 1000;
/** Per recipient: enough for a retry or two, too few to flood an inbox. */
const PER_ADDRESS_PER_HOUR = 3;
/** Across everyone: caps what an abuser can cost in Resend sends. */
const GLOBAL_PER_HOUR = 300;

/**
 * Reserves a send for an account email (verification, password reset).
 * Better Auth sends these to any address typed at sign-up or reset, so
 * without a cap anyone could email-bomb a stranger through pushr.
 */
export const take = internalMutation({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { email }) => {
    const now = Date.now();
    const address = email.trim().toLowerCase();
    const recent = (key: string, limit: number) =>
      ctx.db
        .query('emailSends')
        .withIndex('by_key_sent', (q) => q.eq('key', key).gt('sentAt', now - HOUR))
        .take(limit);
    if ((await recent(`to:${address}`, PER_ADDRESS_PER_HOUR)).length >= PER_ADDRESS_PER_HOUR) return false;
    if ((await recent('all', GLOBAL_PER_HOUR)).length >= GLOBAL_PER_HOUR) return false;
    await ctx.db.insert('emailSends', { key: `to:${address}`, sentAt: now });
    await ctx.db.insert('emailSends', { key: 'all', sentAt: now });
    return true;
  }
});
