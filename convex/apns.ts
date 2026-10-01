'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import * as http2 from 'node:http2';
import { createPrivateKey, createSign } from 'node:crypto';

/**
 * Direct APNs client for Live Activities.
 *
 * Uses the push-to-start + per-activity update-token flow (iOS 16.2 / 17.2+).
 * Expo Push does not support `apns-push-type: liveactivity` so we bypass it.
 *
 * Required environment variables (set via `bunx convex env set …`):
 *   APNS_AUTH_KEY      The contents of an APNs .p8 auth key (PEM w/ newlines).
 *                      Keep the `-----BEGIN PRIVATE KEY-----` headers intact.
 *   APNS_KEY_ID        The 10-char key id shown next to the .p8 in the Apple
 *                      developer console.
 *   APNS_TEAM_ID       Your 10-char Apple Developer Team ID.
 *   APNS_BUNDLE_ID     The main app bundle id — e.g. "com.example.pushr".
 *   APNS_ENVIRONMENT   "production" (TestFlight/App Store) or "sandbox"
 *                      (Xcode debug builds). Defaults to "sandbox".
 *
 * Apple docs:
 *   https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server
 *   https://developer.apple.com/documentation/activitykit/updating-live-activities-with-activitykit-push-notifications
 */

const APNS_PROD_HOST = 'api.push.apple.com';
const APNS_SANDBOX_HOST = 'api.sandbox.push.apple.com';

type ApnsEnvironment = 'production' | 'sandbox';

function apnsHost(): string {
  const env = (process.env.APNS_ENVIRONMENT ?? 'sandbox').toLowerCase();
  return env === 'production' ? APNS_PROD_HOST : APNS_SANDBOX_HOST;
}

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} env var is not set`);
  return val;
}

// --- JWT (ES256) -----------------------------------------------------------

/**
 * APNs requires an ES256-signed JWT as bearer. Cached for 55 minutes
 * (Apple rejects tokens > 1h old and requires refresh < 1h).
 */
let cachedJwt: { token: string; exp: number } | null = null;

function buildApnsJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp - now > 60) return cachedJwt.token;

  const keyId = requiredEnv('APNS_KEY_ID');
  const teamId = requiredEnv('APNS_TEAM_ID');
  const authKey = requiredEnv('APNS_AUTH_KEY').replace(/\\n/g, '\n');

  const header = { alg: 'ES256', kid: keyId };
  const payload = { iss: teamId, iat: now };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = createPrivateKey(authKey);
  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  // Apple wants the raw 64-byte IEEE P1363 signature, not DER.
  const der = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  const sigB64 = base64url(der);

  const token = `${signingInput}.${sigB64}`;
  // Refresh after 55 minutes.
  cachedJwt = { token, exp: now + 55 * 60 };
  return token;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// --- HTTP/2 client ---------------------------------------------------------

type SendArgs = {
  deviceToken: string;
  payload: Record<string, unknown>;
  priority?: 5 | 10;
  // Defaults to 0 (APNs keeps until delivered or until staleDate).
  expirationSeconds?: number;
  // Optional apns-collapse-id to coalesce repeats.
  collapseId?: string;
};

type SendResult = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
};

async function sendToApns(args: SendArgs): Promise<SendResult> {
  const host = apnsHost();
  const bundleId = requiredEnv('APNS_BUNDLE_ID');
  const topic = `${bundleId}.push-type.liveactivity`;
  const jwt = buildApnsJwt();
  const body = JSON.stringify(args.payload);

  // Live Activity pushes require apns-expiration within 1h of now. Default
  // to 1h; callers can override with expirationSeconds. APNs silently drops
  // updates with no expiration or expirations beyond the 1h window.
  const defaultExpiration = Math.floor(Date.now() / 1000) + 60 * 60;

  return await new Promise<SendResult>((resolve) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', (err) => {
      resolve({
        ok: false,
        status: 0,
        reason: `h2 connect error: ${err.message}`
      });
    });

    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${args.deviceToken}`,
      'apns-push-type': 'liveactivity',
      'apns-topic': topic,
      'apns-priority': String(args.priority ?? 10),
      'apns-expiration': String(args.expirationSeconds ?? defaultExpiration),
      authorization: `bearer ${jwt}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    };
    if (args.collapseId) {
      headers['apns-collapse-id'] = args.collapseId;
    }

    const req = client.request(headers);
    let status = 0;
    let apnsId: string | undefined;
    const chunks: Buffer[] = [];

    req.on('response', (h) => {
      status = Number(h[':status'] ?? 0);
      const id = h['apns-id'];
      apnsId = Array.isArray(id) ? id[0] : id;
    });
    req.setEncoding('utf8');
    req.on('data', (c: string) => chunks.push(Buffer.from(c, 'utf8')));
    req.on('end', () => {
      client.close();
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (status >= 200 && status < 300) {
        resolve({ ok: true, status, apnsId });
      } else {
        let reason = bodyText;
        try {
          const parsed = JSON.parse(bodyText);
          reason = parsed.reason ?? bodyText;
        } catch {
          // leave bodyText
        }
        resolve({ ok: false, status, apnsId, reason });
      }
    });
    req.on('error', (err) => {
      client.close();
      resolve({ ok: false, status, reason: err.message });
    });
    req.end(body);
  });
}

// --- Live Activity payloads ------------------------------------------------

type ContentState = {
  title?: string;
  status?: string;
  progress?: number;
  icon?: string;
};

type Attributes = {
  name?: string;
  logoUrl?: string;
  /** Caller-provided activity id, embedded into attributes so the device
   *  can correlate the activity with its server-side record after
   *  push-to-start creation. */
  callerId?: string;
};

type StartOpts = {
  attributes: Attributes;
  state: ContentState;
  staleDate?: number; // ms-epoch
  relevanceScore?: number;
  alert?: { title: string; body: string };
};

function buildStartPayload(opts: StartOpts): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: 'start',
    'attributes-type': 'PushrActivityAttributes',
    attributes: opts.attributes,
    'content-state': opts.state
  };
  if (opts.staleDate) aps['stale-date'] = Math.floor(opts.staleDate / 1000);
  if (opts.relevanceScore !== undefined) {
    aps['relevance-score'] = opts.relevanceScore;
  }
  if (opts.alert) aps.alert = opts.alert;
  return { aps };
}

function buildUpdatePayload(opts: {
  state: ContentState;
  staleDate?: number;
  alert?: { title: string; body: string };
  event?: 'update' | 'end';
  dismissalDate?: number;
}): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: opts.event ?? 'update',
    'content-state': opts.state
  };
  if (opts.staleDate) aps['stale-date'] = Math.floor(opts.staleDate / 1000);
  if (opts.alert) aps.alert = opts.alert;
  if (opts.event === 'end' && opts.dismissalDate !== undefined) {
    aps['dismissal-date'] = Math.floor(opts.dismissalDate / 1000);
  }
  return { aps };
}

// --- Public action ---------------------------------------------------------

/**
 * Dispatch a Live Activity action through APNs directly.
 *
 * Invoked by notifyInternal.ingest when a `/notify` payload carries
 * `liveActivity`. Loads the necessary tokens from the DB, posts to APNs,
 * and records the outcome on the `liveActivities` shadow row.
 */
export const dispatch = internalAction({
  args: {
    notificationId: v.id('notifications')
  },
  handler: async (ctx, { notificationId }) => {
    if (!process.env.APNS_AUTH_KEY) {
      console.warn('[apns] skipping — APNS_AUTH_KEY not configured');
      return;
    }
    const ctxData: {
      ownerId: string;
      sourceAppId: import('./_generated/dataModel').Id<'sourceApps'>;
      liveActivity?: {
        action: 'start' | 'update' | 'end';
        activityId: string;
        state: ContentState;
        attributes?: Attributes;
        staleDate?: number;
        relevanceScore?: number;
      };
      alert?: { title: string; body: string };
    } = await ctx.runQuery(internal.apnsHelpers.getDispatchContext, {
      id: notificationId
    });
    const la = ctxData.liveActivity;
    if (!la) return;

    if (la.action === 'start') {
      const tokens: Array<{ deviceId: string; pushToStartToken: string }> = await ctx.runQuery(
        internal.apnsHelpers.getPushToStartTokensForSourceApp,
        { sourceAppId: ctxData.sourceAppId }
      );
      if (tokens.length === 0) {
        console.warn(
          `[apns] no push-to-start tokens registered for source app ${ctxData.sourceAppId} — activity cannot start remotely`
        );
        return;
      }
      const payload = buildStartPayload({
        attributes: { ...la.attributes, callerId: la.activityId },
        state: la.state,
        staleDate: la.staleDate,
        relevanceScore: la.relevanceScore,
        alert: ctxData.alert
      });
      console.log(`[apns] start ${la.activityId} → sending to ${tokens.length} device(s)`, {
        host: apnsHost(),
        tokenTails: tokens.map((t) => t.pushToStartToken.slice(-12))
      });
      const results = await Promise.all(
        tokens.map((t) =>
          sendToApns({
            deviceToken: t.pushToStartToken,
            payload,
            priority: 10,
            collapseId: la.activityId
          }).then((r) => ({ ...r, deviceId: t.deviceId }))
        )
      );
      for (const r of results) {
        console.log(
          `[apns] start result: ok=${r.ok} status=${r.status}${r.reason ? ` reason=${r.reason}` : ''}${r.apnsId ? ` apnsId=${r.apnsId}` : ''}`
        );
      }
      await ctx.runMutation(internal.apnsHelpers.recordStartResults, {
        notificationId,
        activityId: la.activityId,
        results: results.map((r) => ({
          deviceId: r.deviceId as any,
          ok: r.ok,
          status: r.status,
          reason: r.reason,
          apnsId: r.apnsId
        }))
      });
      return;
    }

    // update | end — use per-activity update token.
    const activity: {
      pushUpdateToken?: string;
      activityId: string;
    } | null = await ctx.runQuery(internal.apnsHelpers.getActivityByOwner, {
      ownerId: ctxData.ownerId,
      activityId: la.activityId
    });
    console.log(
      `[apns] ${la.action} ${la.activityId} → row lookup ownerId=${ctxData.ownerId} result=${JSON.stringify(activity)}`
    );
    if (!activity) {
      console.warn(
        `[apns] ${la.action} ${la.activityId} — no liveActivities row (start push lost? device never confirmed?)`
      );
      return;
    }
    if (!activity.pushUpdateToken) {
      console.warn(
        `[apns] ${la.action} ${la.activityId} — row exists but no pushUpdateToken yet (device hasn't reported one; is enablePushUpdates running and activityUpdates wired?)`
      );
      return;
    }
    const payload = buildUpdatePayload({
      state: la.state,
      staleDate: la.staleDate,
      alert: ctxData.alert,
      event: la.action,
      dismissalDate: la.action === 'end' ? Date.now() : undefined
    });
    console.log(
      `[apns] ${la.action} ${la.activityId} → sending host=${apnsHost()} tokenTail=${activity.pushUpdateToken.slice(-12)} body=${JSON.stringify(payload)}`
    );
    const result = await sendToApns({
      deviceToken: activity.pushUpdateToken,
      payload,
      priority: 10,
      collapseId: la.activityId
    });
    console.log(
      `[apns] ${la.action} result: ok=${result.ok} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}${result.apnsId ? ` apnsId=${result.apnsId}` : ''}`
    );
    await ctx.runMutation(internal.apnsHelpers.recordUpdateResult, {
      notificationId,
      ownerId: ctxData.ownerId,
      deadToken: activity.pushUpdateToken,
      activityId: la.activityId,
      ok: result.ok,
      status: result.status,
      reason: result.reason,
      apnsId: result.apnsId
    });
  }
});

/**
 * Push an activity's latest known state to its (newly reported) update token.
 * Scheduled by `liveActivities.registerUpdateToken`.
 */
export const catchUp = internalAction({
  args: { liveActivityId: v.id('liveActivities') },
  handler: async (ctx, { liveActivityId }) => {
    if (!process.env.APNS_AUTH_KEY) return;
    const row: {
      activityId: string;
      pushUpdateToken?: string;
      lastState?: ContentState;
      endedAt?: number;
    } | null = await ctx.runQuery(internal.apnsHelpers.getActivityById, { id: liveActivityId });
    if (!row?.pushUpdateToken || !row.lastState || row.endedAt !== undefined) return;
    const result = await sendToApns({
      deviceToken: row.pushUpdateToken,
      payload: buildUpdatePayload({ state: row.lastState, event: 'update' }),
      priority: 10,
      collapseId: row.activityId
    });
    console.log(
      `[apns] catch-up ${row.activityId}: ok=${result.ok} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`
    );
  }
});
