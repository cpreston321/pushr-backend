import { v, ConvexError } from 'convex/values';
import { internalQuery, query, mutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { components, internal } from './_generated/api';
import { isEmailVerified, requireAuth, requireAuthIdentity } from './lib/auth';
import { isServerOwner } from './lib/owners';
import {
  getSourceAppRole,
  requireSourceAppRole,
  canManageSharing,
  deleteInviteLinks,
  memberSeating,
  MAX_LINKS_PER_INVITE
} from './lib/sharing';
import { inviteAcceptedEmail, inviteEmail } from './lib/email';
import { queueEmail, userContact } from './lib/accountMail';
import { SELF_HOSTED } from './lib/deployment';
import { hashToken, randomUrlSafe } from './lib/tokens';
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

    const { paused } = await memberSeating(ctx, access.app);
    const members = memberRows
      .filter((m) => m.acceptedAt)
      .map((m) => ({
        _id: m._id,
        userId: m.userId,
        email: m.email ?? null,
        role: m.role,
        acceptedAt: m.acceptedAt,
        isMe: m.userId === userId,
        // Past the owner's plan's seats: kept on the app, but not pushed to.
        paused: paused.includes(m.userId)
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


    const inviterName = (await ctx.auth.getUserIdentity())?.name || inviter.email || 'Someone';

    if (live) {
      await ctx.db.patch(live._id, {
        role: args.role,
        expiresAt: now + INVITE_TTL_MS,
        invitedBy: inviter.userId,
        invitedByEmail: inviter.email ?? undefined,
        invitedByName: inviterName
      });
      const link = await createInviteLink(ctx, live._id);
      const delivery = await notifyInvitee(ctx, { email, inviteId: live._id, app, inviterName, inviterEmail: inviter.email ?? null, role: args.role, link });
      return { inviteId: live._id, refreshed: true as const, link, delivery };
    }

    const inviteId = await ctx.db.insert('sourceAppInvites', {
      sourceAppId: app._id,
      email,
      role: args.role,
      invitedBy: inviter.userId,
      invitedByEmail: inviter.email ?? undefined,
      invitedByName: inviterName,
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS
    });
    const link = await createInviteLink(ctx, inviteId);
    const delivery = await notifyInvitee(ctx, { email, inviteId, app, inviterName, inviterEmail: inviter.email ?? null, role: args.role, link });
    return { inviteId, refreshed: false as const, link, delivery };
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
    await deleteInviteLinks(ctx, args.inviteId);
  }
});

/** Why an invite can't be accepted any more, or null while it can. */
function inviteClosedReason(invite: Doc<'sourceAppInvites'>): string | null {
  if (invite.acceptedAt) return 'This invite has already been accepted';
  if (invite.declinedAt || invite.canceledAt) return 'This invite was withdrawn';
  if (invite.expiresAt < Date.now()) return 'This invite has expired';
  return null;
}

/** Make the invitee a member and close the invite. */
async function joinFromInvite(
  ctx: MutationCtx,
  invite: Doc<'sourceAppInvites'>,
  me: { userId: string; email: string; name: string | null }
): Promise<{ sourceAppId: Id<'sourceApps'>; appName: string }> {
  const app = await ctx.db.get(invite.sourceAppId);
  if (!app || app.revokedAt) throw new ConvexError('This app no longer exists');
  const now = Date.now();
  // An invite that predates a transfer can name the current owner.
  if (app.ownerId !== me.userId) {
    const existing = await ctx.db
      .query('sourceAppMembers')
      .withIndex('by_app_user', (q) => q.eq('sourceAppId', invite.sourceAppId).eq('userId', me.userId))
      .unique();
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
  }
  // Links stay, so opening one again says the invite was accepted.
  await ctx.db.patch(invite._id, { acceptedAt: now });
  if (invite.invitedBy !== me.userId && app.ownerId !== me.userId) {
    const inviter = await userContact(ctx, invite.invitedBy);
    if (inviter) {
      await queueEmail(
        ctx,
        inviteAcceptedEmail(inviter.email, {
          memberName: me.name || me.email,
          memberEmail: me.email,
          appId: app._id,
          appName: app.name,
          appLogoUrl: app.logoStorageId ? await ctx.storage.getUrl(app.logoStorageId) : null,
          appColor: app.logoColor ?? null,
          role: invite.role
        })
      );
    }
  }
  return { sourceAppId: app._id, appName: app.name };
}

/**
 * Recipient accepts a pending invite from the app. Needs a confirmed email
 * that matches the invite's, since the invite is matched on email alone.
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
    const closed = inviteClosedReason(invite);
    if (closed) throw new ConvexError(closed);
    if (invite.email !== me.email) throw new ConvexError('This invite is for a different email');
    return await joinFromInvite(ctx, invite, { userId: me.userId, email: me.email, name: (await ctx.auth.getUserIdentity())?.name ?? null });
  }
});

const INVITE_PAGE = 'https://pushr.sh/invite/';

/**
 * A new one-tap link for an invite. pushr.sh previews pushr cloud's invites
 * itself; a self-hosted server's links name the server so the app can tell
 * which one the invite is for.
 */
async function createInviteLink(ctx: MutationCtx, inviteId: Id<'sourceAppInvites'>): Promise<string> {
  const existing = await ctx.db
    .query('sourceAppInviteLinks')
    .withIndex('by_invite', (q) => q.eq('inviteId', inviteId))
    .take(MAX_LINKS_PER_INVITE + 1);
  for (const old of existing.slice(0, Math.max(0, existing.length - MAX_LINKS_PER_INVITE + 1))) {
    await ctx.db.delete(old._id);
  }
  const token = `inv_${randomUrlSafe(24)}`;
  await ctx.db.insert('sourceAppInviteLinks', {
    inviteId,
    tokenHash: await hashToken(token),
    createdAt: Date.now()
  });
  if (!SELF_HOSTED) return `${INVITE_PAGE}${token}`;
  // SITE_URL first: a server on a custom domain is known to the app by that,
  // not its .convex.site URL. The Convex URL lets the app connect in one tap.
  const site = process.env.SITE_URL ?? process.env.CONVEX_SITE_URL ?? '';
  const cloud = process.env.CONVEX_CLOUD_URL ?? '';
  return `${INVITE_PAGE}${token}?s=${encodeURIComponent(site)}&c=${encodeURIComponent(cloud)}`;
}

async function inviteForToken(
  ctx: QueryCtx,
  token: string
): Promise<Doc<'sourceAppInvites'> | null> {
  if (!token.startsWith('inv_') || token.length > 64) return null;
  const tokenHash = await hashToken(token);
  const link = await ctx.db
    .query('sourceAppInviteLinks')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
    .unique();
  return link ? await ctx.db.get(link.inviteId) : null;
}

/**
 * What an invite link is for, so the app and pushr.sh can show who invited
 * whom before anyone signs in. Anyone holding the link sees this, which is
 * the same as reading the invite email it came in.
 */
export const previewInvite = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await inviteForToken(ctx, args.token);
    if (!invite) return null;
    const app = await ctx.db.get(invite.sourceAppId);
    if (!app || app.revokedAt) return null;
    const closed = inviteClosedReason(invite);
    return {
      email: invite.email,
      role: invite.role,
      appName: app.name,
      appLogoUrl: app.logoStorageId ? await ctx.storage.getUrl(app.logoStorageId) : null,
      inviterName: invite.invitedByName ?? invite.invitedByEmail ?? 'Someone',
      status: invite.acceptedAt
        ? ('accepted' as const)
        : closed
          ? ('closed' as const)
          : ('pending' as const),
      closedReason: closed
    };
  }
});

/**
 * Accept an invite from its link. The link only ever went to the invited
 * address, so opening it proves the invitee owns that inbox: the account's
 * email counts as confirmed from here, with no separate confirmation step.
 * The account must use the invited email.
 */
export const acceptInviteByToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await requireAuthIdentity(ctx);
    const invite = await inviteForToken(ctx, args.token);
    if (!invite) throw new ConvexError('This invite link is no longer valid');
    const closed = inviteClosedReason(invite);
    if (closed) throw new ConvexError(closed);
    if (!me.email || invite.email !== me.email) {
      throw new ConvexError({
        code: 'WRONG_EMAIL',
        message: `This invite is for ${invite.email}. Sign in with that email to accept it.`,
        email: invite.email
      });
    }
    if (!(await isEmailVerified(ctx, me.userId))) {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'user',
          where: [{ field: '_id', value: me.userId }],
          update: { emailVerified: true, updatedAt: Date.now() }
        }
      });
    }
    return await joinFromInvite(ctx, invite, { userId: me.userId, email: me.email, name: (await ctx.auth.getUserIdentity())?.name ?? null });
  }
});

/** A fresh link for a pending invite, for the owner to send in a message. */
export const shareInviteLink = mutation({
  args: { inviteId: v.id('sourceAppInvites') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new ConvexError('Invite not found');
    const { app } = await requireSourceAppRole(ctx, invite.sourceAppId, userId, 'owner');
    const closed = inviteClosedReason(invite);
    if (closed) throw new ConvexError(closed);
    return { link: await createInviteLink(ctx, invite._id), email: invite.email, appName: app.name };
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
    await deleteInviteLinks(ctx, args.inviteId);
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

/**
 * Tell an invitee. Someone with a confirmed pushr account gets a push on
 * their devices; anyone else gets an email at the invited address, since an
 * unconfirmed account there may not be theirs. Emails share the account-email
 * throttle, so inviting can't be used to flood an inbox.
 */
async function notifyInvitee(
  ctx: MutationCtx,
  args: {
    email: string;
    inviteId: Id<'sourceAppInvites'>;
    app: Doc<'sourceApps'>;
    inviterName: string;
    inviterEmail: string | null;
    role: 'editor' | 'viewer';
    link: string;
  }
): Promise<'pushed' | 'emailed' | 'none'> {
  const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: 'email', value: args.email }]
  });
  if (user?.emailVerified === true) {
    await ctx.scheduler.runAfter(0, internal.expoPush.sendInvite, {
      userId: String(user._id),
      inviteId: args.inviteId,
      sourceAppId: args.app._id,
      inviterName: args.inviterName
    });
    return 'pushed';
  }
  // Without Resend (common on self-hosted servers) the email would only be logged.
  if (!process.env.RESEND_API_KEY) return 'none';
  if (!(await ctx.runMutation(internal.emailThrottle.take, { email: args.email }))) return 'none';
  await ctx.scheduler.runAfter(
    0,
    internal.emails.send,
    inviteEmail(args.email, {
      inviterName: args.inviterName,
      inviterEmail: args.inviterEmail,
      appId: args.app._id,
      appName: args.app.name,
      // The app's own logo leads the email, so it reads as that app's invite.
      appLogoUrl: args.app.logoStorageId ? await ctx.storage.getUrl(args.app.logoStorageId) : null,
      appColor: args.app.logoColor ?? null,
      role: args.role,
      link: args.link
    })
  );
  return 'emailed';
}

/**
 * Whether an invite link lets `email` create an account on a self-hosted
 * server without a connection code. The invite already says the owner wants
 * that person here, and it only works for the address it was sent to.
 */
export const inviteAllowsSignup = internalQuery({
  args: { token: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const invite = await inviteForToken(ctx, args.token);
    if (!invite || inviteClosedReason(invite) || invite.email !== args.email.trim().toLowerCase()) return false;
    // Anyone can share an app, but only the server's owner brings new people onto it.
    return await isServerOwner(ctx, invite.invitedBy);
  }
});

/**
 * People the owner already shares their other apps with, so inviting someone
 * again doesn't mean remembering their email. Most-shared first, and nobody
 * already on (or invited to) this app.
 */
export const suggestInvitees = query({
  args: { sourceAppId: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const me = await requireAuthIdentity(ctx);
    await requireSourceAppRole(ctx, args.sourceAppId, me.userId, 'owner');

    const apps = await ctx.db
      .query('sourceApps')
      .withIndex('by_owner', (q) => q.eq('ownerId', me.userId))
      .take(100);
    const now = Date.now();
    const onThisApp = new Set<string>();
    const people = new Map<
      string,
      { email: string; userId: string | null; apps: string[]; lastAt: number }
    >();

    for (const app of apps) {
      if (app.revokedAt) continue;
      const [members, invites] = await Promise.all([
        ctx.db
          .query('sourceAppMembers')
          .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
          .take(100),
        ctx.db
          .query('sourceAppInvites')
          .withIndex('by_app', (q) => q.eq('sourceAppId', app._id))
          .take(100)
      ]);
      const shared = [
        ...members.flatMap((m) =>
          m.acceptedAt && m.email
            ? [{ email: m.email.toLowerCase(), userId: m.userId, at: m.acceptedAt }]
            : []
        ),
        ...invites
          .filter((i) => !i.acceptedAt && !i.declinedAt && !i.canceledAt && i.expiresAt > now)
          .map((i) => ({ email: i.email, userId: null, at: i.createdAt }))
      ];
      for (const person of shared) {
        if (app._id === args.sourceAppId) {
          onThisApp.add(person.email);
          continue;
        }
        const entry = people.get(person.email) ?? {
          email: person.email,
          userId: null,
          apps: [],
          lastAt: 0
        };
        if (!entry.apps.includes(app.name)) entry.apps.push(app.name);
        entry.userId ??= person.userId;
        entry.lastAt = Math.max(entry.lastAt, person.at);
        people.set(person.email, entry);
      }
    }

    const ranked = [...people.values()]
      .filter((p) => !onThisApp.has(p.email) && p.email !== me.email)
      .sort((a, b) => b.apps.length - a.apps.length || b.lastAt - a.lastAt)
      .slice(0, 8);

    return await Promise.all(
      ranked.map(async (p) => {
        const user = p.userId
          ? await ctx.runQuery(components.betterAuth.adapter.findOne, {
              model: 'user',
              where: [{ field: '_id', value: p.userId }]
            })
          : null;
        return {
          email: p.email,
          name: user?.name || null,
          apps: p.apps.slice(0, 3),
          appCount: p.apps.length
        };
      })
    );
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

