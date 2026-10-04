import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { sha256Hex } from './lib/tokens';

/**
 * Connection codes for self-hosted deployments.
 *
 * Only someone with access to the Convex deployment can mint a code (it's an
 * internal function, run from the terminal). The app asks for one before it
 * connects, and redeeming it yields a single-use grant that lets one new
 * account sign up. So a self-hosted server can't quietly become a public
 * pushr: every account on it was let in by its owner.
 */

const CODE_TTL_MS = 15 * 60 * 1000;
const GRANT_TTL_MS = 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;
// No 0/O, 1/I/L: the code is read off a terminal and typed on a phone.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** `bunx convex run pairing:createCode` prints a code to type into the app. */
export const createCode = internalMutation({
  args: {},
  returns: v.object({ code: v.string(), expiresInMinutes: v.number() }),
  handler: async (ctx) => {
    const code = randomCode();
    await ctx.db.insert('pairing', {
      kind: 'code',
      hash: await sha256Hex(code),
      expiresAt: Date.now() + CODE_TTL_MS
    });
    return { code, expiresInMinutes: CODE_TTL_MS / 60_000 };
  }
});

/**
 * Trade a code for a sign-up grant. Codes are single use; failures are
 * counted so the code space can't be brute-forced within its lifetime.
 */
export const redeem = internalMutation({
  args: { code: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), grant: v.string() }),
    v.object({ ok: v.literal(false), reason: v.union(v.literal('invalid'), v.literal('locked')) })
  ),
  handler: async (ctx, { code }) => {
    const now = Date.now();
    const hash = await sha256Hex(normalizeCode(code));
    const row = await ctx.db
      .query('pairing')
      .withIndex('by_hash', (q) => q.eq('hash', hash))
      .unique();
    if (!row || row.kind !== 'code' || row.usedAt !== undefined || row.expiresAt < now) {
      // Past the limit, wrong codes stop being recorded, so a flood of them can't
      // grow the table. A real code still works: refusing it would let anyone
      // keep a server's pairing shut. Guessing one is hopeless regardless
      // (31^8 codes, each live 15 minutes).
      const failures = await ctx.db
        .query('pairing')
        .withIndex('by_kind_expires', (q) => q.eq('kind', 'failure').gt('expiresAt', now))
        .take(MAX_FAILURES);
      if (failures.length >= MAX_FAILURES) return { ok: false as const, reason: 'locked' as const };
      await ctx.db.insert('pairing', { kind: 'failure', hash: '', expiresAt: now + FAILURE_WINDOW_MS });
      return { ok: false as const, reason: 'invalid' as const };
    }
    await ctx.db.patch(row._id, { usedAt: now });

    const grant = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    await ctx.db.insert('pairing', { kind: 'grant', hash: await sha256Hex(grant), expiresAt: now + GRANT_TTL_MS });
    return { ok: true as const, grant };
  }
});

/** Spends a sign-up grant. Called from the Better Auth user-creation hook. */
export const consumeGrant = internalMutation({
  args: { grant: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { grant }) => {
    const hash = await sha256Hex(grant);
    const row = await ctx.db
      .query('pairing')
      .withIndex('by_hash', (q) => q.eq('hash', hash))
      .unique();
    if (!row || row.kind !== 'grant' || row.usedAt !== undefined || row.expiresAt < Date.now()) return false;
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    return true;
  }
});

/** Daily: drop expired codes, grants and failure markers. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let more = false;
    for (const kind of ['code', 'grant', 'failure'] as const) {
      const stale = await ctx.db
        .query('pairing')
        .withIndex('by_kind_expires', (q) => q.eq('kind', kind).lt('expiresAt', now - 24 * 60 * 60 * 1000))
        .take(200);
      for (const row of stale) await ctx.db.delete(row._id);
      if (stale.length === 200) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.pairing.sweep, {});
  }
});
