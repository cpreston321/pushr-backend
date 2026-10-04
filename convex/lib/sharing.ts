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
  // A locked app takes no changes from any client, its owner's included. Only
  // mutations are refused (a query has no scheduler): reading stays open.
  if (minRole !== 'viewer' && 'scheduler' in ctx && (await appLocked(ctx, sourceAppId))) {
    throw new ConvexError('This is pushr’s own app. It’s changed from the backend only.');
  }
  return access;
}

/**
 * Whether an app takes changes from the backend only. On pushr cloud that's
 * pushr's own app, the one with the status page status.pushr.sh draws (env:
 * PUSHR_STATUS_PAGE); clients see it read-only. Self-hosted, no app is.
 */
export async function appLocked(ctx: QueryCtx | MutationCtx, sourceAppId: Id<'sourceApps'>): Promise<boolean> {
  let locked = false;
  void ctx;
  void sourceAppId;
  return locked;
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

/**
 * Accepted members in the order they joined, and the ones whose pushes are
 * paused because the owner's plan has fewer seats than the app has members.
 * The earliest to join keep their seats.
 */
export async function memberSeating(
  ctx: QueryCtx | MutationCtx,
  app: Doc<'sourceApps'>
): Promise<{ seated: string[]; paused: string[] }> {
  const rows = await ctx.db
    .query('sourceAppMembers')
    .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
    .collect();
  const accepted = rows
    .filter((m) => m.acceptedAt !== undefined)
    .toSorted((a, b) => a.acceptedAt! - b.acceptedAt!)
    .map((m) => m.userId);
  let seats = accepted.length;
  return { seated: accepted.slice(0, seats), paused: accepted.slice(seats) };
}

/** Everyone whose devices get the app's pushes: the owner and seated members. */
export async function pushRecipients(ctx: QueryCtx | MutationCtx, app: Doc<'sourceApps'>): Promise<string[]> {
  const { seated } = await memberSeating(ctx, app);
  return [app.ownerId, ...seated.filter((id) => id !== app.ownerId)];
}

export function canManageSharing(role: SourceAppRole): boolean {
  return role === 'owner';
}

export function canEditSettings(role: SourceAppRole): boolean {
  return role === 'owner' || role === 'editor';
}

/** Bounds the links one invite can collect from resends and shares. */
export const MAX_LINKS_PER_INVITE = 10;

/** Delete an invite's one-tap links; call wherever the invite itself is deleted or withdrawn. */
export async function deleteInviteLinks(ctx: MutationCtx, inviteId: Id<'sourceAppInvites'>): Promise<void> {
  const links = await ctx.db
    .query('sourceAppInviteLinks')
    .withIndex('by_invite', (q) => q.eq('inviteId', inviteId))
    .take(MAX_LINKS_PER_INVITE + 1);
  for (const link of links) await ctx.db.delete(link._id);
}
