import { v, ConvexError } from 'convex/values';
import { requireLogoBlob } from './lib/logoBlob';
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { requireAuth } from './lib/auth';
import type { Doc, Id } from './_generated/dataModel';
import { appLocked, listAccessibleSourceApps, requireSourceAppRole } from './lib/sharing';
import { deleteIncidentUpdates } from './lib/monitorCleanup';

/**
 * Public status pages at status.pushr.sh/<slug>: chosen heartbeats and uptime
 * checks of one source app, their current status, 90 days of uptime, and
 * recent incidents. The public view never includes URLs, error text or a
 * job's output, only what a visitor needs.
 */

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
/** Paths status.pushr.sh needs for itself or sends on to pushr.sh; apps/web/src/lib/statusHost.ts mirrors it. */
export const RESERVED_SLUGS = new Set([
  'about', 'admin', 'api', 'app', 'assets', 'blog', 'changelog', 'connect', 'demo', 'docs', 'help', 'invite', 'login', 'mcp', 'pricing',
  'privacy', 'pushr', 'signup', 'skills', 'status', 'support', 'terms', 'verified', 'www'
]);

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
const MAX_MONITORS = 20;
const SWEEP_BATCH = 500;

const monitorValidator = v.object({
  kind: v.union(v.literal('heartbeat'), v.literal('uptime')),
  id: v.string(),
  label: v.optional(v.string()),
  group: v.optional(v.string())
});

const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DESCRIPTION_MAX = 160;
const ANNOUNCEMENT_MAX = 280;
const GROUP_MAX = 40;

const themeValidator = v.union(v.literal('auto'), v.literal('light'), v.literal('dark'));
const toneValidator = v.union(v.literal('info'), v.literal('maintenance'), v.literal('warning'));

function websiteReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'The website isn’t a valid address.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The website must start with https://.';
  if (url.username || url.password || raw.length > 200) return 'The website isn’t a valid address.';
  return null;
}

async function deleteBlob(ctx: { storage: { delete: (id: Id<'_storage'>) => Promise<void> } }, id: Id<'_storage'> | undefined) {
  if (!id) return;
  try {
    await ctx.storage.delete(id);
  } catch {
    // Already gone.
  }
}

export const listForApp = query({
  args: { sourceAppId: v.id('sourceApps') },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { role } = await requireSourceAppRole(ctx, args.sourceAppId, userId, 'viewer');
    const appIsLocked = await appLocked(ctx, args.sourceAppId);
    const pages = await ctx.db
      .query('statusPages')
      .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', args.sourceAppId))
      .collect();
    return await Promise.all(
      pages.map(async (p) => {
        let locked = false;
        return {
          ...p,
          logoUrl: p.logoStorageId ? await ctx.storage.getUrl(p.logoStorageId) : null,
          canEdit: role === 'owner' && !appIsLocked,
          /** Can't be deleted or switched off. */
          locked
        };
      })
    );
  }
});

/** Whether an address can be used, for the editor to say so as you type. */
export const slugStatus = query({
  args: { slug: v.string(), id: v.optional(v.id('statusPages')) },
  returns: v.union(v.literal('available'), v.literal('taken'), v.literal('invalid')),
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    const slug = args.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return 'invalid';
    if (RESERVED_SLUGS.has(slug)) return 'taken';
    const page = await ctx.db
      .query('statusPages')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    return page && page._id !== args.id ? 'taken' : 'available';
  }
});

export const save = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    id: v.optional(v.id('statusPages')),
    slug: v.string(),
    title: v.string(),
    enabled: v.boolean(),
    monitors: v.array(monitorValidator),
    /** Left out keeps the current setting. */
    autoAddMonitors: v.optional(v.boolean()),
    /** Left out keeps the current logo; null removes it, back to the app's. */
    logoStorageId: v.optional(v.union(v.id('_storage'), v.null())),
    accent: v.optional(v.string()),
    theme: v.optional(themeValidator),
    websiteUrl: v.optional(v.string()),
    description: v.optional(v.string()),
    announcement: v.optional(v.object({ text: v.string(), tone: toneValidator }))
  },
  returns: v.id('statusPages'),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.sourceAppId, userId, 'owner');
    const slug = args.slug.trim().toLowerCase();
    const title = args.title.trim();
    if (!SLUG_PATTERN.test(slug)) {
      throw new ConvexError('The address is 3 to 40 lowercase letters, digits or dashes, not starting or ending with a dash.');
    }
    if (RESERVED_SLUGS.has(slug)) throw new ConvexError('That address is taken.');
    if (!title || title.length > 80) throw new ConvexError('The title is 1 to 80 characters.');
    if (args.monitors.length > MAX_MONITORS) throw new ConvexError(`A status page shows at most ${MAX_MONITORS} monitors.`);
    const kept: typeof args.monitors = [];
    for (const m of args.monitors) {
      const row = await getMonitor(ctx, m.kind, m.id);
      // One deleted since the editor loaded just drops off the page.
      if (!row) continue;
      if (row.sourceAppId !== app._id) throw new ConvexError('A status page can only show this app’s monitors.');
      kept.push(m);
      if (m.label !== undefined && m.label.length > 60) throw new ConvexError('A label is at most 60 characters.');
      if (m.group !== undefined && m.group.length > GROUP_MAX) throw new ConvexError(`A group name is at most ${GROUP_MAX} characters.`);
    }
    const accent = args.accent?.trim() || undefined;
    if (accent && !ACCENT_PATTERN.test(accent)) throw new ConvexError('The color must be a hex value like #3E7BFA.');
    const websiteUrl = args.websiteUrl?.trim() || undefined;
    const badWebsite = websiteUrl && websiteReason(websiteUrl);
    if (badWebsite) throw new ConvexError(badWebsite);
    const description = args.description?.trim() || undefined;
    if (description && description.length > DESCRIPTION_MAX) {
      throw new ConvexError(`The description is at most ${DESCRIPTION_MAX} characters.`);
    }
    const announcementText = args.announcement?.text.trim();
    if (announcementText && announcementText.length > ANNOUNCEMENT_MAX) {
      throw new ConvexError(`The announcement is at most ${ANNOUNCEMENT_MAX} characters.`);
    }
    const taken = await ctx.db
      .query('statusPages')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (taken && taken._id !== args.id) throw new ConvexError('That address is taken.');

    const existing = args.id ? await ctx.db.get(args.id) : null;
    if (args.id && (!existing || existing.sourceAppId !== app._id)) throw new ConvexError('Status page not found');
    // Fixed once made: links, embeds and bookmarks to the old address would break.
    if (existing && existing.slug !== slug) throw new ConvexError('A status page’s address can’t be changed.');
    if (args.logoStorageId && existing?.logoStorageId !== args.logoStorageId) {
      await requireLogoBlob(ctx, args.logoStorageId);
    }
    const announcement =
      announcementText && args.announcement
        ? {
            text: announcementText,
            tone: args.announcement.tone,
            // Kept while it's unchanged, so "Posted 2h ago" stays true.
            updatedAt:
              existing?.announcement?.text === announcementText && existing.announcement.tone === args.announcement.tone
                ? existing.announcement.updatedAt
                : Date.now()
          }
        : undefined;
    const fields = {
      slug,
      title,
      enabled: args.enabled,
      monitors: kept.map((m) => ({ ...m, label: m.label?.trim() || undefined, group: m.group?.trim() || undefined })),
      ...(args.autoAddMonitors !== undefined ? { autoAddMonitors: args.autoAddMonitors } : {}),
      accent,
      theme: args.theme,
      websiteUrl,
      description,
      announcement,
      ...(args.logoStorageId !== undefined ? { logoStorageId: args.logoStorageId ?? undefined, logoShape: undefined } : {})
    };
    if (existing) {
      if (args.logoStorageId !== undefined && existing.logoStorageId !== args.logoStorageId) {
        await deleteBlob(ctx, existing.logoStorageId);
      }
      await ctx.db.patch(existing._id, fields);
      if (args.logoStorageId && existing.logoStorageId !== args.logoStorageId) {
        await ctx.scheduler.runAfter(0, internal.logoColor.extractPageLogo, { id: existing._id, storageId: args.logoStorageId });
      }
      return existing._id;
    }
    const id = await ctx.db.insert('statusPages', { ownerId: app.ownerId, sourceAppId: app._id, ...fields, createdAt: Date.now() });
    if (args.logoStorageId) {
      await ctx.scheduler.runAfter(0, internal.logoColor.extractPageLogo, { id, storageId: args.logoStorageId });
    }
    return id;
  }
});

/**
 * Every status page you can see, with how its monitors are doing, for the
 * Apps tab to list next to them.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const accessible = await listAccessibleSourceApps(ctx, userId);
    const out = [];
    for (const { app, role } of accessible) {
      const appIsLocked = await appLocked(ctx, app._id);
      const pages = await ctx.db
        .query('statusPages')
        .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', app._id))
        .collect();
      for (const p of pages) {
        let locked = false;
        let down = 0;
        let shown = 0;
        for (const m of p.monitors) {
          const row = await getMonitor(ctx, m.kind, m.id);
          if (!row || row.sourceAppId !== app._id) continue;
          shown++;
          if (row.status === 'down') down++;
        }
        out.push({
          _id: p._id,
          sourceAppId: app._id,
          sourceAppName: app.name,
          slug: p.slug,
          title: p.title,
          enabled: p.enabled,
          monitorCount: shown,
          overall: down === 0 ? ('operational' as const) : down === shown ? ('outage' as const) : ('degraded' as const),
          canEdit: role === 'owner' && !appIsLocked,
          /** Can't be deleted or switched off. */
          locked,
          onHold: !(await pageAllowed(ctx, app.ownerId))
        });
      }
    }
    return out;
  }
});

/** Whether an owner's pages are online: always self-hosted, on Pro in pushr cloud. */
async function pageAllowed(ctx: QueryCtx, ownerId: string): Promise<boolean> {
  let allowed = true;
  void ctx;
  void ownerId;
  return allowed;
}

/**
 * One tap to a ready page: every monitor of the app, titled after it, at an
 * address made from its name, branded with its logo and color.
 */
export const createDefault = mutation({
  args: { sourceAppId: v.id('sourceApps') },
  returns: v.object({ id: v.id('statusPages'), slug: v.string() }),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, args.sourceAppId, userId, 'owner');
    const monitors: { kind: 'heartbeat' | 'uptime'; id: string }[] = [];
    const checks = await ctx.db
      .query('uptimeChecks')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id))
      .take(MAX_MONITORS);
    for (const c of checks) monitors.push({ kind: 'uptime', id: c._id });
    const beats = await ctx.db
      .query('heartbeats')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id))
      .take(MAX_MONITORS);
    for (const h of beats) monitors.push({ kind: 'heartbeat', id: h._id });

    const slug = await freeSlug(ctx, app.name);
    const id = await ctx.db.insert('statusPages', {
      ownerId: app.ownerId,
      sourceAppId: app._id,
      slug,
      title: `${app.name} status`.slice(0, 80),
      enabled: true,
      monitors: monitors.slice(0, MAX_MONITORS),
      autoAddMonitors: true,
      createdAt: Date.now()
    });
    return { id, slug };
  }
});

/** An unused address from a name: "Acme API" → acme-api, then acme-api-2… */
async function freeSlug(ctx: QueryCtx, name: string): Promise<string> {
  let base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
    .replace(/-+$/, '');
  if (base.length < 3) base = `${base || 'my'}-status`.replace(/^-/, '');
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!SLUG_PATTERN.test(slug) || RESERVED_SLUGS.has(slug)) continue;
    const taken = await ctx.db
      .query('statusPages')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (!taken) return slug;
  }
  return `status-${Date.now().toString(36)}`;
}

/** A new heartbeat or uptime check joins the app's pages that take new monitors. */
export async function addToAutoPages(
  ctx: MutationCtx,
  sourceAppId: Id<'sourceApps'>,
  monitor: { kind: 'heartbeat' | 'uptime'; id: string }
): Promise<void> {
  const pages = await ctx.db
    .query('statusPages')
    .withIndex('by_sourceApp', (q) => q.eq('sourceAppId', sourceAppId))
    .collect();
  for (const p of pages) {
    if (!p.autoAddMonitors || p.monitors.length >= MAX_MONITORS) continue;
    if (p.monitors.some((m) => m.kind === monitor.kind && m.id === monitor.id)) continue;
    await ctx.db.patch(p._id, { monitors: [...p.monitors, monitor] });
  }
}

export const deleteOne = mutation({
  args: { id: v.id('statusPages') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const page = await ctx.db.get(args.id);
    if (!page) return null;
    await requireSourceAppRole(ctx, page.sourceAppId, userId, 'owner');
    await deleteBlob(ctx, page.logoStorageId);
    await ctx.db.delete(page._id);
    return null;
  }
});


async function getMonitor(ctx: QueryCtx, kind: 'heartbeat' | 'uptime', id: string) {
  if (kind === 'heartbeat') {
    const hid = ctx.db.normalizeId('heartbeats', id);
    return hid ? await ctx.db.get(hid) : null;
  }
  const uid = ctx.db.normalizeId('uptimeChecks', id);
  return uid ? await ctx.db.get(uid) : null;
}

type PublicStatus = 'up' | 'down' | 'paused' | 'pending';

/** The JSON behind status.pushr.sh/<slug>. Null for an unknown or disabled page. */
export const publicView = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('statusPages')
      .withIndex('by_slug', (q) => q.eq('slug', args.slug.toLowerCase()))
      .unique();
    if (!page || !page.enabled) return null;
    const app = await ctx.db.get(page.sourceAppId);
    if (!app || app.revokedAt) return null;

    const now = Date.now();
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const windowStart = today - (WINDOW_DAYS - 1) * DAY_MS;
    const outages: Outage[] = [];
    const monitors = [];

    for (const m of page.monitors) {
      const row = await getMonitor(ctx, m.kind, m.id);
      if (!row || row.sourceAppId !== app._id) continue;
      const label = m.label || row.label || row.name;
      const rows = await incidentsSince(ctx, m.kind, m.id, windowStart);
      const since = Math.max(windowStart, Math.floor(row.createdAt / DAY_MS) * DAY_MS);
      const days: { date: string; downMs: number }[] = [];
      let downTotal = 0;
      for (let d = windowStart; d <= today; d += DAY_MS) {
        const end = Math.min(d + DAY_MS, now);
        let down = 0;
        for (const i of rows) {
          const s = Math.max(i.startedAt, d);
          const e = Math.min(i.endedAt ?? now, end);
          if (e > s) down += e - s;
        }
        if (d >= since) downTotal += down;
        days.push({ date: new Date(d).toISOString().slice(0, 10), downMs: d >= since ? down : -1 });
      }
      const observed = now - Math.max(since, row.createdAt);
      for (const i of rows) outages.push({ label, kind: m.kind, row: i });
      const status: PublicStatus = row.status;
      monitors.push({
        label,
        group: m.group ?? null,
        // The outages themselves, so the page can draw days in the visitor's
        // zone; `days` is the same thing cut at UTC midnight.
        since: row.createdAt,
        downtime: rows.map((i) => [i.startedAt, i.endedAt ?? null] as [number, number | null]),
        kind: m.kind,
        status,
        downSince: row.downSince ?? null,
        uptime: observed > 0 ? Math.max(0, 1 - downTotal / observed) : null,
        days
      });
    }

    const down = monitors.filter((m) => m.status === 'down').length;
    const logoId = page.logoStorageId ?? app.logoStorageId;
    return {
      title: page.title,
      description: page.description ?? null,
      // The page's own branding, else the source app's.
      logoUrl: logoId ? await ctx.storage.getUrl(logoId) : null,
      logoShape: (page.logoStorageId ? page.logoShape : app.logoShape) ?? 'square',
      accent: page.accent ?? app.logoColor ?? null,
      theme: page.theme ?? 'auto',
      websiteUrl: page.websiteUrl ?? null,
      announcement: page.announcement ?? null,
      overall: down === 0 ? 'operational' : down === monitors.length ? 'outage' : 'degraded',
      updatedAt: now,
      monitors,
      incidents: await publicIncidents(ctx, app._id, outages, windowStart)
    };
  }
});

type Outage = { label: string; kind: 'heartbeat' | 'uptime'; row: Doc<'monitorIncidents'> };
/** Outages this close together are one incident: one cause usually takes down several monitors a check apart. */
const MERGE_GAP_MS = 2 * 60_000;
const INCIDENTS_SHOWN = 50;

/**
 * A page's outages as visitors read them: ones that overlap across its
 * monitors merged into one incident, each with what the checks saw and the
 * updates written for it, newest first. `monitor` and `reason` are the first
 * outage's, for readers of the older shape.
 */
async function publicIncidents(ctx: QueryCtx, sourceAppId: Id<'sourceApps'>, outages: Outage[], from: number) {
  const updates = await ctx.db
    .query('incidentUpdates')
    .withIndex('by_sourceApp_and_at', (q) => q.eq('sourceAppId', sourceAppId).gte('at', from))
    .take(500);
  const groups: Outage[][] = [];
  let end = -Infinity;
  for (const o of [...outages].sort((a, b) => a.row.startedAt - b.row.startedAt)) {
    const last = groups[groups.length - 1];
    if (last && o.row.startedAt <= end + MERGE_GAP_MS) {
      last.push(o);
      end = Math.max(end, o.row.endedAt ?? Infinity);
    } else {
      groups.push([o]);
      end = o.row.endedAt ?? Infinity;
    }
  }
  return groups
    .slice(-INCIDENTS_SHOWN)
    .reverse()
    .map((g) => {
      const ids = new Set(g.map((o) => o.row._id as string));
      const written = updates.filter((u) => ids.has(u.incidentId)).sort((a, b) => a.at - b.at);
      const ongoing = g.some((o) => o.row.endedAt === undefined);
      const labels = [...new Set(g.map((o) => o.label))];
      return {
        title: g.find((o) => o.row.title)?.row.title ?? null,
        startedAt: g[0].row.startedAt,
        endedAt: ongoing ? null : Math.max(...g.map((o) => o.row.endedAt!)),
        status: written.length ? written[written.length - 1].status : null,
        monitors: g.map((o) => ({
          label: o.label,
          reason: publicReason(o.kind, o.row.reason),
          startedAt: o.row.startedAt,
          endedAt: o.row.endedAt ?? null,
          firstFailedAt: o.row.firstFailedAt ?? null,
          statusCode: o.row.statusCode ?? null,
          latencyMs: o.row.latencyMs ?? null,
          recoveredStatusCode: o.row.recoveredStatusCode ?? null,
          recoveredLatencyMs: o.row.recoveredLatencyMs ?? null
        })),
        updates: written.map((u) => ({ status: u.status, body: u.body, at: u.at })),
        monitor: labels.length > 2 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels.join(' and '),
        reason: publicReason(g[0].kind, g[0].row.reason)
      };
    });
}

async function incidentsSince(ctx: QueryCtx, kind: 'heartbeat' | 'uptime', id: string, from: number) {
  const inWindow = await ctx.db
    .query('monitorIncidents')
    .withIndex('by_monitor_and_startedAt', (q) => q.eq('monitorKind', kind).eq('monitorId', id).gte('startedAt', from))
    .take(500);
  // One that began before the window may still overlap it.
  const before = await ctx.db
    .query('monitorIncidents')
    .withIndex('by_monitor_and_startedAt', (q) => q.eq('monitorKind', kind).eq('monitorId', id).lt('startedAt', from))
    .order('desc')
    .first();
  return before && (before.endedAt ?? Infinity) > from ? [before, ...inWindow] : inWindow;
}

/** Visitors see what kind of outage it was, never error text or job output. */
function publicReason(kind: 'heartbeat' | 'uptime', raw: string): string {
  if (kind === 'heartbeat') return raw === 'Missed its check-in' ? 'Missed its check-in' : 'Failed';
  const http = raw.match(/^HTTP (\d{3})$/);
  if (http) return `HTTP ${http[1]}`;
  if (raw.startsWith('No response in')) return 'Timed out';
  return 'Not responding';
}

export const setLogoShapeInternal = internalMutation({
  args: {
    id: v.id('statusPages'),
    storageId: v.id('_storage'),
    shape: v.union(v.literal('circle'), v.literal('free'), v.literal('square'), v.null())
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.id);
    // A newer logo since this one was read wins.
    if (!page || page.logoStorageId !== args.storageId) return null;
    await ctx.db.patch(page._id, { logoShape: args.shape ?? undefined });
    return null;
  }
});

export const sweepIncidents = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - (WINDOW_DAYS + 10) * DAY_MS;
    const old = await ctx.db
      .query('monitorIncidents')
      .withIndex('by_startedAt', (q) => q.lt('startedAt', cutoff))
      .take(SWEEP_BATCH);
    let deleted = 0;
    for (const i of old) {
      if (i.endedAt === undefined || i.endedAt > cutoff) continue;
      await deleteIncidentUpdates(ctx, i._id);
      await ctx.db.delete(i._id);
      deleted++;
    }
    if (deleted === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.statusPages.sweepIncidents, {});
    return null;
  }
});

