import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Sharing roles, from least to most privileged.
 * Owner is implicit (the `sourceApps.ownerId` itself) — never stored as a
 * `sourceAppMembers` row.
 */
export type SourceAppRole = 'viewer' | 'editor' | 'owner';

const ROLE_RANK: Record<SourceAppRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3
};

/**
 * Resolve the caller's role on a source app, or null if they have no access.
 * The source app document itself is returned alongside so callers don't need
 * a second `db.get` for the common ownership-guard pattern.
 */
export async function getSourceAppRole(
  ctx: QueryCtx | MutationCtx,
  sourceAppId: Id<'sourceApps'>,
  userId: string
): Promise<{ app: Doc<'sourceApps'>; role: SourceAppRole } | null> {
  const app = await ctx.db.get(sourceAppId);
  if (!app || app.revokedAt) return null;
  if (app.ownerId === userId) return { app, role: 'owner' };
  const member = await ctx.db
    .query('sourceAppMembers')
    .withIndex('by_app_user', (q) => q.eq('sourceAppId', sourceAppId).eq('userId', userId))
    .unique();
  if (!member || !member.acceptedAt) return null;
  return { app, role: member.role };
}

/**
 * Throw `ConvexError("Source app not found")` if the caller's role is below
 * `minRole`. Returns the resolved app + role on success. Uses the same
 * "not found" message as the legacy ownership guard so we don't leak
 * existence to non-members.
 */
export async function requireSourceAppRole(
  ctx: QueryCtx | MutationCtx,
  sourceAppId: Id<'sourceApps'>,
  userId: string,
  minRole: SourceAppRole
): Promise<{ app: Doc<'sourceApps'>; role: SourceAppRole }> {
  const access = await getSourceAppRole(ctx, sourceAppId, userId);
  if (!access || ROLE_RANK[access.role] < ROLE_RANK[minRole]) {
    throw new ConvexError('Source app not found');
  }
  return access;
}

/**
 * List every (non-revoked) source app the user can see — apps they own plus
 * apps they're an accepted member of. Returns the row + their role.
 *
 * Two index scans (`sourceApps.by_owner` and `sourceAppMembers.by_user`)
 * followed by point lookups for the member apps. Bounded by app count per
 * user, which is small in practice.
 */
export async function listAccessibleSourceApps(
  ctx: QueryCtx | MutationCtx,
  userId: string
): Promise<Array<{ app: Doc<'sourceApps'>; role: SourceAppRole }>> {
  const [owned, memberships] = await Promise.all([
    ctx.db
      .query('sourceApps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .collect(),
    ctx.db
      .query('sourceAppMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
  ]);
  const out: Array<{ app: Doc<'sourceApps'>; role: SourceAppRole }> = [];
  for (const app of owned) {
    if (!app.revokedAt) out.push({ app, role: 'owner' });
  }
  for (const m of memberships) {
    if (!m.acceptedAt) continue;
    const app = await ctx.db.get(m.sourceAppId);
    if (!app || app.revokedAt) continue;
    out.push({ app, role: m.role });
  }
  return out;
}

export function canManageSharing(role: SourceAppRole): boolean {
  return role === 'owner';
}

export function canEditSettings(role: SourceAppRole): boolean {
  return role === 'owner' || role === 'editor';
}
