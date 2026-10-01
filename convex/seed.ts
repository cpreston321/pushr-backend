import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
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
      return { created: true, email, userId: result.user.id };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (/already|exists|unique/i.test(message)) {
        return { created: false, email, reason: 'already exists' };
      }
      throw err;
    }
  }
});
