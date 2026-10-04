'use node';

import { ConvexError, v } from 'convex/values';
import { createPrivateKey, createSign } from 'node:crypto';
import { action } from './_generated/server';
import { components } from './_generated/api';
import { requireAuth } from './lib/auth';

/**
 * Sign in with Apple token revocation, which App Review requires when an
 * account that uses Apple is deleted.
 *
 * Env: APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (a .p8 key with
 * Sign in with Apple enabled), plus APPLE_BUNDLE_ID. See
 * docs/SIGN_IN_WITH_APPLE.md.
 */
export const revokeForDeletion = action({
  args: { authorizationCode: v.string() },
  returns: v.object({ status: v.union(v.literal('revoked'), v.literal('unconfigured')) }),
  handler: async (ctx, { authorizationCode }) => {
    const userId = await requireAuth(ctx);
    const secret = clientSecret();
    if (!secret) {
      console.warn('[apple] APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY not set; skipped token revocation');
      return { status: 'unconfigured' as const };
    }
    const clientId = bundleId();

    const tokenRes = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        code: authorizationCode,
        grant_type: 'authorization_code'
      })
    });
    if (!tokenRes.ok) {
      throw new ConvexError(`Apple rejected the sign-in (${tokenRes.status}). Try again.`);
    }
    const tokens = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; id_token?: string };

    // The ID token came straight from Apple in exchange for our secret, so its
    // `sub` is trustworthy without re-checking the signature.
    const sub = tokens.id_token ? decodeSub(tokens.id_token) : null;
    const linked = sub
      ? await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'account',
          where: [
            { field: 'accountId', value: sub },
            { field: 'providerId', value: 'apple' }
          ]
        })
      : null;
    if (!linked || String(linked.userId) !== userId) {
      throw new ConvexError("That Apple ID isn't the one linked to this pushr account.");
    }

    const token = tokens.refresh_token ?? tokens.access_token;
    if (token) {
      const revokeRes = await fetch('https://appleid.apple.com/auth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: secret,
          token,
          token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token'
        })
      });
      if (!revokeRes.ok) {
        throw new ConvexError(`Apple couldn't revoke the sign-in (${revokeRes.status}). Try again.`);
      }
    }
    return { status: 'revoked' as const };
  }
});

function bundleId(): string {
  return process.env.APPLE_BUNDLE_ID ?? 'dev.cpreston.pushr';
}

/** The ES256 client secret Apple's token endpoints expect, valid for 5 minutes. */
function clientSecret(): string | null {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const key = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!teamId || !keyId || !key) return null;

  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64url(
    JSON.stringify({ iss: teamId, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: bundleId() })
  )}`;
  const signer = createSign('SHA256');
  signer.update(input);
  signer.end();
  const sig = signer.sign({ key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

function decodeSub(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

function b64url(input: string | Buffer): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}
