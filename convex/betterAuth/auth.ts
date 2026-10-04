import { createClient } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import type { GenericCtx } from '@convex-dev/better-auth/utils';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { nonceIsForServer } from '../lib/appleNonce';
import { components, internal } from '../_generated/api';
import type { DataModel } from '../_generated/dataModel';
import authConfig from '../auth.config';
import schema from './schema';
import { passwordChangedEmail, resetPasswordEmail, verifyEmailEmail, welcomeEmail, type Email } from '../lib/email';
import { SELF_HOSTED } from '../lib/deployment';
import { appleSignInEnabled } from '../lib/features';

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'https://app.pushr.sh';

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
  // DASHBOARD_URL: the web dashboard (app.pushr.sh), on any server.
  trustedOrigins: [
    process.env.SITE_URL!,
    'pushr://',
    'pushr://*',
    'exp://*',
    'https://appleid.apple.com',
    'https://pushr.sh',
    DASHBOARD_URL,
    ...(process.env.WEB_ORIGIN ? [process.env.WEB_ORIGIN] : []),
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
    },
    onPasswordReset: async ({ user }) => {
      await queueEmail(ctx, passwordChangedEmail(user.email, 'reset'));
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
  // Only registered where Sign in with Apple is on (lib/features.ts), so a
  // self-hosted server refuses Apple sign-ins rather than just hiding the button.
  socialProviders: appleSignInEnabled()
    ? {
        apple: appleProvider()
      }
    : {},
  hooks: {
    before: createAuthMiddleware(async (endpoint) => {
      if (endpoint.path === '/sign-in/email') {
        const email = (endpoint.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && 'runQuery' in ctx && (await ctx.runQuery(internal.signInThrottle.isLocked, { email }))) {
          throw new APIError('TOO_MANY_REQUESTS', {
            code: 'TOO_MANY_SIGN_IN_ATTEMPTS',
            message: 'Too many wrong passwords. Try again in 15 minutes, or reset your password.'
          });
        }
        return;
      }
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
    }),
    after: createAuthMiddleware(async (endpoint) => {
      if (endpoint.path === '/change-password') {
        const user = (endpoint.context.returned as { user?: { email?: unknown } } | undefined)?.user;
        if (!(endpoint.context.returned instanceof APIError) && typeof user?.email === 'string') {
          await queueEmail(ctx, passwordChangedEmail(user.email, 'changed'));
        }
        return;
      }
      if (endpoint.path !== '/sign-in/email' || !('runMutation' in ctx)) return;
      const email = (endpoint.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== 'string') return;
      const returned = endpoint.context.returned;
      if (returned instanceof APIError) {
        if (returned.statusCode === 401) await ctx.runMutation(internal.signInThrottle.recordFailure, { email });
      } else {
        await ctx.runMutation(internal.signInThrottle.clear, { email });
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
        before: async (user, endpoint) => {
          // Self-hosted servers only take accounts their owner let in: sign-ups
          // from the app carry a grant from a connection code (see pairing.ts).
          // Server-side calls with no request behind them, like
          // seed:createAdmin run from the terminal, are the owner already.
          if (!SELF_HOSTED || !endpoint?.request) return;
          const grant = endpoint.headers?.get('x-pushr-signup-grant');
          // An invite link stands in for a code, for the address it was sent to.
          const inviteToken = endpoint.headers?.get('x-pushr-invite-token');
          const allowed =
            (!!inviteToken &&
              'runQuery' in ctx &&
              (await ctx.runQuery(internal.sharing.inviteAllowsSignup, { token: inviteToken, email: user.email }))) ||
            (!!grant && 'runMutation' in ctx && (await ctx.runMutation(internal.pairing.consumeGrant, { grant })));
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
  plugins: [
    convex({ authConfig }),
    // A self-hosted server is on another domain from the dashboard, so its
    // session travels in a header the dashboard keeps, not a cookie. Cloud
    // shares pushr.sh's cookie through the site's /api/auth proxy instead.
    ...(SELF_HOSTED ? [crossDomain({ siteUrl: DASHBOARD_URL })] : []),
  ]
}) satisfies BetterAuthOptions;

/**
 * The app signs in natively and sends Apple's ID token, checked against the
 * bundle id. On pushr cloud with a Services ID, the website signs in with
 * Apple's redirect flow too, with a client secret signed per request.
 */
function appleProvider() {
  const bundleId = process.env.APPLE_BUNDLE_ID ?? 'dev.cpreston.pushr';
  const native = {
    clientId: process.env.APPLE_CLIENT_ID ?? bundleId,
    clientSecret: process.env.APPLE_CLIENT_SECRET ?? '',
    appBundleIdentifier: bundleId
  };
  return native;
}

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
