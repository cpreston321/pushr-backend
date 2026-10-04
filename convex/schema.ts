import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * pushr schema.
 *
 * Users live in the Better Auth component (not mirrored here). We reference
 * them by their BA subject id (string) via `ownerId`. Everything in pushr is
 * per-user: your devices, your source apps, your notification feed.
 */
export default defineSchema({
  /**
   * A source app is a project/service that can POST notifications into pushr
   * on behalf of a user (e.g. "peptide", "homelab", "ci"). Each has its own
   * bearer token. We store only the sha256 hash.
   */
  /**
   * Membership rows that grant another user access to a source app. The
   * primary `ownerId` on the source app is the bill-payer and the only role
   * that can revoke / delete / transfer / invite. Editors can change settings
   * and receive pushes; viewers only see the feed and receive pushes.
   *
   * `acceptedAt` distinguishes a pending row (created when an email is
   * matched at sign-in or accept) from an accepted membership. Pending rows
   * are not currently used — invites live in their own table — but the
   * field is reserved so we can support direct-link grants without an
   * intermediate invite if needed.
   */
  sourceAppMembers: defineTable({
    sourceAppId: v.id('sourceApps'),
    userId: v.string(), // BA user subject of the member
    role: v.union(v.literal('editor'), v.literal('viewer')),
    invitedBy: v.string(), // BA subject of the inviter
    // Snapshot of the member's email at accept time, for display on the
    // sharing screen. Source of truth still lives in the BA user table.
    email: v.optional(v.string()),
    acceptedAt: v.optional(v.number())
  })
    .index('by_app', ['sourceAppId'])
    .index('by_user', ['userId'])
    .index('by_app_user', ['sourceAppId', 'userId']),

  /**
   * Email-keyed invite for someone who may or may not have a pushr account
   * yet. When the recipient signs in (or is already signed in), the mobile
   * app surfaces invites via `sharing.listMyPendingInvites` looking up
   * `email` against `identity.email`. Accepting the invite materializes a
   * `sourceAppMembers` row.
   */
  sourceAppInvites: defineTable({
    sourceAppId: v.id('sourceApps'),
    email: v.string(), // lowercased
    role: v.union(v.literal('editor'), v.literal('viewer')),
    invitedBy: v.string(),
    invitedByEmail: v.optional(v.string()),
    invitedByName: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    declinedAt: v.optional(v.number()),
    canceledAt: v.optional(v.number())
  })
    .index('by_email', ['email'])
    .index('by_app', ['sourceAppId'])
    .index('by_app_email', ['sourceAppId', 'email']),

  /**
   * Links that accept an invite in one tap: one per invite email or "Share
   * link". Only a hash of each link's secret is stored. A link is only as
   * good as its invite, so links outlive nothing: accepting, declining or
   * canceling the invite deletes them.
   */
  sourceAppInviteLinks: defineTable({
    inviteId: v.id('sourceAppInvites'),
    tokenHash: v.string(),
    createdAt: v.number()
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_invite', ['inviteId']),

  sourceApps: defineTable({
    ownerId: v.string(), // BA user subject
    name: v.string(),
    description: v.optional(v.string()),
    tokenHash: v.string(), // sha256(token)
    tokenPrefix: v.string(), // "pshr_abcd1234" — safe to display
    logoStorageId: v.optional(v.id('_storage')),
    // Identity color sampled from the uploaded logo, as '#RRGGBB'. Drives the
    // card bloom in the mobile feed / apps list so the glow matches the actual
    // artwork instead of a hash of the app id. Left unset when the logo can't be
    // decoded or is monochrome; the client then renders no identity bloom.
    logoColor: v.optional(v.string()),
    // How the logo is framed: see lib/logoShape.
    logoShape: v.optional(v.union(v.literal('circle'), v.literal('free'), v.literal('square'))),
    enabled: v.boolean(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Timestamp (ms since epoch) until which pushes from this source app are
    // suppressed — notifications still land in the feed but don't wake the
    // device. `undefined` or a past time means not muted.
    mutedUntil: v.optional(v.number()),
    // Quiet hours: minutes-since-midnight (0-1439) in the user's local time.
    // When the current time falls in the window, priority is downgraded to
    // "default" and sound is silenced. If start === end, no quiet hours.
    // Windows may wrap past midnight (e.g. start=1320 → end=480 covers 22:00-08:00).
    quietStart: v.optional(v.number()),
    quietEnd: v.optional(v.number()),
    // IANA zone the window was set in (e.g. 'America/New_York'). Absent on
    // windows saved before zones were recorded, which are evaluated in UTC.
    quietTimeZone: v.optional(v.string()),
    /**
     * Urgent pushes (an `ack`, or priority 7+) go to the person on call first
     * and widen to the next in `userIds` each `escalateAfterSec` they go
     * unacknowledged. `weekly` moves who's first along by one each week,
     * counted from `rotationStartedAt`.
     */
    onCall: v.optional(
      v.object({
        enabled: v.boolean(),
        userIds: v.array(v.string()),
        escalateAfterSec: v.number(),
        rotation: v.union(v.literal('none'), v.literal('weekly')),
        rotationStartedAt: v.number()
      })
    ),
    /**
     * Which pushes may ring through mute and Do Not Disturb, as iOS critical
     * alerts: none, those sent with `critical: true`, or every urgent one.
     */
    criticalAlerts: v.optional(v.union(v.literal('off'), v.literal('marked'), v.literal('urgent')))
  })
    .index('by_owner', ['ownerId'])
    .index('by_tokenHash', ['tokenHash'])
    .index('by_logo', ['logoStorageId']),

  /**
   * Outbound forwarders: when a notification is delivered for `sourceAppId`,
   * pushr also POSTs to each enabled forwarder's `url`. Used to mirror
   * pushr alerts into Slack channels or Discord webhooks. Owner-managed,
   * gated to Pro / self-hosted on the client.
   *
   * Many forwarders per source app is allowed — teams routinely route
   * different alert types to different channels (#alerts, #payments, etc.).
   * Filtering by priority lets users send only the noisy alerts to a less
   * noisy channel.
   */
  sourceAppForwarders: defineTable({
    ownerId: v.string(),
    sourceAppId: v.id('sourceApps'),
    kind: v.union(v.literal('slack'), v.literal('discord')),
    /** Provider-issued webhook URL. Validated for kind-specific host. */
    url: v.string(),
    /** Optional human label — e.g. "#alerts" or "#payments". */
    label: v.optional(v.string()),
    /** Priority threshold:
     *   - `'all'` forwards every push
     *   - `'normal_high'` forwards priority >= 5 (default normal)
     *   - `'high_only'` forwards priority >= 7 (urgent)
     */
    priorityFilter: v.union(
      v.literal('all'),
      v.literal('normal_high'),
      v.literal('high_only')
    ),
    enabled: v.boolean(),
    createdAt: v.number(),
    /** ms-epoch of last successful POST. */
    lastSentAt: v.optional(v.number()),
    /** Last error message from the destination, surfaced in the UI so the
     *  owner can see if a webhook is broken without digging into logs. */
    lastError: v.optional(v.string())
  }).index('by_sourceApp', ['sourceAppId']),

  /**
   * Per-provider HMAC secret used to verify inbound webhook signatures from
   * a specific service (GitHub's X-Hub-Signature-256, Sentry's
   * Sentry-Hook-Signature, etc.). One row per (sourceApp, provider) pair —
   * a single source app can be wired to multiple providers, each with its
   * own secret. Stored in plaintext because we need the raw key to compute
   * HMAC-SHA256 at verification time. Only providers that actually sign
   * payloads should have rows here; bearer-only providers like Grafana need
   * no entry.
   */
  webhookConfigs: defineTable({
    sourceAppId: v.id('sourceApps'),
    provider: v.string(), // matches the /hooks/:provider URL segment
    secret: v.string(),
    createdAt: v.number(),
    updatedAt: v.number()
  })
    .index('by_app', ['sourceAppId'])
    .index('by_app_provider', ['sourceAppId', 'provider']),

  /**
   * A device is a physical iOS/Android device registered to receive pushes.
   * `expoPushToken` is what we send to via the Expo Push API.
   */
  devices: defineTable({
    ownerId: v.string(),
    expoPushToken: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android'), v.literal('web')),
    name: v.optional(v.string()), // user-editable label, e.g. "Christian's iPhone"
    model: v.optional(v.string()), // device model string from Expo
    osVersion: v.optional(v.string()),
    appVersion: v.optional(v.string()),
    enabled: v.boolean(),
    lastSeenAt: v.number(),
    createdAt: v.number(),
    // Set if Expo returns DeviceNotRegistered so we stop trying
    invalidatedAt: v.optional(v.number()),
    // APNs push-to-start token for PushrActivityAttributes. Used to start
    // Live Activities when the app is terminated — see convex/apns.ts.
    // Reported by the mobile client after enrolling
    // `Activity<PushrActivityAttributes>.pushToStartTokenUpdates`.
    liveActivityPushToStartToken: v.optional(v.string()),
    liveActivityPushToStartAt: v.optional(v.number()),
    // Which APNs service this build's tokens belong to: development builds
    // get sandbox tokens, TestFlight and the App Store production ones, and
    // each service rejects the other's. Unset until the app reports it.
    apnsEnvironment: v.optional(v.union(v.literal('sandbox'), v.literal('production'))),
    // SHA-256 of the key the app's native code uses to report Live Activity
    // update tokens itself, while pushr is closed and nothing is signed in.
    liveActivityKeyHash: v.optional(v.string())
  })
    .index('by_owner', ['ownerId'])
    .index('by_token', ['expoPushToken'])
    .index('by_liveActivityKey', ['liveActivityKeyHash']),


  /**
   * Per-user delivery preferences. One row per BA user subject.
   *
   * Each priority bucket stores the Expo `sound` value to include on outbound
   * push messages. Semantics:
   *   undefined → field missing, delivery falls back to `"default"`
   *   null      → silent (no sound)
   *   "default" → iOS system default alert sound
   *   "x.caf"   → a custom sound file bundled via expo-notifications
   */
  userPrefs: defineTable({
    ownerId: v.string(),
    soundLow: v.optional(v.union(v.null(), v.string())),
    soundNormal: v.optional(v.union(v.null(), v.string())),
    soundHigh: v.optional(v.union(v.null(), v.string()))
  }).index('by_owner', ['ownerId']),

  /**
   * Notification history — every inbound notification, successful or not.
   * Mobile app shows this as the live feed.
   */
  /**
   * Replay guard for `/notify`. A caller that retries a timed-out or
   * network-failed POST with the same `Idempotency-Key` gets the original
   * notification id back instead of a second push — the property that makes
   * the API safe to call from cron jobs, CI and webhook receivers, all of
   * which retry by default.
   *
   * Scoped per source app: the key namespace belongs to whoever holds the
   * token, so two apps can use the same key without colliding.
   *
   * Rows are swept after `IDEMPOTENCY_RETAIN_MS` (see convex/cleanup.ts).
   * Retries outside that window create a new notification, which is the
   * conventional trade — the alternative is keeping every key forever.
   */
  /**
   * Self-hosted connection codes, the sign-up grants they're traded for, and
   * failed-attempt markers (see pairing.ts). Only hashes are stored.
   */
  pairing: defineTable({
    kind: v.union(v.literal('code'), v.literal('grant'), v.literal('failure')),
    hash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number())
  })
    .index('by_hash', ['hash'])
    .index('by_kind_expires', ['kind', 'expiresAt']),

  /**
   * A self-hosted server's owners: the accounts `seed:createAdmin` made. Only
   * their invites can bring a new account onto the server without a code.
   */
  serverOwners: defineTable({
    userId: v.string()
  }).index('by_user', ['userId']),

  /** Wrong passwords per hashed email, for `signInThrottle`. Swept after the window. */
  signInFailures: defineTable({
    key: v.string(),
    at: v.number()
  })
    .index('by_key_at', ['key', 'at'])
    .index('by_at', ['at']),

  /** Account-email send log for `emailThrottle`. Swept after a day. */
  emailSends: defineTable({
    key: v.string(),
    sentAt: v.number()
  })
    .index('by_key_sent', ['key', 'sentAt'])
    .index('by_sent', ['sentAt']),

  notifyRate: defineTable({
    sourceAppId: v.id('sourceApps'),
    /** Start of the one-minute window `count` belongs to. */
    windowStart: v.number(),
    count: v.number()
  }).index('by_sourceApp', ['sourceAppId']),

  idempotencyKeys: defineTable({
    sourceAppId: v.id('sourceApps'),
    key: v.string(),
    notificationId: v.id('notifications'),
    /** Echoed back on replay so the response is byte-identical. */
    scheduledFor: v.optional(v.number()),
    /**
     * SHA-256 of the request's meaningful fields. A replay whose body differs
     * is a client bug — reusing a key for a different message — and is
     * rejected rather than silently answered with the old notification.
     */
    requestHash: v.string(),
    createdAt: v.number()
  }).index('by_app_key', ['sourceAppId', 'key']),

  notifications: defineTable({
    ownerId: v.string(),
    sourceAppId: v.id('sourceApps'),
    title: v.string(),
    body: v.string(),
    priority: v.optional(v.number()), // 1-10, maps to Expo low/default/high
    url: v.optional(v.string()),
    /**
     * Optional deep-link the device tries before `url`. Use this for custom
     * schemes (e.g. `slack://`, `shortcuts://run-shortcut?name=…`) so the tap
     * opens a native app or PWA shortcut. Falls back to `url` if the scheme
     * has no handler installed.
     */
    appUrl: v.optional(v.string()),
    data: v.optional(v.any()), // arbitrary payload passed through to the device
    /** URL of an image to attach (rendered as a thumbnail on the banner) */
    image: v.optional(v.string()),
    /**
     * Single server-defined action button. Kept for backwards compatibility
     * with /notify's original `action` field; new callers should send the
     * richer `actions` array below. If both are set, `actions` wins.
     */
    action: v.optional(
      v.object({
        label: v.string(),
        url: v.string()
      })
    ),
    /**
     * Rich interactive actions (up to 4). iOS lockscreen shows generic
     * "Action 1"/"Reply" labels because categories must be pre-registered;
     * the mobile feed renders the real labels. Each action has a stable
     * `id` echoed back when the user interacts.
     */
    actions: v.optional(
      v.array(
        v.union(
          v.object({
            kind: v.literal('open_url'),
            id: v.string(),
            label: v.string(),
            url: v.string(),
            destructive: v.optional(v.boolean())
          }),
          v.object({
            kind: v.literal('callback'),
            id: v.string(),
            label: v.string(),
            callbackUrl: v.optional(v.string()),
            destructive: v.optional(v.boolean()),
            // If true, iOS requires device unlock before the action fires.
            authRequired: v.optional(v.boolean())
          }),
          v.object({
            kind: v.literal('reply'),
            id: v.string(),
            label: v.string(),
            callbackUrl: v.optional(v.string()),
            placeholder: v.optional(v.string())
          })
        )
      )
    ),
    createdAt: v.number(),
    // Set for scheduled pushes. Retention counts from here, so a push
    // scheduled past the history window isn't swept before it's delivered.
    deliverAt: v.optional(v.number()),
    // A scheduled push that hasn't gone out yet. Kept out of the feed, the
    // widget and unread counts until it's delivered, when createdAt moves to
    // the moment it arrived.
    pending: v.optional(v.boolean()),
    // Caller-chosen key, scoped to the source app: a newer notification with
    // the same key replaces this one in the feed and on the device.
    replaceKey: v.optional(v.string()),
    replacedBy: v.optional(v.id('notifications')),
    // Sent with `critical: true`; rings as a critical alert where the app allows.
    critical: v.optional(v.boolean()),
    // On-call: who it goes to, in order, and how many of them it has reached
    // (level 0 is the first person only).
    escalation: v.optional(v.object({ order: v.array(v.string()), level: v.number() })),
    // 1 for the first notification under a key; each replacement adds one.
    revision: v.optional(v.number()),
    // Delivery tracking (aggregate; see `deliveries` table for per-device rows)
    attemptedDeviceCount: v.number(),
    successDeviceCount: v.number(),
    failureMessages: v.optional(v.array(v.string())),
    readAt: v.optional(v.number()),
    /**
     * Settled outcome per interactive action, written by `actions.invoke`.
     *
     * Denormalized onto the notification on purpose: the feed renders up to 500
     * rows and needs each button's state immediately, which a per-row query
     * into `actionEvents` would make N index reads. `actionEvents` stays the
     * append-only log (every attempt, callback status, reply text); this is the
     * one-line summary the UI binds to.
     *
     * A `callback` / `reply` action with `ok: true` here is spent — `invoke`
     * refuses to fire it a second time. A failed entry is retryable, so a flaky
     * network can't permanently brick a button.
     */
    actionResults: v.optional(
      v.array(
        v.object({
          actionId: v.string(),
          kind: v.union(v.literal('open_url'), v.literal('callback'), v.literal('reply')),
          /** Who took it — the acting member, not the source app's bill-payer. */
          by: v.string(),
          at: v.number(),
          ok: v.boolean(),
          /** Short human line for the UI ("Sent", "HTTP 502"). */
          detail: v.optional(v.string()),
          /** What was written, for a reply, so the feed can show it however it was sent. */
          reply: v.optional(v.string())
        })
      )
    ),
    // Ack-or-escalate. When `ack` is set the backend will re-push at high
    // priority every `timeoutSec` until the user acknowledges (by tapping
    // the notification, which sets `acknowledgedAt`) or `maxAttempts`
    // re-pushes have been sent.
    ack: v.optional(
      v.object({
        timeoutSec: v.number(),
        maxAttempts: v.number(),
        attempts: v.number()
      })
    ),
    acknowledgedAt: v.optional(v.number()),
    acknowledgedByDeviceId: v.optional(v.id('devices')),
    // Webhook provenance for notifications ingested via /hooks/:provider.
    webhookProvider: v.optional(v.string()),
    webhookEventType: v.optional(v.string()),

    /**
     * iOS Live Activity control. When present, the mobile app starts /
     * updates / ends an ActivityKit activity on receipt in addition to
     * showing the banner. `state` matches PushrActivityAttributes.ContentState
     * (see mobile/modules/live-activity/ios). `attributes` is only consumed
     * on `start` — it's the immutable part of the activity.
     */
    liveActivity: v.optional(
      v.object({
        action: v.union(v.literal('start'), v.literal('update'), v.literal('end')),
        // Caller-provided stable id — reused on update/end.
        activityId: v.string(),
        state: v.object({
          title: v.optional(v.string()),
          status: v.optional(v.string()),
          progress: v.optional(v.number()), // 0..1
          icon: v.optional(v.string()), // SF Symbol name
          outcome: v.optional(v.union(v.literal('success'), v.literal('failure')))
        }),
        attributes: v.optional(
          v.object({
            name: v.optional(v.string()),
            logoUrl: v.optional(v.string())
          })
        ),
        // ms-epoch when iOS should treat the activity as stale.
        staleDate: v.optional(v.number()),
        // On `end`: seconds it stays on the Lock Screen.
        dismissAfter: v.optional(v.number()),
        // 0..1 — higher shows more prominently on the lockscreen when several
        // activities are live.
        relevanceScore: v.optional(v.number())
      })
    )
  })
    .index('by_owner_created', ['ownerId', 'createdAt'])
    .index('by_sourceApp_created', ['sourceAppId', 'createdAt'])
    /**
     * Unread lookups, which are hot: the badge query is reactive, and delivery
     * recomputes a count per recipient on every push. Without this they walked
     * `by_sourceApp_created` and post-filtered on `readAt`, so an app with
     * 5,000 read notifications and 3 unread read all 5,003 rows to answer "3".
     *
     * `readAt` is optional and unread rows simply omit it — a missing field
     * indexes as `undefined`, which is exactly what `.eq('readAt', undefined)`
     * matches, so this needs no backfill. `setRead` un-reading a row patches
     * `readAt: undefined`, which lands in the same bucket.
     */
    .index('by_sourceApp_read', ['sourceAppId', 'readAt'])
    .index('by_sourceApp_replaceKey', ['sourceAppId', 'replaceKey', 'createdAt']),

  /**
   * Per-device delivery record. One row per (notification × device) the
   * backend attempted to reach. Lifecycle:
   *
   *   pending    — row inserted, request not yet sent to Expo
   *   queued     — Expo accepted the message (ticket id recorded)
   *   delivered  — Expo receipt confirmed APNs/FCM delivery
   *   failed     — Expo rejected the message OR the receipt came back error
   *   invalid    — DeviceNotRegistered; device disabled
   *
   * A notification's aggregate success counter reflects `queued` (i.e. Expo
   * accepted it). `delivered` is populated asynchronously by the receipts
   * poller ~15 min later.
   */
  deliveries: defineTable({
    notificationId: v.id('notifications'),
    deviceId: v.id('devices'),
    ownerId: v.string(),
    status: v.union(
      v.literal('pending'),
      v.literal('queued'),
      v.literal('delivered'),
      v.literal('failed'),
      v.literal('invalid')
    ),
    expoTicketId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    attempts: v.number(),
    firstAttemptAt: v.number(),
    lastAttemptAt: v.number(),
    // ms-epoch of the eventual Expo receipt (delivered/failed terminal state)
    finalizedAt: v.optional(v.number()),
    // Ack escalation round that last sent this row (0 or unset = first send).
    round: v.optional(v.number())
  })
    .index('by_notification', ['notificationId'])
    .index('by_owner', ['ownerId'])
    .index('by_ticket', ['expoTicketId'])
    // The status rollup reads deliveries as they finish.
    .index('by_finalized', ['finalizedAt']),

  /**
   * Record of every action button tap (or text reply) the user made on a
   * notification. For `callback`/`reply` kinds we also track the outbound
   * HTTP call to the source-app's callbackUrl (status code or error).
   */
  actionEvents: defineTable({
    notificationId: v.id('notifications'),
    ownerId: v.string(),
    actionId: v.string(), // user-provided action.id
    actionKind: v.union(v.literal('open_url'), v.literal('callback'), v.literal('reply')),
    deviceId: v.optional(v.id('devices')),
    reply: v.optional(v.string()),
    // Callback delivery tracking (for kind: callback | reply)
    callbackStatus: v.optional(v.number()),
    callbackError: v.optional(v.string()),
    callbackAt: v.optional(v.number()),
    createdAt: v.number()
  })
    .index('by_notification', ['notificationId'])
    .index('by_notification_action', ['notificationId', 'actionId'])
    .index('by_owner', ['ownerId']),

  /**
   * Server-side shadow of ActivityKit Live Activities. We don't drive the
   * activity ourselves (ActivityKit runs on-device) — this table just
   * records that we asked the device to start/update/end an activity, for
   * observability in the feed and per-source analytics.
   */
  /**
   * A job that pings `/heartbeat/<name>` on a schedule. Created by its first
   * ping. `dueAt` is set only while the heartbeat is up, so the minute cron
   * reads exactly the ones that can go late.
   */
  /**
   * A URL pushr checks on a schedule. `dueAt` is the next check, set while
   * it isn't paused; the minute cron claims due ones by moving it on.
   */
  uptimeChecks: defineTable({
    ownerId: v.string(),
    sourceAppId: v.id('sourceApps'),
    name: v.string(),
    /** What the app shows for it ("MCP server"); `name` stays its id in alerts and the API. */
    label: v.optional(v.string()),
    url: v.string(),
    method: v.union(v.literal('GET'), v.literal('HEAD')),
    intervalSec: v.number(),
    timeoutSec: v.number(),
    /** Text the response body must contain to count as up. */
    keyword: v.optional(v.string()),
    /** Consecutive failed checks before it's down; filters one-off blips. */
    confirmAfter: v.number(),
    status: v.union(v.literal('pending'), v.literal('up'), v.literal('down'), v.literal('paused')),
    dueAt: v.optional(v.number()),
    failures: v.number(),
    lastCheckedAt: v.optional(v.number()),
    lastStatusCode: v.optional(v.number()),
    lastLatencyMs: v.optional(v.number()),
    lastError: v.optional(v.string()),
    /** The first of the current run of failed checks, while there is one. */
    failingSince: v.optional(v.number()),
    downSince: v.optional(v.number()),
    createdAt: v.number()
  })
    .index('by_sourceApp_and_name', ['sourceAppId', 'name'])
    .index('by_dueAt', ['dueAt']),

  /** A period a heartbeat or uptime check was down, for status pages. */
  monitorIncidents: defineTable({
    sourceAppId: v.id('sourceApps'),
    monitorKind: v.union(v.literal('heartbeat'), v.literal('uptime')),
    monitorId: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    reason: v.string(),
    /** The owner's name for it on status pages; without one the page names it after its monitors. */
    title: v.optional(v.string()),
    /** When trouble began, before it was confirmed: an uptime check's first failed check, a heartbeat's missed due time. */
    firstFailedAt: v.optional(v.number()),
    /** An uptime check's answer when it went down, and when it came back. */
    statusCode: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    recoveredStatusCode: v.optional(v.number()),
    recoveredLatencyMs: v.optional(v.number())
  })
    .index('by_monitor_and_startedAt', ['monitorKind', 'monitorId', 'startedAt'])
    .index('by_startedAt', ['startedAt']),

  /** What the owner tells visitors about an incident, shown on status pages as its timeline. */
  incidentUpdates: defineTable({
    incidentId: v.id('monitorIncidents'),
    sourceAppId: v.id('sourceApps'),
    status: v.union(v.literal('investigating'), v.literal('identified'), v.literal('monitoring'), v.literal('resolved')),
    body: v.string(),
    at: v.number(),
    authorId: v.string()
  })
    .index('by_incident_and_at', ['incidentId', 'at'])
    .index('by_sourceApp_and_at', ['sourceAppId', 'at']),

  /** A public page at status.pushr.sh/<slug> showing some of an app's monitors. */
  statusPages: defineTable({
    ownerId: v.string(),
    sourceAppId: v.id('sourceApps'),
    slug: v.string(),
    title: v.string(),
    enabled: v.boolean(),
    monitors: v.array(
      v.object({
        kind: v.union(v.literal('heartbeat'), v.literal('uptime')),
        id: v.string(),
        label: v.optional(v.string()),
        // Monitors with the same group show under one heading.
        group: v.optional(v.string())
      })
    ),
    // New heartbeats and uptime checks in the app join the page.
    autoAddMonitors: v.optional(v.boolean()),
    // Branding. Unset, the page uses the source app's logo and color.
    logoStorageId: v.optional(v.id('_storage')),
    logoShape: v.optional(v.union(v.literal('circle'), v.literal('free'), v.literal('square'))),
    accent: v.optional(v.string()),
    theme: v.optional(v.union(v.literal('auto'), v.literal('light'), v.literal('dark'))),
    websiteUrl: v.optional(v.string()),
    description: v.optional(v.string()),
    announcement: v.optional(
      v.object({
        text: v.string(),
        tone: v.union(v.literal('info'), v.literal('maintenance'), v.literal('warning')),
        updatedAt: v.number()
      })
    ),
    createdAt: v.number(),
  })
    .index('by_slug', ['slug'])
    .index('by_sourceApp', ['sourceAppId'])
    .index('by_logo', ['logoStorageId']),

  heartbeats: defineTable({
    ownerId: v.string(),
    sourceAppId: v.id('sourceApps'),
    name: v.string(),
    /** What the app shows for it ("Nightly backup"); `name` stays its id in pings and alerts. */
    label: v.optional(v.string()),
    everySec: v.number(),
    graceSec: v.number(),
    status: v.union(v.literal('up'), v.literal('down'), v.literal('paused')),
    dueAt: v.optional(v.number()),
    lastPingAt: v.optional(v.number()),
    lastStartedAt: v.optional(v.number()),
    lastDurationMs: v.optional(v.number()),
    downSince: v.optional(v.number()),
    downReason: v.optional(v.union(v.literal('late'), v.literal('failed'))),
    lastMessage: v.optional(v.string()),
    createdAt: v.number()
  })
    .index('by_sourceApp_and_name', ['sourceAppId', 'name'])
    .index('by_dueAt', ['dueAt']),

  liveActivities: defineTable({
    ownerId: v.string(),
    sourceAppId: v.id('sourceApps'),
    // Caller-provided id reused across start/update/end.
    activityId: v.string(),
    startedAt: v.number(),
    lastUpdateAt: v.number(),
    endedAt: v.optional(v.number()),
    // Most recent state the server asked the device to render. Useful
    // debugging surface when an activity is stuck.
    lastState: v.optional(v.any()),
    lastAttributes: v.optional(v.any()),
    // ActivityKit-assigned UUID for this activity, reported by the device
    // after `Activity.request`. Used to correlate update-token callbacks.
    nativeActivityId: v.optional(v.string()),
    // Per-activity APNs update token (iOS 16.2+). Required to push updates
    // and ends once the activity is running. Reported by the device via
    // `activity.pushTokenUpdates` after the push-to-start handshake.
    pushUpdateToken: v.optional(v.string()),
    pushUpdateTokenAt: v.optional(v.number()),
    // Which device originally started the activity — for observability and
    // because update tokens are per-device.
    deviceId: v.optional(v.id('devices'))
  })
    .index('by_owner_activity', ['ownerId', 'activityId'])
    // Members of a shared app report update tokens for activities owned by
    // the app's bill-payer, so the lookup can't be owner-scoped.
    .index('by_activity', ['activityId'])
    .index('by_owner_started', ['ownerId', 'startedAt'])
    // Retention sweep. A reused activityId restarts its existing row, so
    // creation order says nothing about how recently it ran.
    .index('by_started', ['startedAt'])
    .index('by_sourceApp', ['sourceAppId'])
    .index('by_native_activity_id', ['nativeActivityId']),

});
