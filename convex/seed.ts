import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import { components } from './_generated/api';
import { SELF_HOSTED } from './lib/deployment';
import { createAuth } from './betterAuth/auth';

/**
 * Seed a dev user so you can log in without going through the signup flow.
 *
 * Run with:
 *   bunx convex run seed:createAdmin
 *   bunx convex run seed:createAdmin '{"email":"foo@bar.dev","password":"..."}'
 *
 * If a user with the same email already exists this is a no-op.
 */
export const createAdmin = internalMutation({
  args: {
    email: v.optional(v.string()),
    password: v.optional(v.string()),
    name: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const name = args.name ?? 'Admin';
    const email = args.email;
    const password = args.password;

    if (!email || !password) return { created: false, reason: 'missing email or password' };

    const auth = createAuth(ctx);
    try {
      const result = await auth.api.signUpEmail({
        body: { email, password, name }
      });
      await markOwner(ctx, result.user.id);
      return { created: true, email, userId: result.user.id };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (/already|exists|unique/i.test(message)) {
        // Running it again for an existing account makes that account an owner.
        const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: 'email', value: email.trim().toLowerCase() }]
        });
        if (user) await markOwner(ctx, String(user._id));
        return { created: false, email, reason: 'already exists' };
      }
      throw err;
    }
  }
});

/** Owners only matter on a self-hosted server, where they let new people in (lib/owners.ts). */
async function markOwner(ctx: MutationCtx, userId: string) {
  if (!SELF_HOSTED) return;
  const existing = await ctx.db
    .query('serverOwners')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
  if (!existing) await ctx.db.insert('serverOwners', { userId });
}
