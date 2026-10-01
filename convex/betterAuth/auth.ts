import { createClient } from '@convex-dev/better-auth';
import { convex } from '@convex-dev/better-auth/plugins';
import type { GenericCtx } from '@convex-dev/better-auth/utils';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { components, internal } from '../_generated/api';
import type { DataModel } from '../_generated/dataModel';
import authConfig from '../auth.config';
import schema from './schema';
import { resetPasswordEmail, sendEmail, verifyEmailEmail } from '../lib/email';
import { SELF_HOSTED } from '../lib/deployment';

export const authComponent = createClient<DataModel, typeof schema>(components.betterAuth, {
  local: { schema },
  verbose: false
});

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => ({
  appName: 'pushr',
  baseURL: process.env.SITE_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  // Better Auth blocks requests whose Origin isn't on this list. Mobile
  // builds send `pushr://` (the Expo URL scheme); the dev client also sends
  // `exp://…` in some flows. The bare scheme covers production; the wildcard
  // covers Expo Go / dev-client variants.
  // appleid.apple.com: Sign in with Apple posts back from Apple's origin.
  // pushr.sh: where emailed verification links land afterwards.
  trustedOrigins: [
    process.env.SITE_URL!,
    'pushr://',
    'pushr://*',
    'exp://*',
    'https://appleid.apple.com',
    'https://pushr.sh'
  ],
  database: authComponent.adapter(ctx),
  emailAndPassword: {
    enabled: true,
    // Verification is soft: unverified accounts can sign in, and only the
    // actions that trust the address (claiming invites, admin Pro) require it.
    requireEmailVerification: false,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      if (await mayEmail(ctx, user.email)) await sendEmail(resetPasswordEmail(user.email, url));
    }
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      if (await mayEmail(ctx, user.email)) await sendEmail(verifyEmailEmail(user.email, url));
    }
  },
  socialProviders: {
    apple: {
      // The app signs in natively and sends Apple's ID token, which is checked
      // against the bundle id; the client secret is only used by the web
      // redirect flow.
      clientId: process.env.APPLE_CLIENT_ID ?? 'dev.cpreston.pushr',
      clientSecret: process.env.APPLE_CLIENT_SECRET ?? '',
      appBundleIdentifier: process.env.APPLE_BUNDLE_ID ?? 'dev.cpreston.pushr'
    }
  },
  account: {
    accountLinking: {
      enabled: true,
      // Linking from Settings needs both a signed-in session and a fresh Apple
      // token, so the Apple address may differ (Hide My Email relays always do).
      allowDifferentEmails: true
    }
  },
  databaseHooks: {
    user: {
      create: {
        before: async (_user, endpoint) => {
          // Self-hosted servers only take accounts their owner let in: sign-ups
          // from the app carry a grant from a connection code (see pairing.ts).
          // Server-side calls with no request behind them, like
          // seed:createAdmin run from the terminal, are the owner already.
          if (!SELF_HOSTED || !endpoint?.request) return;
          const grant = endpoint.headers?.get('x-pushr-signup-grant');
          const allowed =
            !!grant && 'runMutation' in ctx && (await ctx.runMutation(internal.pairing.consumeGrant, { grant }));
          if (!allowed) {
            throw new APIError('FORBIDDEN', {
              code: 'PAIRING_REQUIRED',
              message: "This server only accepts new accounts with a connection code from its owner."
            });
          }
        }
      }
    },
    account: {
      create: {
        before: async (account, endpoint) => {
          if (account.providerId !== 'apple' || !endpoint) return;
          const existing = await endpoint.context.internalAdapter.findAccountByProviderId(
            account.accountId,
            'apple'
          );
          // Better Auth only checks the current user before linking; without
          // this, one Apple ID could end up attached to two pushr accounts.
          if (existing && existing.userId !== account.userId) {
            throw new APIError('CONFLICT', {
              code: 'APPLE_ID_IN_USE',
              message: 'This Apple ID already signs in to a different pushr account.'
            });
          }
        }
      }
    }
  },
  // Convex JWTs keep the plugin's short default lifetime: they can't be revoked,
  // so sign-out and account deletion only take effect once the current one expires.
  plugins: [convex({ authConfig })]
}) satisfies BetterAuthOptions;

/** Over the limit, the email is dropped silently, so the response doesn't reveal it. */
async function mayEmail(ctx: GenericCtx<DataModel>, email: string): Promise<boolean> {
  if (!('runMutation' in ctx)) return true;
  const allowed = await ctx.runMutation(internal.emailThrottle.take, { email });
  if (!allowed) console.warn('[email] throttled an account email');
  return allowed;
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};

export const { getAuthUser } = authComponent.clientApi();
