import { v } from 'convex/values';
import { internalQuery, mutation, query } from './_generated/server';
import { requireAuth } from './lib/auth';

/**
 * Canonical priority bucket for a Gotify-scale (1–10) number.
 * <=4 is low, 5–6 is normal, >=7 is high. Matches the http.ts normalization
 * (low→3, normal→5, high→8).
 */
export function bucketFor(priority: number | undefined): 'low' | 'normal' | 'high' {
  if (priority === undefined) return 'normal';
  if (priority >= 7) return 'high';
  if (priority <= 4) return 'low';
  return 'normal';
}

type SoundValue = string | null;

const DEFAULT_SOUND: SoundValue = 'default';

function resolve(stored: SoundValue | undefined): SoundValue {
  return stored === undefined ? DEFAULT_SOUND : stored;
}

const soundValidator = v.union(v.null(), v.string());

export const getMine = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireAuth(ctx);
    const row = await ctx.db
      .query('userPrefs')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .unique();
    return {
      soundLow: resolve(row?.soundLow),
      soundNormal: resolve(row?.soundNormal),
      soundHigh: resolve(row?.soundHigh)
    };
  }
});

export const update = mutation({
  args: {
    soundLow: v.optional(soundValidator),
    soundNormal: v.optional(soundValidator),
    soundHigh: v.optional(soundValidator)
  },
  handler: async (ctx, args) => {
    const ownerId = await requireAuth(ctx);
    const existing = await ctx.db
      .query('userPrefs')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .unique();
    const merged = {
      soundLow: args.soundLow !== undefined ? args.soundLow : existing?.soundLow,
      soundNormal: args.soundNormal !== undefined ? args.soundNormal : existing?.soundNormal,
      soundHigh: args.soundHigh !== undefined ? args.soundHigh : existing?.soundHigh
    };
    if (existing) {
      await ctx.db.patch(existing._id, merged);
    } else {
      await ctx.db.insert('userPrefs', { ownerId, ...merged });
    }
  }
});

/** Internal: the Expo `sound` value to send for a given priority + owner. */
export const soundForDelivery = internalQuery({
  args: { ownerId: v.string(), priority: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('userPrefs')
      .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
      .unique();
    const bucket = bucketFor(args.priority);
    const stored =
      bucket === 'low' ? row?.soundLow : bucket === 'high' ? row?.soundHigh : row?.soundNormal;
    return { bucket, sound: resolve(stored) };
  }
});
