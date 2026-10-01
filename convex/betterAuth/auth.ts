import { createClient } from '@convex-dev/better-auth';
import { convex } from '@convex-dev/better-auth/plugins';
import type { GenericCtx } from '@convex-dev/better-auth/utils';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { nonceIsForServer } from '../lib/appleNonce';
import { components, internal } from '../_generated/api';
import type { DataModel } from '../_generated/dataModel';
import authConfig from '../auth.config';
import schema from './schema';
import { resetPasswordEmail, verifyEmailEmail, welcomeEmail, type Email } from '../lib/email';
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
      await queueEmail(ctx, resetPasswordEmail(user.email, url));
    }
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    // At sign-up this is the welcome email, confirm button included, so a new
    // account gets one email rather than two. "Resend" taps get the short one.
    sendVerificationEmail: async ({ user, url }, request) => {
      const signingUp = !request || new URL(request.url).pathname.includes('/sign-up/');
      await queueEmail(
        ctx,
        signingUp ? welcomeEmail(user.email, { name: user.name, confirmUrl: url }) : verifyEmailEmail(user.email, url)
      );
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
  hooks: {
    before: createAuthMiddleware(async (endpoint) => {
      if (endpoint.path !== '/sign-in/social' && endpoint.path !== '/link-social') return;
      const body = endpoint.body as { provider?: string; idToken?: { nonce?: string } } | undefined;
      if (body?.provider !== 'apple' || !body.idToken) return;
      // See lib/appleNonce.ts: an Apple token is only accepted by the server it was made for.
      if (!nonceIsForServer(body.idToken.nonce, [process.env.SITE_URL, process.env.CONVEX_SITE_URL])) {
        throw new APIError('UNAUTHORIZED', {
          code: 'APPLE_NONCE_MISMATCH',
          message: 'That Apple sign-in was meant for a different server. Please try again.'
        });
      }
    })
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
        // Sign in with Apple accounts arrive verified, so no verification
        // email goes out; welcome them here instead.
        after: async (user) => {
          if (user.emailVerified) await queueEmail(ctx, welcomeEmail(user.email, { name: user.name }));
        },
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

/**
 * Throttled, then handed to the scheduler (see emails.ts). Over the limit the
 * email is dropped silently, so the response doesn't reveal it.
 */
async function queueEmail(ctx: GenericCtx<DataModel>, email: Email): Promise<void> {
  if (!('runMutation' in ctx) || !('scheduler' in ctx)) return;
  if (!(await ctx.runMutation(internal.emailThrottle.take, { email: email.to }))) {
    console.warn('[email] throttled an account email');
    return;
  }
  await ctx.scheduler.runAfter(0, internal.emails.send, email);
}

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};

export const { getAuthUser } = authComponent.clientApi();
