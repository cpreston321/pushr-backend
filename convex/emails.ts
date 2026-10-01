import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { sendEmail } from './lib/email';

/**
 * Account emails go through the scheduler so they can be queued from any
 * Better Auth call: HTTP sign-ups run in an action, but seed:createAdmin runs
 * in a mutation, which can't fetch.
 */
export const send = internalAction({
  args: { to: v.string(), subject: v.string(), html: v.string(), text: v.string() },
  handler: async (_ctx, email) => {
    await sendEmail(email);
  }
});
