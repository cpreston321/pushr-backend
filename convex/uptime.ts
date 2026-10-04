import { v, ConvexError } from 'convex/values';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { appForToken } from './lib/appToken';
import { requireAuth } from './lib/auth';
import { appLocked, listAccessibleSourceApps, requireSourceAppRole } from './lib/sharing';
import { hostToResolve, unsafeMonitorUrlReason } from './lib/safeUrl';
import { closeIncident, formatDuration, monitorAlert, openIncident, recentOutages, type MonitorRef } from './lib/monitors';
import { NAME_PATTERN } from './heartbeats';
import { addToAutoPages } from './statusPages';
import { deleteIncidents } from './lib/monitorCleanup';

/**
 * Uptime checks: pushr fetches a URL on a schedule and alerts when it stops
 * answering, after `confirmAfter` failures in a row, then again when it
 * recovers. Alerts share heartbeats' path, so on-call, critical alerts,
 * replace keys and status pages all apply.
 */

export const INTERVAL_MAX_SEC = 3_600;
const TIMEOUT_DEFAULT_SEC = 10;
const TIMEOUT_MAX_SEC = 30;
const CONFIRM_DEFAULT = 2;
const KEYWORD_MAX = 200;
/** How much of a body a keyword is looked for in. */
const BODY_MAX_CHARS = 512_000;
const DISPATCH_BATCH = 200;
/** Due checks start spread over this window instead of all on the minute. */
const SPREAD_MS = 40_000;

const methodValidator = v.union(v.literal('GET'), v.literal('HEAD'));

type Config = {
  url: string;
  method?: 'GET' | 'HEAD';
  intervalSec: number;
  timeoutSec?: number;
  keyword?: string;
  confirmAfter?: number;
};

async function limitsFor(ctx: MutationCtx, ownerId: string) {
  let checks = 50;
  let minInterval = 60;
  return { checks, minInterval };
}

async function validate(ctx: MutationCtx, app: Doc<'sourceApps'>, name: string, c: Config) {
  if (!NAME_PATTERN.test(name)) {
    throw new ConvexError({ code: 'INVALID', message: 'name is up to 64 letters, digits, dots, dashes or underscores' });
  }
  const unsafe = unsafeMonitorUrlReason(c.url);
  if (unsafe) throw new ConvexError({ code: 'INVALID', message: unsafe });
  const { minInterval } = await limitsFor(ctx, app.ownerId);
  if (!Number.isFinite(c.intervalSec) || c.intervalSec < minInterval || c.intervalSec > INTERVAL_MAX_SEC) {
    let code = 'INVALID';
    let message = 'Check every 1 to 60 minutes.';
    throw new ConvexError({ code, message });
  }
  if (c.timeoutSec !== undefined && (c.timeoutSec < 1 || c.timeoutSec > TIMEOUT_MAX_SEC)) {
    throw new ConvexError({ code: 'INVALID', message: `timeout is 1 to ${TIMEOUT_MAX_SEC} seconds` });
  }
  if (c.keyword !== undefined && (c.keyword.length === 0 || c.keyword.length > KEYWORD_MAX)) {
    throw new ConvexError({ code: 'INVALID', message: `keyword is 1 to ${KEYWORD_MAX} characters` });
  }
  if (c.keyword !== undefined && c.method === 'HEAD') {
    throw new ConvexError({ code: 'INVALID', message: 'A HEAD check has no body to find a keyword in' });
  }
  if (c.confirmAfter !== undefined && (!Number.isInteger(c.confirmAfter) || c.confirmAfter < 1 || c.confirmAfter > 5)) {
    throw new ConvexError({ code: 'INVALID', message: 'confirmAfter is 1 to 5 failed checks' });
  }
}

async function upsert(ctx: MutationCtx, app: Doc<'sourceApps'>, name: string, c: Config): Promise<Doc<'uptimeChecks'>> {
  await validate(ctx, app, name, c);
  const fields = {
    url: c.url,
    method: c.method ?? 'GET',
    intervalSec: Math.round(c.intervalSec),
    timeoutSec: c.timeoutSec ?? TIMEOUT_DEFAULT_SEC,
    keyword: c.keyword,
    confirmAfter: c.confirmAfter ?? CONFIRM_DEFAULT
  };
  const existing = await ctx.db
    .query('uptimeChecks')
    .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id).eq('name', name))
    .unique();
  if (existing) {
    // A changed target starts over: its old failures say nothing about the new one.
    const retarget = existing.url !== fields.url || existing.method !== fields.method || existing.keyword !== fields.keyword;
    await ctx.db.patch(existing._id, {
      ...fields,
      ...(retarget && existing.status !== 'paused' ? { failures: 0, failingSince: undefined, dueAt: Date.now() } : {})
    });
    return (await ctx.db.get(existing._id))!;
  }
  const { checks } = await limitsFor(ctx, app.ownerId);
  const owned = await countForOwner(ctx, app.ownerId, checks);
  if (owned >= checks) {
    let code = 'UPTIME_LIMIT';
    let message = `You can have at most ${checks} uptime checks.`;
    throw new ConvexError({ code, message });
  }
  const id = await ctx.db.insert('uptimeChecks', {
    ownerId: app.ownerId,
    sourceAppId: app._id,
    name,
    ...fields,
    status: 'pending',
    dueAt: Date.now(),
    failures: 0,
    createdAt: Date.now()
  });
  await addToAutoPages(ctx, app._id, { kind: 'uptime', id });
  return (await ctx.db.get(id))!;
}

/**
 * After a downgrade an owner can have more checks, or faster ones, than the
 * plan includes. Nothing is deleted: the oldest checks within the allowance
 * keep running at no faster than the plan's interval, and the rest are on
 * hold until an upgrade, when they resume by themselves.
 */
export async function uptimeAllowance(
  ctx: QueryCtx | MutationCtx,
  ownerId: string
): Promise<{ held: Set<string>; minIntervalSec: number }> {
  let limit = Number.POSITIVE_INFINITY;
  let minIntervalSec = 60;
  const held = new Set<string>();
  if (!Number.isFinite(limit)) return { held, minIntervalSec };
  const apps = await ctx.db
    .query('sourceApps')
    .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
    .collect();
  const checks: Doc<'uptimeChecks'>[] = [];
  for (const a of apps) {
    if (a.revokedAt) continue;
    checks.push(
      ...(await ctx.db
        .query('uptimeChecks')
        .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', a._id))
        .take(100))
    );
  }
  checks.sort((a, b) => a.createdAt - b.createdAt);
  for (const c of checks.slice(limit)) held.add(c._id);
  return { held, minIntervalSec };
}

async function countForOwner(ctx: MutationCtx, ownerId: string, upTo: number): Promise<number> {
  const apps = await ctx.db
    .query('sourceApps')
    .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
    .collect();
  let n = 0;
  for (const a of apps) {
    if (a.revokedAt) continue;
    n += (
      await ctx.db
        .query('uptimeChecks')
        .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', a._id))
        .take(upTo + 1)
    ).length;
    if (n > upTo) break;
  }
  return n;
}

function publicCheck(c: Doc<'uptimeChecks'>) {
  return {
    name: c.name,
    url: c.url,
    method: c.method,
    intervalSec: c.intervalSec,
    timeoutSec: c.timeoutSec,
    keyword: c.keyword ?? null,
    confirmAfter: c.confirmAfter,
    status: c.status,
    lastCheckedAt: c.lastCheckedAt ?? null,
    lastStatusCode: c.lastStatusCode ?? null,
    lastLatencyMs: c.lastLatencyMs ?? null,
    lastError: c.lastError ?? null,
    downSince: c.downSince ?? null
  };
}

const publicCheckValidator = v.object({
  name: v.string(),
  url: v.string(),
  method: methodValidator,
  intervalSec: v.number(),
  timeoutSec: v.number(),
  keyword: v.union(v.string(), v.null()),
  confirmAfter: v.number(),
  status: v.union(v.literal('pending'), v.literal('up'), v.literal('down'), v.literal('paused')),
  lastCheckedAt: v.union(v.number(), v.null()),
  lastStatusCode: v.union(v.number(), v.null()),
  lastLatencyMs: v.union(v.number(), v.null()),
  lastError: v.union(v.string(), v.null()),
  downSince: v.union(v.number(), v.null())
});

// ---------------------------------------------------------------------------
// HTTP API: PUT, GET and DELETE /uptime/<name>, as the token's source app.
// ---------------------------------------------------------------------------

export const putByToken = internalMutation({
  args: {
    token: v.string(),
    name: v.string(),
    url: v.string(),
    method: v.optional(methodValidator),
    intervalSec: v.number(),
    timeoutSec: v.optional(v.number()),
    keyword: v.optional(v.string()),
    confirmAfter: v.optional(v.number())
  },
  returns: publicCheckValidator,
  handler: async (ctx, { token, name, ...config }) => {
    const app = await appForToken(ctx, token);
    return publicCheck(await upsert(ctx, app, name, config));
  }
});

export const getByToken = internalQuery({
  args: { token: v.string(), name: v.string() },
  returns: v.union(publicCheckValidator, v.null()),
  handler: async (ctx, args) => {
    const app = await appForToken(ctx, args.token);
    const c = await ctx.db
      .query('uptimeChecks')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id).eq('name', args.name))
      .unique();
    return c ? publicCheck(c) : null;
  }
});

export const deleteByToken = internalMutation({
  args: { token: v.string(), name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const app = await appForToken(ctx, args.token);
    const c = await ctx.db
      .query('uptimeChecks')
      .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id).eq('name', args.name))
      .unique();
    if (!c) return false;
    await deleteIncidents(ctx, 'uptime', c._id);
    await ctx.db.delete(c._id);
    return true;
  }
});

// ---------------------------------------------------------------------------
// The app.
// ---------------------------------------------------------------------------

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const accessible = await listAccessibleSourceApps(ctx, userId);
    const out: Array<
      Doc<'uptimeChecks'> & { sourceAppName: string; canEdit: boolean; onHold: boolean; outages: { startedAt: number; endedAt: number | null }[] }
    > = [];
    const allowances = new Map<string, Awaited<ReturnType<typeof uptimeAllowance>>>();
    for (const { app, role } of accessible) {
      const rows = await ctx.db
        .query('uptimeChecks')
        .withIndex('by_sourceApp_and_name', (q) => q.eq('sourceAppId', app._id))
        .take(100);
      if (rows.length === 0) continue;
      let allowance = allowances.get(app.ownerId);
      if (!allowance) {
        allowance = await uptimeAllowance(ctx, app.ownerId);
        allowances.set(app.ownerId, allowance);
      }
      const locked = await appLocked(ctx, app._id);
      for (const c of rows) {
        out.push({
          ...c,
          sourceAppName: app.name,
          canEdit: role !== 'viewer' && !locked,
          onHold: allowance.held.has(c._id),
          outages: await recentOutages(ctx, 'uptime', c._id)
        });
      }
    }
    return out;
  }
});

export const save = mutation({
  args: {
    sourceAppId: v.id('sourceApps'),
    name: v.string(),
    url: v.string(),
    method: v.optional(methodValidator),
    intervalSec: v.number(),
    keyword: v.optional(v.string()),
    confirmAfter: v.optional(v.number())
  },
  returns: v.id('uptimeChecks'),
  handler: async (ctx, { sourceAppId, name, ...config }) => {
    const userId = await requireAuth(ctx);
    const { app } = await requireSourceAppRole(ctx, sourceAppId, userId, 'editor');
    return (await upsert(ctx, app, name.trim(), { ...config, url: config.url.trim(), keyword: config.keyword?.trim() || undefined }))._id;
  }
});

async function editable(ctx: MutationCtx, id: Id<'uptimeChecks'>) {
  const userId = await requireAuth(ctx);
  const c = await ctx.db.get(id);
  if (!c) throw new ConvexError('Uptime check not found');
  await requireSourceAppRole(ctx, c.sourceAppId, userId, 'editor');
  return c;
}

export const setPaused = mutation({
  args: { id: v.id('uptimeChecks'), paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await editable(ctx, args.id);
    if (args.paused) {
      if (c.status === 'down') await closeIncident(ctx, ref(c));
      await ctx.db.patch(c._id, { status: 'paused', dueAt: undefined, failures: 0, failingSince: undefined, downSince: undefined });
    } else if (c.status === 'paused') {
      await ctx.db.patch(c._id, { status: 'pending', dueAt: Date.now() });
    }
    return null;
  }
});

export const checkNow = mutation({
  args: { id: v.id('uptimeChecks') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await editable(ctx, args.id);
    if (c.status === 'paused') throw new ConvexError('Resume it first.');
    await ctx.db.patch(c._id, { dueAt: c.intervalSec * 1000 + Date.now() });
    await ctx.scheduler.runAfter(0, internal.uptime.runCheck, { id: c._id });
    return null;
  }
});

export const deleteOne = mutation({
  args: { id: v.id('uptimeChecks') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await editable(ctx, args.id);
    await deleteIncidents(ctx, 'uptime', c._id);
    await ctx.db.delete(c._id);
    return null;
  }
});

// ---------------------------------------------------------------------------
// Running checks.
// ---------------------------------------------------------------------------

/** Minute cron: claim every due check by moving it on a window, then run it. */
export const dispatchDue = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('uptimeChecks')
      .withIndex('by_dueAt', (q) => q.gte('dueAt', 0).lte('dueAt', now))
      .take(DISPATCH_BATCH);
    const allowances = new Map<string, Awaited<ReturnType<typeof uptimeAllowance>>>();
    for (const [i, c] of due.entries()) {
      let allowance = allowances.get(c.ownerId);
      if (!allowance) {
        allowance = await uptimeAllowance(ctx, c.ownerId);
        allowances.set(c.ownerId, allowance);
      }
      const interval = Math.max(c.intervalSec, allowance.minIntervalSec);
      // From the time it was due, so a check doesn't drift later each round.
      const next = Math.max(c.dueAt! + interval * 1000, now + 30_000);
      await ctx.db.patch(c._id, { dueAt: next });
      // On hold: its turn passes without a request, and it picks up again
      // once the plan allows it.
      if (allowance.held.has(c._id)) continue;
      await ctx.scheduler.runAfter(Math.floor((i / Math.max(due.length, 1)) * SPREAD_MS), internal.uptime.runCheck, { id: c._id });
    }
    if (due.length === DISPATCH_BATCH) await ctx.scheduler.runAfter(0, internal.uptime.dispatchDue, {});
    return null;
  }
});

/**
 * Try a URL as a check would, before saving it, so the form can say whether
 * it answers. Same guards as a real check: public hosts only, no redirects.
 */
export const testUrl = action({
  args: { url: v.string(), method: v.optional(methodValidator), keyword: v.optional(v.string()) },
  returns: v.object({
    ok: v.boolean(),
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    error: v.optional(v.string())
  }),
  handler: async (ctx, args) => {
    if (!(await ctx.auth.getUserIdentity())) throw new ConvexError('Unauthenticated');
    const unsafe = unsafeMonitorUrlReason(args.url);
    if (unsafe) return { ok: false, error: unsafe.replace(/^url /, 'The address ') };
    return await probe(ctx, { url: args.url, method: args.method ?? 'GET', timeoutSec: TIMEOUT_DEFAULT_SEC, keyword: args.keyword || undefined });
  }
});

export const getForRun = internalQuery({
  args: { id: v.id('uptimeChecks') },
  handler: async (ctx, args) => ctx.db.get(args.id)
});

export const runCheck = internalAction({
  args: { id: v.id('uptimeChecks') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await ctx.runQuery(internal.uptime.getForRun, { id: args.id });
    if (!c || c.status === 'paused') return null;
    const result = await probe(ctx, c);
    await ctx.runMutation(internal.uptime.recordResult, { id: c._id, url: c.url, ...result });
    return null;
  }
});

type Probe = { ok: boolean; statusCode?: number; latencyMs?: number; error?: string };

export async function probe(
  ctx: ActionCtx,
  c: Pick<Doc<'uptimeChecks'>, 'url' | 'method' | 'timeoutSec' | 'keyword'>
): Promise<Probe> {
  // Re-checked here as well as on save: the rule may have tightened since.
  const unsafe = unsafeMonitorUrlReason(c.url);
  if (unsafe) return { ok: false, error: unsafe.replace(/^url /, 'The address ') };
  const host = hostToResolve(c.url);
  const resolved = host ? await ctx.runAction(internal.resolveHost.privateReason, { host }) : null;
  if (resolved === 'private') return { ok: false, error: 'The address must be a public host' };
  if (resolved === 'unresolved') return { ok: false, error: `Couldn't find ${host}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutSec * 1000);
  const started = Date.now();
  try {
    const res = await fetch(c.url, {
      method: c.method,
      // Following a redirect could land on an internal address the URL check never saw.
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'pushr-uptime/1 (+https://pushr.sh/docs#uptime-checks)' }
    });
    const latencyMs = Date.now() - started;
    const statusCode = res.status;
    if (statusCode >= 400 || statusCode === 0) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, statusCode, latencyMs, error: `HTTP ${statusCode}` };
    }
    if (c.keyword) {
      const body = (await res.text()).slice(0, BODY_MAX_CHARS);
      if (!body.includes(c.keyword)) return { ok: false, statusCode, latencyMs, error: `"${c.keyword}" not found in the response` };
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return { ok: true, statusCode, latencyMs };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: aborted ? `No response in ${c.timeoutSec}s` : (err instanceof Error ? err.message : String(err)).slice(0, 200)
    };
  } finally {
    clearTimeout(timer);
  }
}

export const recordResult = internalMutation({
  args: {
    id: v.id('uptimeChecks'),
    /** The URL that was checked; a result for a target since changed is dropped. */
    url: v.string(),
    ok: v.boolean(),
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    error: v.optional(v.string())
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.id);
    if (!c || c.status === 'paused' || c.url !== args.url) return null;
    const app = await ctx.db.get(c.sourceAppId);
    if (!app || app.revokedAt) {
      await deleteIncidents(ctx, 'uptime', c._id);
    await ctx.db.delete(c._id);
      return null;
    }
    const now = Date.now();
    const seen = {
      lastCheckedAt: now,
      lastStatusCode: args.statusCode,
      lastLatencyMs: args.latencyMs,
      lastError: args.ok ? undefined : args.error
    };

    if (args.ok) {
      await ctx.db.patch(c._id, { ...seen, status: 'up', failures: 0, failingSince: undefined, downSince: undefined });
      if (c.status === 'down') {
        await closeIncident(ctx, ref(c), { statusCode: args.statusCode, latencyMs: args.latencyMs });
        await monitorAlert(ctx, app, ref(c), {
          status: 'recovered',
          title: `${c.name} is back up`,
          body: `${c.downSince ? `Down for ${formatDuration(now - c.downSince)}. ` : ''}Responded in ${args.latencyMs ?? 0}ms.`,
          priority: 5
        });
      }
      return null;
    }

    const failures = c.failures + 1;
    const failingSince = c.failingSince ?? now;
    if (c.status === 'down' || failures < c.confirmAfter) {
      await ctx.db.patch(c._id, { ...seen, failures, failingSince });
      return null;
    }
    await ctx.db.patch(c._id, { ...seen, failures, failingSince, status: 'down', downSince: now });
    await openIncident(ctx, app._id, ref(c), args.error ?? 'Down', { firstFailedAt: failingSince, statusCode: args.statusCode, latencyMs: args.latencyMs });
    await monitorAlert(ctx, app, ref(c), {
      status: 'down',
      title: `${c.name} is down`,
      body: `${args.error ?? 'No response'} · ${displayUrl(c.url)}`,
      priority: 8
    });
    return null;
  }
});

export function uptimeReplaceKey(name: string): string {
  return `uptime:${name}`;
}

function ref(c: Doc<'uptimeChecks'>): MonitorRef {
  return { kind: 'uptime', id: c._id, name: c.name, replaceKey: uptimeReplaceKey(c.name) };
}

function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return raw;
  }
}
