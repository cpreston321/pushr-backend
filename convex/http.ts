import { httpRouter } from 'convex/server';
import { BACKEND_VERSION, FEATURES, MIN_APP_VERSION } from './lib/version';
import { unsafeCallbackReason } from './lib/safeUrl';
import { SELF_HOSTED } from './lib/deployment';
import { appleSignInEnabled } from './lib/features';
import { httpAction, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import { authComponent, createAuth } from './betterAuth/auth';
import { sendNotification, type LiveActivityPayload, type SendArgs } from './lib/dispatch';
import { githubAdapter } from './hooks/github';
import { sentryAdapter } from './hooks/sentry';
import { grafanaAdapter } from './hooks/grafana';
import type { Adapter } from './hooks/types';
import { verifyHmacSha256 } from './hooks/verifySignature';
import { layoutActions, MAX_ACTIONS, type NotifAction } from './lib/actionsLayout';
import { REPLACE_KEY_MAX_LENGTH } from './lib/replace';
import { fitHookNotification, notifyLimitError } from './lib/notifyLimits';
import { EVERY_MAX_SEC, EVERY_MIN_SEC, GRACE_MAX_SEC, NAME_PATTERN } from './heartbeats';
import { SLUG_PATTERN } from './statusPages';

const http = httpRouter();

// CORS for the web dashboard, which reaches a self-hosted server from app.pushr.sh.
authComponent.registerRoutes(http, createAuth, { cors: SELF_HOSTED });

/**
 * POST /notify
 *
 * Headers:   Authorization: Bearer <pshr_…>
 * Body:      { title, body, priority?, url?, data?, ack? }
 *            Also accepts Gotify-style { title, message, priority?, extras? }
 *            so legacy callers can swap GOTIFY_URL → pushr without code change.
 *
 *            `priority` may be a number (1–10, Gotify-style) or a string:
 *              "low" | "normal" | "high"
 *            Numeric values >= 7 and the string "high" deliver as a
 *            wake-the-device Expo high-priority push; everything else
 *            delivers at default priority.
 *
 *            `ack` (optional): { "timeoutSec": 60, "maxAttempts": 5 }
 *            If set, pushr re-pushes at high priority every `timeoutSec`
 *            seconds (ignoring quiet hours) until the user taps the
 *            notification or `maxAttempts` re-pushes have been sent.
 *
 *            `Idempotency-Key: <opaque string>` (optional header): retrying
 *            with the same key returns the original notification id instead
 *            of pushing again, and doesn't spend quota. Keys are scoped to
 *            the source app and retained for 24h. Reusing a key with a
 *            different payload is a 409 — that's a client bug, not a retry.
 *
 * Response:  202 { id } on success. 401 / 400 on auth / validation.
 *            A replay answers 200 with the original body and
 *            `Idempotent-Replay: true`.
 */
const notifyHandler = httpAction(async (ctx, req) => {
  const auth = req.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return json({ error: 'Missing bearer token' }, 401);
  }
  const token = match[1].trim();
  const idempotencyKey = req.headers.get('idempotency-key')?.trim() || undefined;
  if (idempotencyKey !== undefined && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return json(
      { error: `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters` },
      400
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json({ error: 'The body must be a JSON object' }, 400);
  }

  const title = asString(payload.title);
  const body = asString(payload.body) ?? asString(payload.message);
  if (!title || !body) {
    return json({ error: 'title and body (or message) are required' }, 400);
  }
  const priority = parsePriority(payload.priority);
  if (priority === 'invalid') {
    return json({ error: 'priority must be a number (1-10) or one of: low, normal, high' }, 400);
  }
  const url =
    asString(payload.url) ??
    asString(
      (payload.extras as Record<string, any> | undefined)?.['client::notification']?.click?.url
    );
  const appUrl = asString(payload.appUrl);
  const data = isObject(payload.data) ? (payload.data as Record<string, unknown>) : undefined;
  const image = asString(payload.image);
  const action = parseAction(payload.action);
  if (action === 'invalid') {
    return json({ error: 'action must be { label: string, url: string }' }, 400);
  }
  const actions = parseActions(payload.actions);
  if (typeof actions === 'string') {
    return json({ error: actions }, 400);
  }
  const deliverAt = asNumber(payload.deliverAt);
  if (deliverAt !== undefined && deliverAt < Date.now() - 60_000) {
    return json({ error: 'deliverAt is in the past' }, 400);
  }
  const ack = parseAck(payload.ack);
  if (ack === 'invalid') {
    return json(
      {
        error: 'ack must be { timeoutSec: number>=10, maxAttempts: number 1..20 }'
      },
      400
    );
  }
  const liveActivity = parseLiveActivity(payload.liveActivity);
  if (typeof liveActivity === 'string') {
    return json({ error: liveActivity }, 400);
  }
  const replaceKey = payload.replaceKey;
  if (
    replaceKey !== undefined &&
    replaceKey !== null &&
    (typeof replaceKey !== 'string' || !replaceKey.trim() || replaceKey.length > REPLACE_KEY_MAX_LENGTH)
  ) {
    return json({ error: `replaceKey must be a non-empty string of at most ${REPLACE_KEY_MAX_LENGTH} characters` }, 400);
  }

  return dispatchNotification(ctx, {
    token,
    normalized: {
      title,
      body,
      priority,
      url,
      appUrl,
      data,
      image,
      action: action ?? undefined,
      actions: actions ?? undefined
    },
    ack: ack ?? undefined,
    liveActivity: liveActivity ?? undefined,
    replaceKey: typeof replaceKey === 'string' ? replaceKey.trim() : undefined,
    critical: payload.critical === true || undefined,
    deliverAt,
    idempotencyKey
  });
});

/** Long enough for a UUID or a caller's own composite key; short enough to index. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** /notify and the provider hooks: send, then answer with the id or the error's status. */
async function dispatchNotification(ctx: ActionCtx, args: SendArgs): Promise<Response> {
  const limitError = notifyLimitError({
    normalized: args.normalized,
    liveActivity: args.liveActivity,
    deliverAt: args.deliverAt,
    now: Date.now()
  });
  if (limitError) return json({ error: limitError }, 400);
  try {
    const { notificationId, scheduledFor, replayed } = await sendNotification(ctx, args);
    if (replayed) {
      return json({ id: notificationId, scheduledFor }, 200, { 'Idempotent-Replay': 'true' });
    }
    return json({ id: notificationId, scheduledFor }, 202);
  } catch (err: any) {
    const code = err?.data?.code;
    if (code === 'INVALID_TOKEN') return json({ error: 'Invalid token' }, 401);
    if (code === 'APP_DISABLED') return json({ error: 'Source app disabled' }, 403);
    if (code === 'IDEMPOTENCY_KEY_REUSED') {
      return json({ error: err.data?.message, code }, 409);
    }
    if (code === 'RATE_LIMITED') {
      return json({ error: err.data?.message, code }, 429, {
        'Retry-After': String(err.data?.retryAfterSec ?? 60)
      });
    }
    return internalError(err);
  }
}

function parseAction(v: unknown): { label: string; url: string } | undefined | 'invalid' {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) return 'invalid';
  const label = asString(v.label);
  const url = asString(v.url);
  if (!label || !url) return 'invalid';
  return { label, url };
}

/**
 * Parse the `actions` array from /notify. Returns the typed array, `undefined`
 * if the field is missing, or a human-readable error string on validation
 * failure.
 */
function parseActions(v: unknown): NotifAction[] | undefined | string {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return 'actions must be an array';
  if (v.length === 0) return undefined;
  if (v.length > MAX_ACTIONS) return `actions supports at most ${MAX_ACTIONS} entries`;

  const out: NotifAction[] = [];
  for (const raw of v) {
    if (!isObject(raw)) return 'each action must be an object';
    const id = asString(raw.id);
    const label = asString(raw.label);
    const kind = asString(raw.kind);
    if (!id || !label || !kind) {
      return 'each action requires id, label, and kind';
    }
    if (kind === 'open_url') {
      const url = asString(raw.url);
      if (!url) return 'open_url action requires url';
      out.push({
        kind: 'open_url',
        id,
        label,
        url,
        destructive: typeof raw.destructive === 'boolean' ? raw.destructive : undefined
      });
    } else if (kind === 'callback') {
      const callbackUrl = asString(raw.callbackUrl);
      if (!callbackUrl) return 'callback action requires callbackUrl';
      const unsafe = unsafeCallbackReason(callbackUrl);
      if (unsafe) return unsafe;
      out.push({
        kind: 'callback',
        id,
        label,
        callbackUrl,
        destructive: typeof raw.destructive === 'boolean' ? raw.destructive : undefined,
        authRequired: typeof raw.authRequired === 'boolean' ? raw.authRequired : undefined
      });
    } else if (kind === 'reply') {
      const callbackUrl = asString(raw.callbackUrl);
      if (!callbackUrl) return 'reply action requires callbackUrl';
      const unsafe = unsafeCallbackReason(callbackUrl);
      if (unsafe) return unsafe;
      out.push({
        kind: 'reply',
        id,
        label,
        callbackUrl,
        placeholder: asString(raw.placeholder)
      });
    } else {
      return `unknown action kind: ${kind}`;
    }
  }

  try {
    layoutActions(out); // throws on duplicate id / >1 reply / too many
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid actions';
  }
  return out;
}

function parseLiveActivity(v: unknown): LiveActivityPayload | undefined | string {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) return 'liveActivity must be an object';
  const action = asString(v.action);
  if (action !== 'start' && action !== 'update' && action !== 'end') {
    return 'liveActivity.action must be start | update | end';
  }
  const activityId = asString(v.activityId);
  if (!activityId) return 'liveActivity.activityId is required';
  if (!isObject(v.state)) return 'liveActivity.state must be an object';
  const rawState = v.state as Record<string, unknown>;
  const progress = asNumber(rawState.progress);
  if (progress !== undefined && (progress < 0 || progress > 1)) {
    return 'liveActivity.state.progress must be between 0 and 1';
  }
  const outcome = rawState.outcome;
  if (outcome !== undefined && outcome !== null && outcome !== 'success' && outcome !== 'failure') {
    return 'liveActivity.state.outcome must be success or failure';
  }
  const state = {
    title: asString(rawState.title),
    status: asString(rawState.status),
    progress,
    icon: asString(rawState.icon),
    outcome: (outcome ?? undefined) as 'success' | 'failure' | undefined
  };

  let attributes: { name?: string; logoUrl?: string } | undefined;
  if (v.attributes !== undefined && v.attributes !== null) {
    if (!isObject(v.attributes)) {
      return 'liveActivity.attributes must be an object';
    }
    const a = v.attributes as Record<string, unknown>;
    attributes = {
      name: asString(a.name),
      logoUrl: asString(a.logoUrl)
    };
  }
  if (action === 'start' && !attributes) {
    // Not fatal, but many widget designs rely on an app name in attributes.
    attributes = {};
  }

  const relevanceScore = asNumber(v.relevanceScore);
  if (relevanceScore !== undefined && (relevanceScore < 0 || relevanceScore > 1)) {
    return 'liveActivity.relevanceScore must be between 0 and 1';
  }

  const dismissAfter = asNumber(v.dismissAfter);
  if (dismissAfter !== undefined && (dismissAfter < 0 || dismissAfter > LA_DISMISS_MAX_SEC)) {
    return `liveActivity.dismissAfter must be 0 to ${LA_DISMISS_MAX_SEC} seconds`;
  }

  return {
    action,
    activityId,
    state,
    attributes,
    staleDate: asNumber(v.staleDate),
    dismissAfter,
    relevanceScore
  };
}

/** iOS keeps an ended activity at most four hours. */
const LA_DISMISS_MAX_SEC = 4 * 3_600;

function parseAck(v: unknown): { timeoutSec: number; maxAttempts: number } | undefined | 'invalid' {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) return 'invalid';
  const timeoutSec = asNumber(v.timeoutSec);
  const maxAttempts = asNumber(v.maxAttempts);
  if (
    timeoutSec === undefined ||
    maxAttempts === undefined ||
    timeoutSec < 10 ||
    timeoutSec > 86_400 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  ) {
    return 'invalid';
  }
  return { timeoutSec, maxAttempts };
}

http.route({ path: '/notify', method: 'POST', handler: notifyHandler });

/**
 * Webhook adapters.
 *
 * POST /hooks/{github,sentry,grafana}
 *   Auth: Authorization: Bearer <pshr_…>
 *         — or —
 *         ?token=<pshr_…> in the query string (for services that can't
 *         customize outbound headers).
 *
 *   If the source app has a `webhookSecret` set, the signature header for
 *   the provider is verified (GitHub: X-Hub-Signature-256 sha256=<hex>;
 *   Sentry: Sentry-Hook-Signature <hex>). Otherwise only the bearer token
 *   is checked. Grafana doesn't natively sign webhooks, so for Grafana the
 *   bearer is the only authenticator — DO NOT expose a Grafana hook URL
 *   anywhere a third party could reach it.
 *
 * The adapter normalizes the provider payload to {title, body, priority,
 * url, data, image, action, eventType} and the rest of /notify's plumbing
 * (quotas, delivery, ack, receipts) applies unchanged.
 */
const SIGNATURE_HEADER: Record<string, string | null> = {
  github: 'x-hub-signature-256',
  sentry: 'sentry-hook-signature',
  grafana: null
};

function makeHookHandler(provider: string, adapter: Adapter) {
  return httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const auth = req.headers.get('authorization') ?? '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    const queryToken = url.searchParams.get('token') ?? undefined;
    const token = match ? match[1].trim() : queryToken?.trim();
    if (!token) {
      return json({ error: 'Missing bearer token' }, 401);
    }

    // Read the raw body once so we can both parse it and verify HMAC.
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return json({ error: 'Unable to read request body' }, 400);
    }

    // If a webhookSecret is configured on the app, require a valid signature
    // for providers that sign their payloads. (The bearer token already
    // authenticates the request — verifying the signature lets the app's
    // owner detect replay/forwarding attacks.)
    //
    //   github  → X-Hub-Signature-256: sha256=<hex>
    //   sentry  → Sentry-Hook-Signature: <hex>
    //   grafana → no native signature; relies on bearer auth alone
    const sigHeader = SIGNATURE_HEADER[provider];
    if (sigHeader) {
      const secret: string | null = await ctx.runQuery(
        internal.notifyInternal.webhookSecretForToken,
        { token, provider }
      );
      if (secret) {
        const sig = req.headers.get(sigHeader);
        const ok = await verifyHmacSha256(rawBody, sig, secret);
        if (!ok) return json({ error: 'Invalid signature' }, 401);
      }
    }

    let payload: unknown;
    try {
      payload = rawBody.length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const normalized = adapter(payload, req.headers);
    if (!normalized) {
      // Adapter chose to ignore this event (e.g. GitHub "ping"). Return 200
      // with an explicit `ignored: true` so the provider's delivery logs
      // still show success.
      return json({ ignored: true, provider }, 200);
    }

    return dispatchNotification(ctx, {
      token,
      normalized: fitHookNotification(normalized),
      webhookProvider: provider,
      webhookEventType: normalized.eventType
    });
  });
}

http.route({
  path: '/hooks/github',
  method: 'POST',
  handler: makeHookHandler('github', githubAdapter)
});
http.route({
  path: '/hooks/sentry',
  method: 'POST',
  handler: makeHookHandler('sentry', sentryAdapter)
});
http.route({
  path: '/hooks/grafana',
  method: 'POST',
  handler: makeHookHandler('grafana', grafanaAdapter)
});


// Health check, also read by the app: `selfHosted` makes the Server screen ask
// for a connection code, and `appleSignIn` decides whether the Apple button shows.
/**
 * POST /live-activity/token
 *   Auth: Authorization: Bearer <device Live Activity key>
 *   Body: { activityId, nativeActivityId, pushUpdateToken }
 *
 * The app's native code reports a Live Activity's update token here itself.
 * When a push starts an activity with pushr closed and the phone locked, iOS
 * wakes the app only briefly, with no signed-in session, and without the
 * token the activity's updates have nowhere to go.
 */
http.route({
  path: '/live-activity/token',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const match = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
    if (!match) return json({ error: 'Missing bearer token' }, 401);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const activityId = asString(body.activityId);
    const nativeActivityId = asString(body.nativeActivityId);
    const pushUpdateToken = asString(body.pushUpdateToken);
    if (!activityId || !nativeActivityId || !pushUpdateToken) {
      return json({ error: 'activityId, nativeActivityId and pushUpdateToken are required' }, 400);
    }
    if (activityId.length > 256 || nativeActivityId.length > 256 || pushUpdateToken.length > 512) {
      return json({ error: 'A field is too long' }, 400);
    }
    const ok = await ctx.runMutation(internal.liveActivities.registerUpdateTokenWithKey, {
      key: match[1].trim(),
      activityId,
      nativeActivityId,
      pushUpdateToken
    });
    return ok ? json({ ok: true }, 200) : json({ error: 'Unknown key' }, 401);
  })
});

/**
 * /heartbeat/<name>          GET or POST: the job ran
 * /heartbeat/<name>/start    the job started (reports how long it took)
 * /heartbeat/<name>/fail     the job failed; a text body becomes the alert
 * DELETE /heartbeat/<name>   stop watching it
 *
 *   Auth: Authorization: Bearer <pshr_…>
 *   Query: every=<interval> (required on the first ping), grace=<interval>.
 *          An interval is seconds, or a number with s, m, h or d: 90s, 15m, 1h.
 */
const heartbeatHandler = httpAction(async (ctx, req) => {
  const match = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!match) return json({ error: 'Missing bearer token' }, 401);
  const token = match[1].trim();
  const url = new URL(req.url);
  let parts: string[];
  try {
    parts = url.pathname.replace(/^\/heartbeat\//, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return json({ error: 'The heartbeat name is not valid URL encoding' }, 400);
  }
  const [name, suffix, ...rest] = parts;
  if (!name || !NAME_PATTERN.test(name) || rest.length > 0) {
    return json({ error: 'Use /heartbeat/<name>, where name is up to 64 letters, digits, dots, dashes or underscores' }, 400);
  }
  if (suffix !== undefined && suffix !== 'start' && suffix !== 'fail') {
    return json({ error: 'Use /heartbeat/<name>, /heartbeat/<name>/start or /heartbeat/<name>/fail' }, 404);
  }

  try {
    if (req.method === 'DELETE') {
      if (suffix) return json({ error: 'DELETE takes /heartbeat/<name>' }, 400);
      const removed = await ctx.runMutation(internal.heartbeats.remove, { token, name });
      return removed ? json({ ok: true }, 200) : json({ error: 'No heartbeat with that name' }, 404);
    }

    const every = url.searchParams.get('every');
    const grace = url.searchParams.get('grace');
    const everySec = every === null ? undefined : parseInterval(every);
    const graceSec = grace === null ? undefined : parseInterval(grace);
    if (everySec === null || (everySec !== undefined && (everySec < EVERY_MIN_SEC || everySec > EVERY_MAX_SEC))) {
      return json({ error: 'every must be an interval from 1m to 30d, like 15m, 1h or 1d' }, 400);
    }
    if (graceSec === null || (graceSec !== undefined && graceSec > GRACE_MAX_SEC)) {
      return json({ error: 'grace must be an interval up to 7d, like 5m or 1h' }, 400);
    }
    const message =
      suffix === 'fail' && req.method === 'POST' ? (await req.text().catch(() => '')).slice(-1_000) : undefined;

    const res = await ctx.runMutation(internal.heartbeats.ping, {
      token,
      name,
      kind: suffix === 'start' ? 'start' : suffix === 'fail' ? 'fail' : 'success',
      everySec,
      graceSec,
      message: message || undefined
    });
    return json({ ok: true, name, ...res }, 200);
  } catch (err: any) {
    const code = err?.data?.code;
    if (code === 'INVALID_TOKEN') return json({ error: 'Invalid token' }, 401);
    if (code === 'APP_DISABLED') return json({ error: 'Source app disabled' }, 403);
    if (code === 'EVERY_REQUIRED') return json({ error: err.data.message, code }, 400);
    if (code === 'HEARTBEAT_LIMIT') return json({ error: err.data.message, code }, 409);
    if (code === 'PRO_REQUIRED') {
      return json({ error: err.data.message, code, ...(process.env.UPGRADE_URL ? { upgrade: process.env.UPGRADE_URL } : {}) }, 403);
    }
    return internalError(err);
  }
});

/** Seconds from "90", "90s", "15m", "1h" or "1d"; null when it isn't one. */
function parseInterval(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  return Math.round(n * { s: 1, m: 60, h: 3_600, d: 86_400 }[unit as 's' | 'm' | 'h' | 'd']);
}

for (const method of ['GET', 'POST', 'DELETE'] as const) {
  http.route({ pathPrefix: '/heartbeat/', method, handler: heartbeatHandler });
}

/**
 * PUT /uptime/<name>      create or change an uptime check; JSON body
 *                         { url, every, method?, keyword?, timeout?, confirmAfter? }
 * GET /uptime/<name>      its current state
 * DELETE /uptime/<name>   stop checking it
 *
 *   Auth: Authorization: Bearer <pshr_…>
 */
const uptimeHandler = httpAction(async (ctx, req) => {
  const match = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!match) return json({ error: 'Missing bearer token' }, 401);
  const token = match[1].trim();
  let name: string | undefined;
  let extra: string[];
  try {
    [name, ...extra] = new URL(req.url).pathname.replace(/^\/uptime\//, '').split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return json({ error: 'The check name is not valid URL encoding' }, 400);
  }
  if (!name || !NAME_PATTERN.test(name) || extra.length > 0) {
    return json({ error: 'Use /uptime/<name>, where name is up to 64 letters, digits, dots, dashes or underscores' }, 400);
  }

  try {
    if (req.method === 'GET') {
      const check = await ctx.runQuery(internal.uptime.getByToken, { token, name });
      return check ? json({ ok: true, ...check }, 200) : json({ error: 'No uptime check with that name' }, 404);
    }
    if (req.method === 'DELETE') {
      const removed = await ctx.runMutation(internal.uptime.deleteByToken, { token, name });
      return removed ? json({ ok: true }, 200) : json({ error: 'No uptime check with that name' }, 404);
    }
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const url = asString(body.url);
    const every = typeof body.every === 'number' ? body.every : typeof body.every === 'string' ? parseInterval(body.every) : null;
    if (!url) return json({ error: 'url is required' }, 400);
    if (every === null) return json({ error: 'every is required: an interval like 1m, 5m or 1h' }, 400);
    const timeout =
      body.timeout === undefined ? undefined : typeof body.timeout === 'number' ? body.timeout : parseInterval(String(body.timeout));
    if (timeout === null) return json({ error: 'timeout must be an interval like 10s' }, 400);
    const method = body.method === undefined ? undefined : body.method === 'GET' || body.method === 'HEAD' ? body.method : null;
    if (method === null) return json({ error: 'method must be GET or HEAD' }, 400);
    const confirmAfter = body.confirmAfter === undefined ? undefined : asNumber(body.confirmAfter);
    if (body.confirmAfter !== undefined && confirmAfter === undefined) return json({ error: 'confirmAfter must be a number' }, 400);
    const keyword = body.keyword === undefined || body.keyword === null ? undefined : asString(body.keyword);

    const check = await ctx.runMutation(internal.uptime.putByToken, {
      token,
      name,
      url,
      method,
      intervalSec: every,
      timeoutSec: timeout,
      keyword,
      confirmAfter
    });
    return json({ ok: true, ...check }, 200);
  } catch (err: any) {
    const code = err?.data?.code;
    if (code === 'INVALID_TOKEN') return json({ error: 'Invalid token' }, 401);
    if (code === 'APP_DISABLED') return json({ error: 'Source app disabled' }, 403);
    if (code === 'INVALID') return json({ error: err.data.message }, 400);
    if (code === 'PRO_REQUIRED') {
      return json({ error: err.data.message, code, ...(process.env.UPGRADE_URL ? { upgrade: process.env.UPGRADE_URL } : {}) }, 403);
    }
    if (code === 'UPTIME_LIMIT') return json({ error: err.data.message, code }, 409);
    return internalError(err);
  }
});

for (const method of ['GET', 'PUT', 'DELETE'] as const) {
  http.route({ pathPrefix: '/uptime/', method, handler: uptimeHandler });
}

/** GET /status-page/<slug>: the public JSON behind status.pushr.sh/<slug>. No auth. */
http.route({
  pathPrefix: '/status-page/',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const slug = new URL(req.url).pathname.replace(/^\/status-page\//, '').replace(/\/+$/, '');
    if (!SLUG_PATTERN.test(slug)) return json({ error: 'Not found' }, 404, CORS_HEADERS);
    const view = await ctx.runQuery(internal.statusPages.publicView, { slug });
    if (!view) return json({ error: 'Not found' }, 404, CORS_HEADERS);
    return json(view, 200, { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=30' });
  })
});


http.route({
  path: '/healthz',
  method: 'GET',
  handler: httpAction(async () =>
    json(
      {
        ok: true,
        version: BACKEND_VERSION,
        selfHosted: SELF_HOSTED,
        appleSignIn: appleSignInEnabled(),
        features: FEATURES,
        minAppVersion: MIN_APP_VERSION
      },
      200
    )
  )
});



/** Self-hosted only: trade a connection code for a one-account sign-up grant. */
http.route({
  path: '/pair',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    if (!SELF_HOSTED) return json({ error: 'Connection codes are only used by self-hosted servers' }, 404);
    const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
    if (typeof body?.code !== 'string' || body.code.length > 32) {
      return json({ error: 'code is required' }, 400);
    }
    const result = await ctx.runMutation(internal.pairing.redeem, { code: body.code });
    if (result.ok) return json({ grant: result.grant }, 200);
    return result.reason === 'locked'
      ? json({ error: 'Too many wrong codes. Try again in 15 minutes.', code: 'PAIRING_LOCKED' }, 429)
      : json({ error: 'That code is wrong or has expired. Make a new one.', code: 'PAIRING_INVALID' }, 403);
  })
});

// Callers authenticate with a bearer token, never cookies, so any origin may
// call the API from a browser (the docs' "Try it" panel, browser SDK users).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
  'Access-Control-Expose-Headers': 'Idempotent-Replay, Retry-After',
  'Access-Control-Max-Age': '86400'
};

const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS }));
http.route({ path: '/notify', method: 'OPTIONS', handler: preflight });
/** What an invite link is for, for pushr.sh's invite page. */
http.route({
  path: '/invite-preview',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    const preview = await ctx.runQuery(api.sharing.previewInvite, { token });
    return preview ? json(preview, 200) : json({ error: 'This invite link is no longer valid' }, 404);
  })
});

http.route({ path: '/healthz', method: 'OPTIONS', handler: preflight });
http.route({ path: '/pair', method: 'OPTIONS', handler: preflight });

/** What the caller sees of an unexpected failure: nothing from the error itself. */
function internalError(err: unknown): Response {
  console.error('Unexpected error in an HTTP action', err);
  return json({ error: 'Internal error' }, 500);
}

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders }
  });
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalize `priority` from either Gotify-style numbers or friendly strings
 * into a canonical 1–10 number that downstream delivery can map to Expo's
 * "default" / "high" scale. Returns "invalid" for malformed input.
 */
function parsePriority(v: unknown): number | undefined | 'invalid' {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v < 1 || v > 10) return 'invalid';
    return v;
  }
  if (typeof v === 'string') {
    switch (v.toLowerCase()) {
      case 'low':
        return 3;
      case 'normal':
      case 'default':
        return 5;
      case 'high':
        return 8;
      default:
        return 'invalid';
    }
  }
  return 'invalid';
}

export default http;
