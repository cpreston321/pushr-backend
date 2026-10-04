import { components, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Email } from './email';

/**
 * Notices pushr sends on its own (a phone went quiet, a password changed),
 * as opposed to the ones Better Auth sends when asked. Without Resend they're
 * skipped outright rather than logged, and they share the per-address
 * throttle so no event can be used to flood an inbox.
 */
export async function queueEmail(ctx: MutationCtx, email: Email): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) return false;
  if (!(await ctx.runMutation(internal.emailThrottle.take, { email: email.to }))) return false;
  await ctx.scheduler.runAfter(0, internal.emails.send, email);
  return true;
}

/** A pushr user's address and name, from Better Auth's user table. */
export async function userContact(ctx: MutationCtx, userId: string): Promise<{ email: string; name: string | null } | null> {
  const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: '_id', value: userId }]
  });
  return user?.email ? { email: String(user.email), name: user.name ? String(user.name) : null } : null;
}
