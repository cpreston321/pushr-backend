import { v, ConvexError } from 'convex/values';
import { query, mutation } from './_generated/server';
import { isEmailVerified, requireAuth, requireAuthIdentity } from './lib/auth';
import { getSourceAppRole, requireSourceAppRole, canManageSharing } from './lib/sharing';
import type { Doc, Id } from './_generated/dataModel';

/**
 * Count how many other users a source app is shared with — accepted members
 * plus outstanding pending invites. Used for tier-limit enforcement.
 */
async function countSharedUsers(
  ctx: Parameters<typeof getSourceAppRole>[0],
  sourceAppId: Id<'sourceApps'>
): Promise<{ accepted: number; pending: number; total: number }> {
  const [members, invites] = await Promise.all([
    ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app', (q) => q.eq('sourceAppId', sourceAppId))
      .collect(),
    ctx.db
      .query('sourceAppInvites')
      .withIndex('by_app', (q) => q.eq('sourceAppId', sourceAppId))
      .collect()
  ]);
  const now = Date.now();
  const accepted = members.filter((m) => m.acceptedAt).length;
  const pending = invites.filter(
    (i) => !i.acceptedAt && !i.declinedAt && !i.canceledAt && i.expiresAt > now
  ).length;
  return { accepted, pending, total: accepted + pending };
}

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const roleArg = v.union(v.literal('editor'), v.literal('viewer'));

/**
 * List members + pending invites for a source app. Caller must have at least
 * viewer access. Owners and editors see the full list; viewers see members
 * but not the invite metadata (kept consistent for now — revisit if we want
 * stricter visibility).
 */
export const listMembers = query({
  args: { sourceAppId: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const access = await requireSourceAppRole(ctx, args.sourceAppId, userId, 'viewer');

    const memberRows = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app', (q) => q.eq('sourceAppId', args.sourceAppId))
      .collect();
    const inviteRows = await ctx.db
      .query('sourceAppInvites')
      .withIndex('by_app', (q) => q.eq('sourceAppId', args.sourceAppId))
      .collect();

    const members = memberRows
      .filter((m) => m.acceptedAt)
      .map((m) => ({
        _id: m._id,
        userId: m.userId,
        email: m.email ?? null,
        role: m.role,
        acceptedAt: m.acceptedAt,
        isMe: m.userId === userId
      }));

    const now = Date.now();
    const invites = inviteRows
      .filter((i) => !i.acceptedAt && !i.declinedAt && !i.canceledAt && i.expiresAt > now)
      .map((i) => ({
        _id: i._id,
        email: i.email,
        role: i.role,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt
      }));


    return {
      myRole: access.role,
      ownerId: access.app.ownerId,
      members,
      invites
    };
  }
});

/**
 * Pending invites for the currently signed-in user, matched by email.
 * The mobile client uses this to show a banner / inbox row.
 */
export const listMyPendingInvites = query({
  args: {},
  handler: async (ctx) => {
    const { userId, email } = await requireAuthIdentity(ctx);
    // Invites match on email, so an unconfirmed address could be someone else's.
    if (!email || !(await isEmailVerified(ctx, userId))) return [];
    const now = Date.now();
    const rows = await ctx.db
      .query('sourceAppInvites')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect();
    const live = rows.filter(
      (i) => !i.acceptedAt && !i.declinedAt && !i.canceledAt && i.expiresAt > now
    );
    const out = await Promise.all(
      live.map(async (i) => {
        const app = await ctx.db.get(i.sourceAppId);
        if (!app || app.revokedAt) return null;
        const logoUrl = app.logoStorageId ? await ctx.storage.getUrl(app.logoStorageId) : null;
        return {
          _id: i._id,
          sourceAppId: i.sourceAppId,
          sourceAppName: app.name,
          sourceAppLogoUrl: logoUrl,
          role: i.role,
          invitedBy: i.invitedBy,
          invitedByEmail: i.invitedByEmail ?? null,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt
        };
      })
    );
    return out.filter((r): r is NonNullable<typeof r> => r !== null);
  }
});

/**
 * Owner invites someone by email. Idempotent on (sourceAppId, email):
 * sending again refreshes the expiry of an existing pending invite.
 *
 * If the email matches an existing accepted member, returns
 * { alreadyMember: true } and does not create a new invite.
 */
export const inviteByEmail = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    email: v.string(),
    role: roleArg
  },
  handler: async (ctx, args) => {
    const inviter = await requireAuthIdentity(ctx);
    const { app, role } = await requireSourceAppRole(
      ctx,
      args.sourceAppId,
      inviter.userId,
      'owner'
    );
    if (!canManageSharing(role)) throw new ConvexError('Source app not found');

    const email = args.email.trim().toLowerCase();
    if (!isValidEmail(email)) {
      throw new ConvexError('Enter a valid email address');
    }
    if (inviter.email && email === inviter.email) {
      throw new ConvexError("That's your own email — you already own this app");
    }

    // Already an accepted member?
    const existingMembers = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
      .collect();
    const matchedMember = existingMembers.find(
      (m) => m.email && m.email.toLowerCase() === email && m.acceptedAt
    );
    if (matchedMember) {
      return { alreadyMember: true as const };
    }

    const now = Date.now();
    const existing = await ctx.db
      .query('sourceAppInvites')
      .withIndex('by_app_email', (q) => q.eq('sourceAppId', app._id).eq('email', email))
      .collect();
    const live = existing.find((i) => !i.acceptedAt && !i.declinedAt && !i.canceledAt);


    if (live) {
      await ctx.db.patch(live._id, {
        role: args.role,
        expiresAt: now + INVITE_TTL_MS,
        invitedBy: inviter.userId,
        invitedByEmail: inviter.email ?? undefined
      });
      return { inviteId: live._id, refreshed: true as const };
    }

    const inviteId = await ctx.db.insert('sourceAppInvites', {
      sourceAppId: app._id,
      email,
      role: args.role,
      invitedBy: inviter.userId,
      invitedByEmail: inviter.email ?? undefined,
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS
    });
    return { inviteId, refreshed: false as const };
  }
});

export const cancelInvite = mutation({
  args: { inviteId: v.id('sourceAppInvites') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new ConvexError('Invite not found');
    await requireSourceAppRole(ctx, invite.sourceAppId, userId, 'owner');
    if (invite.acceptedAt || invite.declinedAt || invite.canceledAt) return;
    await ctx.db.patch(args.inviteId, { canceledAt: Date.now() });
  }
});

/**
 * Recipient accepts a pending invite. Verifies that the caller's email
 * (from their auth identity) matches the invite's email.
 */
export const acceptInvite = mutation({
  args: { inviteId: v.id('sourceAppInvites') },
  handler: async (ctx, args) => {
    const me = await requireAuthIdentity(ctx);
    if (!me.email) throw new ConvexError('No email on your account');
    if (!(await isEmailVerified(ctx, me.userId))) {
      throw new ConvexError('Confirm your email to accept invites');
    }

    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new ConvexError('Invite not found');
    if (invite.acceptedAt || invite.declinedAt || invite.canceledAt) {
      throw new ConvexError('Invite is no longer pending');
    }
    if (invite.expiresAt < Date.now()) {
      throw new ConvexError('Invite has expired');
    }
    if (invite.email !== me.email) {
      throw new ConvexError('This invite is for a different email');
    }

    const app = await ctx.db.get(invite.sourceAppId);
    if (!app || app.revokedAt) {
      throw new ConvexError('Source app no longer exists');
    }
    if (app.ownerId === me.userId) {
      // Edge case: invite predated a transfer and the recipient is now owner.
      await ctx.db.patch(args.inviteId, { acceptedAt: Date.now() });
      return { sourceAppId: app._id };
    }

    const existing = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app_user', (q) =>
        q.eq('sourceAppId', invite.sourceAppId).eq('userId', me.userId)
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        role: invite.role,
        email: me.email,
        invitedBy: invite.invitedBy,
        acceptedAt: existing.acceptedAt ?? now
      });
    } else {
      await ctx.db.insert('sourceAppMembers', {
        sourceAppId: invite.sourceAppId,
        userId: me.userId,
        role: invite.role,
        invitedBy: invite.invitedBy,
        email: me.email,
        acceptedAt: now
      });
    }
    await ctx.db.patch(args.inviteId, { acceptedAt: now });
    return { sourceAppId: invite.sourceAppId };
  }
});

export const declineInvite = mutation({
  args: { inviteId: v.id('sourceAppInvites') },
  handler: async (ctx, args) => {
    const me = await requireAuthIdentity(ctx);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new ConvexError('Invite not found');
    if (invite.acceptedAt || invite.declinedAt || invite.canceledAt) return;
    if (me.email && invite.email !== me.email) {
      throw new ConvexError('This invite is for a different email');
    }
    await ctx.db.patch(args.inviteId, { declinedAt: Date.now() });
  }
});

export const removeMember = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    memberId: v.id('sourceAppMembers')
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    await requireSourceAppRole(ctx, args.sourceAppId, userId, 'owner');
    const member = await ctx.db.get(args.memberId);
    if (!member || member.sourceAppId !== args.sourceAppId) {
      throw new ConvexError('Member not found');
    }
    await ctx.db.delete(args.memberId);
  }
});

export const setMemberRole = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    memberId: v.id('sourceAppMembers'),
    role: roleArg
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    await requireSourceAppRole(ctx, args.sourceAppId, userId, 'owner');
    const member = await ctx.db.get(args.memberId);
    if (!member || member.sourceAppId !== args.sourceAppId) {
      throw new ConvexError('Member not found');
    }
    await ctx.db.patch(args.memberId, { role: args.role });
  }
});

/**
 * Owner changes the role on a still-pending invite. Unlike re-sending via
 * inviteByEmail, this leaves the expiry alone — purely a role correction.
 */
export const setInviteRole = mutation({
  args: {
    inviteId: v.id('sourceAppInvites'),
    role: roleArg
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new ConvexError('Invite not found');
    if (invite.acceptedAt || invite.declinedAt || invite.canceledAt) {
      throw new ConvexError('Invite is no longer pending');
    }
    await requireSourceAppRole(ctx, invite.sourceAppId, userId, 'owner');
    await ctx.db.patch(args.inviteId, { role: args.role });
  }
});

/**
 * A non-owner member removes themselves from a source app.
 */
export const leaveApp = mutation({
  args: { sourceAppId: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const access = await getSourceAppRole(ctx, args.sourceAppId, userId);
    if (!access) throw new ConvexError('Source app not found');
    if (access.role === 'owner') {
      throw new ConvexError("Owners can't leave — revoke or transfer instead");
    }
    const member = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app_user', (q) => q.eq('sourceAppId', args.sourceAppId).eq('userId', userId))
      .unique();
    if (member) await ctx.db.delete(member._id);
  }
});

function isValidEmail(s: string): boolean {
  // Pragmatic check — full RFC 5322 is overkill. Disallow whitespace, require @
  // and at least one dot in the domain.
  if (s.length < 3 || s.length > 254) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!local || !domain || /\s/.test(s)) return false;
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return false;
  }
  return true;
}
