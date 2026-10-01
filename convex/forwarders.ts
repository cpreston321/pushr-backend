import { v, ConvexError } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query
} from './_generated/server';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { requireAuth } from './lib/auth';

/**
 * Outbound forwarders — mirror a source app's pushes into Slack / Discord
 * channels via incoming webhooks. Owner-only management; the actual delivery
 * runs in an internal action (so we can `fetch` external URLs) called from
 * the notification dispatch path right after the device fan-out.
 *
 * A Pro feature on pushr cloud, enforced here when a forwarder is created and
 * again when pushes fan out (so a downgrade stops forwarding). The public
 * self-hosted build strips both checks.
 */

type ForwarderKind = 'slack' | 'discord';
type PriorityFilter = 'all' | 'normal_high' | 'high_only';

const KIND_VALIDATOR = v.union(v.literal('slack'), v.literal('discord'));
const PRIORITY_FILTER_VALIDATOR = v.union(
  v.literal('all'),
  v.literal('normal_high'),
  v.literal('high_only')
);

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Reject URLs that don't match the provider's known hostname. Prevents
 * arbitrary outbound POSTs (data exfil) via a maliciously-crafted forwarder.
 */
function validateUrl(kind: ForwarderKind, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConvexError({ code: 'INVALID_URL', message: 'Webhook URL is not a valid URL.' });
  }
  if (parsed.protocol !== 'https:') {
    throw new ConvexError({ code: 'INVALID_URL', message: 'Webhook URL must use https://' });
  }
  if (kind === 'slack') {
    if (parsed.hostname !== 'hooks.slack.com') {
      throw new ConvexError({
        code: 'INVALID_URL',
        message: 'Slack webhook URL must be on hooks.slack.com'
      });
    }
    if (!parsed.pathname.startsWith('/services/')) {
      throw new ConvexError({
        code: 'INVALID_URL',
        message: 'Slack webhook URL must look like https://hooks.slack.com/services/...'
      });
    }
  } else if (kind === 'discord') {
    const isDiscord =
      parsed.hostname === 'discord.com' ||
      parsed.hostname === 'discordapp.com' ||
      parsed.hostname === 'canary.discord.com' ||
      parsed.hostname === 'ptb.discord.com';
    if (!isDiscord) {
      throw new ConvexError({
        code: 'INVALID_URL',
        message: 'Discord webhook URL must be on discord.com'
      });
    }
    if (!parsed.pathname.startsWith('/api/webhooks/')) {
      throw new ConvexError({
        code: 'INVALID_URL',
        message: 'Discord webhook URL must look like https://discord.com/api/webhooks/...'
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Owner gate
// ---------------------------------------------------------------------------

async function requireOwnerOfApp(
  ctx: { auth: any; db: any },
  sourceAppId: Id<'sourceApps'>
): Promise<string> {
  const userId = await requireAuth(ctx);
  const app = await ctx.db.get(sourceAppId);
  if (!app) throw new ConvexError({ code: 'NOT_FOUND', message: 'Source app not found' });
  if (app.ownerId !== userId) {
    throw new ConvexError({ code: 'FORBIDDEN', message: 'Owner access required' });
  }
  return userId;
}

// ---------------------------------------------------------------------------
// Queries / mutations
// ---------------------------------------------------------------------------

/** List forwarders for a source app. Owner-only — viewers/editors shouldn't
 *  see destination URLs since they could be sensitive. */
export const listForApp = query({
  args: { sourceAppId: v.id('sourceApps') },
  handler: async (ctx, { sourceAppId }) => {
    const userId = await requireAuth(ctx);
    const app = await ctx.db.get(sourceAppId);
    if (!app || app.ownerId !== userId) return [];
    const rows = await ctx.db
      .query('sourceAppForwarders')
      .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', sourceAppId))
      .collect();
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
});

export const create = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    kind: KIND_VALIDATOR,
    url: v.string(),
    label: v.optional(v.string()),
    priorityFilter: v.optional(PRIORITY_FILTER_VALIDATOR)
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerOfApp(ctx, args.sourceAppId);
    validateUrl(args.kind, args.url);
    const id = await ctx.db.insert('sourceAppForwarders', {
      ownerId,
      sourceAppId: args.sourceAppId,
      kind: args.kind,
      url: args.url,
      label: args.label?.trim() || undefined,
      priorityFilter: args.priorityFilter ?? 'all',
      enabled: true,
      createdAt: Date.now()
    });
    return { id };
  }
});

export const update = mutation({
  args: {
    id: v.id('sourceAppForwarders'),
    url: v.optional(v.string()),
    label: v.optional(v.string()),
    priorityFilter: v.optional(PRIORITY_FILTER_VALIDATOR),
    enabled: v.optional(v.boolean())
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.ownerId !== userId) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Forwarder not found' });
    }
    const patch: Partial<typeof row> = {};
    if (args.url !== undefined) {
      validateUrl(row.kind, args.url);
      patch.url = args.url;
      // Clear stale errors when the URL changes — gives the user a clean
      // slate to see if the new URL works.
      patch.lastError = undefined;
    }
    if (args.label !== undefined) patch.label = args.label.trim() || undefined;
    if (args.priorityFilter !== undefined) patch.priorityFilter = args.priorityFilter;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    await ctx.db.patch(args.id, patch);
  }
});

export const remove = mutation({
  args: { id: v.id('sourceAppForwarders') },
  handler: async (ctx, { id }) => {
    const userId = await requireAuth(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.ownerId !== userId) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Forwarder not found' });
    }
    await ctx.db.delete(id);
  }
});

/** Fires a synthetic "test" message immediately so the user can verify the
 *  webhook URL is wired up without sending a real /notify. */
export const test = mutation({
  args: { id: v.id('sourceAppForwarders') },
  handler: async (ctx, { id }) => {
    const userId = await requireAuth(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.ownerId !== userId) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Forwarder not found' });
    }
    await ctx.scheduler.runAfter(0, internal.forwarders.sendTestMessage, { forwarderId: id });
  }
});

// ---------------------------------------------------------------------------
// Internal queries used by the delivery action
// ---------------------------------------------------------------------------

export const _listEnabledForApp = internalQuery({
  args: { sourceAppId: v.id('sourceApps') },
  handler: async (ctx, { sourceAppId }) => {
    return await ctx.db
      .query('sourceAppForwarders')
      .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', sourceAppId))
      .filter((q) => q.eq(q.field('enabled'), true))
      .collect();
  }
});

export const _getForwarder = internalQuery({
  args: { id: v.id('sourceAppForwarders') },
  handler: async (ctx, { id }) => ctx.db.get(id)
});

export const _getNotification = internalQuery({
  args: { id: v.id('notifications') },
  handler: async (ctx, { id }) => ctx.db.get(id)
});

export const _markResult = internalMutation({
  args: {
    id: v.id('sourceAppForwarders'),
    ok: v.boolean(),
    error: v.optional(v.string())
  },
  handler: async (ctx, { id, ok, error }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    if (ok) {
      await ctx.db.patch(id, { lastSentAt: Date.now(), lastError: undefined });
    } else {
      await ctx.db.patch(id, { lastError: error ?? 'Unknown error' });
    }
  }
});

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

type ForwardablePush = {
  title: string;
  body: string;
  priority?: number;
  url?: string;
  appName?: string;
};

function priorityNumeric(p: number | undefined): number {
  return typeof p === 'number' ? p : 5;
}

function passesFilter(filter: PriorityFilter, priority: number | undefined): boolean {
  const p = priorityNumeric(priority);
  if (filter === 'all') return true;
  if (filter === 'normal_high') return p >= 5;
  if (filter === 'high_only') return p >= 7;
  return true;
}

function buildSlackPayload(push: ForwardablePush): Record<string, unknown> {
  const linkSuffix = push.url ? ` <${push.url}|Open>` : '';
  const text = `*${push.title}*\n${push.body}${linkSuffix}`;
  return {
    text: push.title,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text }
      },
      ...(push.appName
        ? [
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: `via *${push.appName}* on pushr` }
              ]
            }
          ]
        : [])
    ]
  };
}

function buildDiscordPayload(push: ForwardablePush): Record<string, unknown> {
  // Priority → color. Discord embed colors are decimal ints.
  const p = priorityNumeric(push.priority);
  const color =
    p >= 8
      ? 0xff3b30 // destructive red
      : p >= 7
        ? 0xff9500 // warning orange
        : p >= 5
          ? 0x278ee8 // accent blue
          : 0x8e8e93; // secondary gray
  return {
    username: 'pushr',
    embeds: [
      {
        title: push.title,
        description: push.body,
        url: push.url,
        color,
        footer: push.appName ? { text: `via ${push.appName}` } : undefined
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Internal action: send to one forwarder
// ---------------------------------------------------------------------------

async function postToForwarder(
  url: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${res.statusText}${text ? ': ' + text.slice(0, 200) : ''}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

/**
 * Fan out a delivered notification to every enabled forwarder on its source
 * app. Called from `dispatchNotification` right after the device push is
 * scheduled. Failures are recorded per-forwarder (`lastError`) but never
 * block device delivery.
 */
export const _getAppName = internalQuery({
  args: { id: v.id('sourceApps') },
  handler: async (ctx, { id }) => {
    const app = await ctx.db.get(id);
    return app ? { name: app.name } : null;
  }
});

export const fanOut = internalAction({
  args: { notificationId: v.id('notifications') },
  handler: async (ctx, { notificationId }) => {
    const notif = await ctx.runQuery(internal.forwarders._getNotification, { id: notificationId });
    if (!notif) return;
    // Live-activity-only pushes shouldn't fan out — they're channel updates,
    // not user-facing notifications.
    if (notif.liveActivity) return;

    const forwarders = await ctx.runQuery(internal.forwarders._listEnabledForApp, {
      sourceAppId: notif.sourceAppId
    });
    if (forwarders.length === 0) return;

    // Source app name for the footer/context blocks; without it the push just
    // renders without the "via" line.
    const app = await ctx.runQuery(internal.forwarders._getAppName, { id: notif.sourceAppId });

    const push: ForwardablePush = {
      title: notif.title,
      body: notif.body,
      priority: notif.priority,
      url: notif.url,
      appName: app?.name
    };

    await Promise.all(
      forwarders.map(async (f) => {
        if (!passesFilter(f.priorityFilter, notif.priority)) return;
        const payload = f.kind === 'slack' ? buildSlackPayload(push) : buildDiscordPayload(push);
        const res = await postToForwarder(f.url, payload);
        await ctx.runMutation(internal.forwarders._markResult, {
          id: f._id,
          ok: res.ok,
          error: res.error
        });
      })
    );
  }
});

export const sendTestMessage = internalAction({
  args: { forwarderId: v.id('sourceAppForwarders') },
  handler: async (ctx, { forwarderId }) => {
    const f = await ctx.runQuery(internal.forwarders._getForwarder, { id: forwarderId });
    if (!f) return;
    const app = await ctx.runQuery(api.sourceApps.getById, { id: f.sourceAppId }).catch(
      () => null
    );
    const push: ForwardablePush = {
      title: 'pushr test message',
      body: 'If you can see this, your webhook is wired up correctly.',
      priority: 5,
      appName: app?.name
    };
    const payload = f.kind === 'slack' ? buildSlackPayload(push) : buildDiscordPayload(push);
    const res = await postToForwarder(f.url, payload);
    await ctx.runMutation(internal.forwarders._markResult, {
      id: forwarderId,
      ok: res.ok,
      error: res.error
    });
  }
});
