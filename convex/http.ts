import { httpRouter } from 'convex/server';
import { unsafeCallbackReason } from './lib/safeUrl';
import { SELF_HOSTED } from './lib/deployment';
import { appleSignInEnabled } from './lib/features';
import { httpAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { authComponent, createAuth } from './betterAuth/auth';
import { pushPool } from './lib/workpools';
import { githubAdapter } from './hooks/github';
import { sentryAdapter } from './hooks/sentry';
import { grafanaAdapter } from './hooks/grafana';
import type { Adapter, NormalizedNotification } from './hooks/types';
import { verifyHmacSha256 } from './hooks/verifySignature';
import { layoutActions, MAX_ACTIONS, type NotifAction } from './lib/actionsLayout';

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

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
    deliverAt,
    idempotencyKey
  });
});

/** Long enough for a UUID or a caller's own composite key; short enough to index. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Shared dispatcher for both /notify and the provider hook endpoints.
 * Handles ingest → schedule delivery → schedule first ack check.
 */
type LiveActivityPayload = {
  action: 'start' | 'update' | 'end';
  activityId: string;
  state: {
    title?: string;
    status?: string;
    progress?: number;
    icon?: string;
  };
  attributes?: { name?: string; logoUrl?: string };
  staleDate?: number;
  relevanceScore?: number;
};

async function dispatchNotification(
  ctx: ActionCtx,
  args: {
    token: string;
    normalized: NormalizedNotification;
    ack?: { timeoutSec: number; maxAttempts: number };
    liveActivity?: LiveActivityPayload;
    deliverAt?: number;
    webhookProvider?: string;
    webhookEventType?: string;
    idempotencyKey?: string;
  }
): Promise<Response> {
  try {
    const priority = args.normalized.priority !== undefined ? args.normalized.priority : undefined;
    const { notificationId, replayed, scheduledFor } = await ctx.runMutation(
      internal.notifyInternal.ingest,
      {
        token: args.token,
        title: args.normalized.title,
        body: args.normalized.body,
        priority,
        url: args.normalized.url,
        appUrl: args.normalized.appUrl,
        data: args.normalized.data,
        image: args.normalized.image,
        action: args.normalized.action,
        actions: args.normalized.actions,
        ack: args.ack,
        liveActivity: args.liveActivity,
        webhookProvider: args.webhookProvider,
        webhookEventType: args.webhookEventType ?? args.normalized.eventType,
        idempotencyKey: args.idempotencyKey,
        deliverAt: args.deliverAt
      }
    );

    // A replay must not schedule anything: the original request already
    // enqueued delivery, forwarders and the ack check. Scheduling again is
    // exactly the double-push the key exists to prevent.
    if (replayed) {
      return json({ id: notificationId, scheduledFor: scheduledFor ?? null }, 200, {
        'Idempotent-Replay': 'true'
      });
    }

    if (args.deliverAt && args.deliverAt > Date.now() + 1_000) {
      await ctx.scheduler.runAt(args.deliverAt, internal.expoPush.deliver, {
        notificationId
      });
      if (args.liveActivity) {
        await ctx.scheduler.runAt(args.deliverAt, internal.apns.dispatch, {
          notificationId
        });
      }
      // Forwarders (Slack/Discord) fire at the same time as device delivery —
      // a Pro/self-hosted feature, no-op when the source app has no
      // forwarders configured.
      await ctx.scheduler.runAt(args.deliverAt, internal.forwarders.fanOut, {
        notificationId
      });
    } else {
      await pushPool.enqueueAction(ctx, internal.expoPush.deliver, {
        notificationId
      });
      if (args.liveActivity) {
        // APNs Live Activity — sent directly, not via Expo Push.
        await ctx.scheduler.runAfter(0, internal.apns.dispatch, {
          notificationId
        });
      }
      await ctx.scheduler.runAfter(0, internal.forwarders.fanOut, {
        notificationId
      });
    }

    if (args.ack) {
      // First escalation check fires `timeoutSec` after the initial send.
      // Anchor it on the scheduled delivery time so a future `deliverAt`
      // notification still gets a sane window.
      const baseline = args.deliverAt && args.deliverAt > Date.now() ? args.deliverAt : Date.now();
      await ctx.scheduler.runAt(baseline + args.ack.timeoutSec * 1000, internal.ack.checkAck, {
        notificationId
      });
    }

    return json({ id: notificationId, scheduledFor: args.deliverAt ?? null }, 202);
  } catch (err: any) {
    const code = err?.data?.code;
    if (code === 'INVALID_TOKEN') return json({ error: 'Invalid token' }, 401);
    if (code === 'APP_DISABLED') return json({ error: 'Source app disabled' }, 403);
    if (code === 'IDEMPOTENCY_KEY_REUSED') {
      return json({ error: err.data?.message, code }, 409);
    }
    return json({ error: err?.message ?? 'Internal error' }, 500);
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
  const state = {
    title: asString(rawState.title),
    status: asString(rawState.status),
    progress,
    icon: asString(rawState.icon)
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

  return {
    action,
    activityId,
    state,
    attributes,
    staleDate: asNumber(v.staleDate),
    relevanceScore
  };
}

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
      normalized,
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
http.route({
  path: '/healthz',
  method: 'GET',
  handler: httpAction(async () =>
    json({ ok: true, selfHosted: SELF_HOSTED, appleSignIn: appleSignInEnabled() }, 200)
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
  'Access-Control-Expose-Headers': 'Idempotent-Replay',
  'Access-Control-Max-Age': '86400'
};

const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS }));
http.route({ path: '/notify', method: 'OPTIONS', handler: preflight });
http.route({ path: '/healthz', method: 'OPTIONS', handler: preflight });
http.route({ path: '/pair', method: 'OPTIONS', handler: preflight });

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
