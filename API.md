# pushr HTTP API

Every endpoint lives at your Convex deployment's site URL —
`https://<your-deployment>.convex.site` — and is referenced below as
`$PUSHR_URL`. Every authenticated endpoint takes a source-app bearer token
(`pshr_…`) created from the mobile app's **Apps** tab and referenced as
`$PUSHR_TOKEN`.

## Self-hosting

pushr's backend is open source. You can run it on your own Convex
deployment and point the iPhone app at it, so your notifications never touch
pushr's servers. Self-hosted backends have no quotas or plans: every feature
is unlocked, for free.

### What you need

- [Bun](https://bun.sh) and a free [Convex](https://convex.dev) account.
- The pushr iPhone app.
- The [`pushr-backend`](https://github.com/cpreston321/pushr-backend) source.

### 1. Create your deployment

```bash
git clone https://github.com/cpreston321/pushr-backend
cd pushr-backend
bun install
bun run dev
```

The first `bun run dev` signs you in to Convex, creates a deployment and
pushes the schema and functions. It writes `CONVEX_URL` (ends in
`.convex.cloud`) and `CONVEX_SITE_URL` (ends in `.convex.site`) to
`.env.local`. You'll need both.

### 2. Set the server secrets

These live in the Convex deployment, not in `.env.local`:

```bash
bunx convex env set BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
bunx convex env set SITE_URL "https://<your-deployment>.convex.site"
```

### 3. Create your account

```bash
bunx convex run seed:createAdmin '{"email":"you@example.com","password":"<a strong password>"}'
```

### 4. Connect the app

1. In pushr, open **Settings → Server**.
2. Under **Custom Convex Deployment**, paste your `.convex.cloud` URL and your
   `.convex.site` URL.
3. Tap **Test connection**. It checks that `/healthz` answers from your
   deployment.
4. Make a connection code on the computer you deploy from, and type it into
   the app:

   ```bash
   bunx convex run pairing:createCode
   # { "code": "P4QM-2B2V", "expiresInMinutes": 15 }
   ```

5. Tap **Save & sign out**. The app switches to your server right away;
   sign in with the account from step 3.

#### Connection codes

A self-hosted server only accepts new accounts that its owner lets in, so it
can't quietly turn into a public pushr. Only someone with access to the
Convex deployment can run `pairing:createCode`. Each code:

- lasts 15 minutes and works once;
- lets **one** new account sign up, in the app or with Sign in with Apple, within the next hour;
- isn't needed for accounts that already exist, or for ones you make with
  `seed:createAdmin`.

After 20 wrong codes in 15 minutes, `/pair` refuses every code until the
window passes.

To go back, return to the same screen and tap **Use pushr cloud**.

### 5. Send a push

Create a source app in the **Apps** tab and copy its token, then:

```bash
curl -X POST "https://<your-deployment>.convex.site/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","body":"from my own server"}'
```

### Updating

Pull the latest source and run `bun run deploy` to push it to your
production deployment, or `bun run push` for your dev deployment. Schema
changes deploy with the functions; there's no separate migration step.

### Differences from pushr cloud

- **Live Activities are not available** with the App Store app. Starting and
  updating them needs an APNs key from the team that publishes the app.
  Everything else (pushes, actions, ack-or-escalate, widgets, webhooks)
  works.
- **Delivery goes through Expo's push service,** the same as pushr cloud.
  Your server only needs outbound HTTPS.
- **Plans don't apply.** Pro features are on for every account on your
  deployment.
- **Sign in with Apple works,** but deleting an account can't revoke the Apple
  sign-in (that needs the publisher's key), and Hide My Email addresses only
  get email if your sending domain is registered with Apple.

---

## Endpoints at a glance

| Method | Path                  | Purpose                                              | Auth                                |
| ------ | --------------------- | ---------------------------------------------------- | ----------------------------------- |
| POST   | `/notify`             | Send a notification                                  | `Authorization: Bearer $PUSHR_TOKEN` |
| POST   | `/hooks/github`       | GitHub webhook adapter                               | Bearer **or** `?token=`             |
| POST   | `/hooks/sentry`       | Sentry webhook adapter                               | Bearer **or** `?token=`             |
| POST   | `/hooks/grafana`      | Grafana webhook adapter                              | Bearer **or** `?token=`             |
| GET    | `/healthz`            | Health check; `selfHosted: true` on your deployment  | none                                |
| POST   | `/pair`               | Trade a connection code for a sign-up grant (used by the app) | none                       |

---

## `POST /notify`

Sends one notification to every device the source app's owner has
registered (and to every accepted member's devices, if the app is shared).

### Request

```
POST /notify
Authorization: Bearer pshr_…
Content-Type: application/json
```

#### Required fields

| Field   | Type   | Notes                                                                |
| ------- | ------ | -------------------------------------------------------------------- |
| `title` | string | Banner title.                                                        |
| `body`  | string | Banner body. **Or** `message` (Gotify-compatible alias).             |

#### Optional fields

| Field           | Type                       | Notes                                                                                                                                                                                                                                            |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `priority`      | number 1–10 \| string      | `1`–`6` and `"low"`/`"normal"` deliver at default priority. `7`–`10` and `"high"` wake the device with a high-priority push. Defaults to normal.                                                                                                |
| `url`           | string                     | Tapping the banner opens this URL.                                                                                                                                                                                                               |
| `data`          | object                     | Arbitrary JSON delivered alongside the push (forwarded to the app's notification handler).                                                                                                                                                       |
| `image`         | string                     | URL of an image to attach as a banner thumbnail.                                                                                                                                                                                                 |
| `action`        | object                     | Single action button (legacy). `{ label: string, url: string }`. Replaced by `actions` if both are set.                                                                                                                                          |
| `actions`       | array (max 4)              | Rich interactive actions — see [Action buttons](#action-buttons).                                                                                                                                                                                |
| `ack`           | object                     | Ack-or-escalate alarm — see [Ack-or-escalate](#ack-or-escalate).                                                                                                                                                                                  |
| `liveActivity`  | object                     | Drive an iOS Live Activity — see [Live Activities](#live-activities).                                                                                                                                                                            |
| `deliverAt`     | number (ms-epoch)          | Schedule the push for a future time. Must be ≥ now − 60 s.                                                                                                                                                                                       |

### Response

```json
{ "id": "j97...", "scheduledFor": null }
```

Status codes:

| Code | Body                                                                                              | When                                            |
| ---- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 202  | `{ id, scheduledFor }`                                                                            | Accepted. `scheduledFor` is the `deliverAt` ms-epoch (or `null`). |
| 200  | `{ id, scheduledFor }` plus an `Idempotent-Replay: true` header                                   | A retry with an `Idempotency-Key` already used. Nothing is sent again. |
| 400  | `{ error: "<reason>" }`                                                                           | Validation error (missing fields, bad shape).   |
| 401  | `{ error: "Invalid token" }` / `"Missing bearer token"`                                           | Bad or absent token.                            |
| 403  | `{ error: "Source app disabled" }`                                                                | Token is valid but the app was disabled.        |
| 409  | `{ error, code: "IDEMPOTENCY_KEY_REUSED" }`                                                       | The `Idempotency-Key` was used with a different payload. |
| 429  | `{ error, code: "QUOTA_EXCEEDED", tier, count, limit }`                                           | pushr cloud only: the monthly push limit is reached. See [Rate limits and quotas](#rate-limits-and-quotas). |
| 500  | `{ error: "<message>" }`                                                                          | Unexpected server error.                        |

### Retries and `Idempotency-Key`

Send an `Idempotency-Key` header (any string up to 255 characters, such as a
job id or UUID) to make retries safe:

```bash
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -H "Idempotency-Key: deploy-482-finished" \
  -d '{"title":"Deploy #482 finished"}'
```

- A retry with the same key and the same body returns the original `id` with
  `200` and `Idempotent-Replay: true`. It isn't pushed again and doesn't count
  toward your quota.
- The same key with a different body is a `409`, because that's a bug in the
  sender, not a retry.
- Keys are per source app and are remembered for 24 hours.

### Minimal example

```bash
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Build succeeded",
    "body":  "ci.example.com / main → staging"
  }'
```

### Priority

```bash
# Wake the device — banner + sound:
-d '{"title":"DB disk > 90%","body":"prod","priority":"high"}'

# Numeric (Gotify-style 1-10):
-d '{"title":"FYI","body":"nightly backups complete","priority":4}'
```

Priority also sets how hard the push may interrupt on iOS:

| Priority                       | iOS interruption level | Effect                                              |
| ------------------------------ | ---------------------- | --------------------------------------------------- |
| `1`–`3`, `"low"`               | passive                | Lands quietly in Notification Center, no screen wake |
| `4`–`6`, `"normal"` (default)  | active                 | A normal banner and sound                            |
| `7`–`10`, `"high"`             | time-sensitive         | Breaks through Focus and the notification summary    |
| any push with `ack`            | time-sensitive         | Same, for every re-push until acknowledged           |

During a source app's quiet hours, pushes are delivered as passive unless they
need acknowledgment.

### Open URL on tap

```bash
-d '{
  "title": "PR #42 merged",
  "body":  "from peptide",
  "url":   "https://github.com/owner/repo/pull/42"
}'
```

### Image attachment

```bash
-d '{
  "title": "New deploy",
  "body":  "Build #382 passed",
  "image": "https://ci.example.com/badges/build-382.png"
}'
```

### Action buttons

Up to **4 actions**. Three kinds:

```jsonc
{
  "title": "Staging deploy ready",
  "body":  "Merge main → staging?",
  "actions": [
    {
      "kind": "callback",
      "id": "approve",
      "label": "Approve",
      "callbackUrl": "https://ci.example.com/deploy/42/approve"
    },
    {
      "kind": "callback",
      "id": "reject",
      "label": "Reject",
      "callbackUrl": "https://ci.example.com/deploy/42/reject",
      "destructive": true
    },
    {
      "kind": "open_url",
      "id": "logs",
      "label": "View logs",
      "url": "https://ci.example.com/deploy/42"
    },
    {
      "kind": "reply",
      "id": "comment",
      "label": "Reply",
      "callbackUrl": "https://ci.example.com/deploy/42/comment",
      "placeholder": "Add a note…"
    }
  ]
}
```

| `kind`     | Behavior                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `open_url` | Opens `url` when tapped. Recorded as an event server-side.                                            |
| `callback` | POSTs to `callbackUrl`. HTTP status stored on the action event. Optional `authRequired` to lock-gate. |
| `reply`    | iOS inline text reply. POSTs `{ reply, ... }` to `callbackUrl`. Optional `placeholder`.               |

#### Callback request shape

When the user taps a `callback` or `reply` action, pushr POSTs to your
`callbackUrl`:

```
POST /your/endpoint
Content-Type: application/json
User-Agent: pushr/1.0
X-Pushr-Source: pushr
X-Pushr-Notification: <notificationId>
X-Pushr-Action: <action.id>

{
  "notificationId": "...",
  "actionId":       "approve",
  "respondedAt":    1712160000000,
  "reply":          "LGTM"          ← only for kind=reply
}
```

`callbackUrl` must be a public `https://` URL: localhost, private-network
and link-local addresses are rejected, and redirects are not followed. pushr
records only the response status, never the body. Viewers on a shared app
can open links but can't run callbacks or replies.

Outbound action callbacks are unsigned. To authenticate the request,
embed a bearer token in the `callbackUrl` itself (e.g.
`https://api.example.com/hook?key=…`) or terminate the URL on a server
that already trusts pushr's egress IP / origin.

> Inbound webhook signing (provider → pushr) is unrelated and configured
> per provider — see [Webhook adapters → Signing secrets](#webhook-adapters)
> below.

#### Caveat: lockscreen labels

iOS requires notification categories to be pre-registered, so the
**lockscreen** banner shows generic labels (`Action 1`, `Action 2`,
`Reply`). The **mobile feed** renders the real labels you sent and is
where users normally respond.

### Ack-or-escalate

Turn a notification into an on-call-style alarm that re-pushes at high
priority — ignoring quiet hours and source-app mutes — until the user
taps it.

```jsonc
{
  "title":    "DB disk > 90%",
  "body":     "homelab/prod",
  "priority": "high",
  "ack": {
    "timeoutSec":  60,        // 10–86400, seconds between re-pushes
    "maxAttempts": 5          // 1–20, total re-pushes after the initial send
  }
}
```

Tapping the notification (or opening its `url`) acknowledges it and stops
the loop. Un-acked notifications are listed at the top of the feed with an
"ack needed" badge.

### Scheduled delivery

```jsonc
{
  "title":     "Standup",
  "body":      "Time to gather",
  "deliverAt": 1714435200000   // ms-epoch
}
```

Returns `202 { id, scheduledFor }` immediately; delivery happens at the
target time via the Convex scheduler.

### Live Activities

Drive iOS lockscreen / Dynamic Island progress indicators. Three actions:
`start` / `update` / `end`, all keyed by your own `activityId`.

```jsonc
{
  "title": "Deploy #42",
  "body":  "Building",
  "liveActivity": {
    "action":     "start",                    // start | update | end
    "activityId": "deploy-42",                // caller-chosen, reused for update/end
    "attributes": { "name": "ci.example.com" }, // immutable, only on start
    "state": {                                  // mutable ContentState
      "title":    "Deploy #42",
      "status":   "Running tests",
      "progress": 0.35,                         // 0..1, omit for indeterminate
      "icon":     "hammer.fill"                 // SF Symbol name
    },
    "staleDate":      1712200000000,            // ms-epoch (optional)
    "relevanceScore": 0.8                       // 0..1 (optional)
  }
}
```

Update:

```json
{
  "title": "Deploy #42",
  "body":  "Deploying to staging",
  "liveActivity": {
    "action":     "update",
    "activityId": "deploy-42",
    "state":      { "title": "Deploy #42", "status": "Deploying", "progress": 0.85 }
  }
}
```

End:

```json
{
  "title": "Deploy #42",
  "body":  "Shipped 🎉",
  "liveActivity": {
    "action":     "end",
    "activityId": "deploy-42",
    "state":      { "title": "Deploy #42", "status": "Complete", "progress": 1.0 }
  }
}
```

`start` requires the device to have registered a push-to-start token (the
mobile client does this on first launch). `update`/`end` can fire even if
the app is terminated. Set the `APNS_*` environment variables on your
Convex deployment to enable this end-to-end (see `.env.example`).

If `APNS_AUTH_KEY` isn't configured, the `liveActivity` field is silently
ignored and the regular push still delivers normally.

### Gotify-style fallback

If you're migrating from Gotify, pushr accepts the alternate field names
without code changes:

```bash
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -d '{
    "title":    "Backup failed",
    "message":  "exit 2",
    "priority": 8,
    "extras":   { "client::notification": { "click": { "url": "https://homelab.lan" } } }
  }'
```

`message` maps to `body`; `extras["client::notification"].click.url` maps
to `url`.

---

## Webhook adapters

Forward provider webhooks straight to pushr without writing glue code.
Adapters normalize the provider payload into the same internal shape and
flow through the same delivery / quota / ack plumbing.

```
POST /hooks/github?token=$PUSHR_TOKEN
POST /hooks/sentry?token=$PUSHR_TOKEN
POST /hooks/grafana?token=$PUSHR_TOKEN
```

Auth: either `Authorization: Bearer $PUSHR_TOKEN` (when the provider lets
you customize headers) or `?token=$PUSHR_TOKEN` in the query string.

### GitHub

Paste `$PUSHR_URL/hooks/github?token=$PUSHR_TOKEN` into your repo or org
webhook settings. Content type **application/json**. Subscribe to events
you care about:

| Event             | Title                                  | Priority |
| ----------------- | -------------------------------------- | -------- |
| `push`            | "{repo} — N commits to {branch}"       | normal   |
| `pull_request`    | "PR #N: {title}"                       | normal   |
| `issues`          | "Issue #N: {title}"                    | normal   |
| `release`         | "{repo} released {tag_name}"           | normal   |
| `workflow_run`    | "{name} {conclusion}"                  | high if `conclusion == "failure"` |
| `check_run`       | similar to workflow_run                | high on failure |
| `deployment_status` | "{environment} {state}"              | high on `failure` |

Open the source app in the iOS app → **API & token** → **Webhook
integrations** → tap **GitHub** and paste the same secret you configured
in GitHub. Pushr verifies `X-Hub-Signature-256` on every delivery; mismatches
return `401`.

### Sentry

Add an Internal Integration (or legacy plugin webhook) at
`/hooks/sentry?token=…`. Severity maps to pushr priority:

| Sentry level | pushr priority |
| ------------ | -------------- |
| debug        | 2              |
| info         | 4              |
| warning      | 6              |
| error        | 8              |
| fatal        | 9              |

To verify Sentry signatures, set the same client secret in **API & token →
Webhook integrations → Sentry**. Pushr verifies `Sentry-Hook-Signature`
(bare hex HMAC-SHA256 of the raw body) on every delivery.

### Grafana

Contact point → Webhook → URL `$PUSHR_URL/hooks/grafana?token=…`. The
adapter collapses the alert batch into one push titled
`<ruleName> (<n> firing)`. `commonLabels.severity` maps to priority the
same way Sentry levels do. Grafana doesn't HMAC-sign webhook payloads, so
the bearer token is the only authenticator — keep the URL private.

### Signing secrets

A single source app can be wired to multiple providers — each with its own
signing secret. Configure them independently in **API & token → Webhook
integrations**.

| Provider | Header                  | Format         | Notes                  |
| -------- | ----------------------- | -------------- | ---------------------- |
| GitHub   | `X-Hub-Signature-256`   | `sha256=<hex>` | Required when set      |
| Sentry   | `Sentry-Hook-Signature` | bare `<hex>`   | Required when set      |
| Grafana  | —                       | —              | Bearer-only (no signing) |

When a secret is set for a provider that supports signing, every inbound
delivery to `/hooks/{provider}` must carry a valid signature or pushr
returns `401 { error: "Invalid signature" }`. Clearing the secret falls
back to bearer-only auth.

### Adapter response

| Code | Body                          | When                                                      |
| ---- | ----------------------------- | --------------------------------------------------------- |
| 202  | `{ id, scheduledFor: null }`  | Adapter normalized the event and the push was queued.    |
| 200  | `{ ignored: true, provider }` | The adapter chose to ignore this event (e.g. GitHub `ping`). |
| 401  | `{ error: "Invalid signature" }` | HMAC verification failed for a provider with a configured signing secret. |
| 401 / 400 / 429 / 500 | (same as `/notify`)  |                                                           |

---

## `GET /healthz`

```
GET /healthz
```

```json
{ "ok": true }
```

Use this from a monitor to check that your deployment is reachable.

---

## Source-app token format

Tokens always start with `pshr_` followed by a base64url payload. They're
shown **once** at creation time in the mobile app's **Apps** tab — the
server only stores the `sha256(token)` hash. Revoking an app rotates the
hash and immediately invalidates the token.

`tokenPrefix` (e.g. `pshr_abcd1234`) is safe to display in logs and CI
config; the full token is not.

---

## Rate limits and quotas

**Self-hosted:** there are no plans or quotas. Every account on your deployment
gets everything, and the only ceiling is Convex's own function limits.

**pushr cloud:**

| | Free | Pro |
| --- | --- | --- |
| Pushes per month | 100 | 10,000 |
| Source apps | 1 | Unlimited |
| History | 7 days | 90 days |
| People per shared app | 1 | Unlimited |
| Quiet hours, Slack and Discord forwarding | No | Yes |

Past the monthly limit, `/notify` answers `429`:

```json
{
  "error": "Monthly quota exceeded",
  "code": "QUOTA_EXCEEDED",
  "tier": "free",
  "count": 100,
  "limit": 100
}
```

The count resets at the start of each month (UTC). Replays with an
`Idempotency-Key` don't count.
