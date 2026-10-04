# pushr HTTP API

Every endpoint lives at your server's site URL, referenced below as
`$PUSHR_URL`. On pushr cloud, the app's **API & token** sheet shows it and
can copy a ready-to-run curl example; self-hosted, it's your Convex
deployment's `https://<your-deployment>.convex.site`. Every authenticated endpoint takes a source-app bearer token
(`pshr_…`) created from the mobile app's **Apps** tab and referenced as
`$PUSHR_TOKEN`.

---

## Endpoints at a glance

<!-- endpoints-glance -->
| Method | Path                  | Purpose                                              | Auth                                |
| ------ | --------------------- | ---------------------------------------------------- | ----------------------------------- |
| POST   | `/notify`             | Send a notification                                  | `Authorization: Bearer $PUSHR_TOKEN` |
| POST   | `/hooks/github`       | GitHub webhook adapter                               | Bearer **or** `?token=`             |
| POST   | `/hooks/sentry`       | Sentry webhook adapter                               | Bearer **or** `?token=`             |
| POST   | `/hooks/grafana`      | Grafana webhook adapter                              | Bearer **or** `?token=`             |
| GET, POST | `/heartbeat/<name>` | A job checked in; also `/start` and `/fail`          | `Authorization: Bearer $PUSHR_TOKEN` |
| DELETE | `/heartbeat/<name>`   | Stop watching a heartbeat                            | `Authorization: Bearer $PUSHR_TOKEN` |
| PUT, GET, DELETE | `/uptime/<name>` | Create, read or remove an uptime check          | `Authorization: Bearer $PUSHR_TOKEN` |
| GET    | `/status-page/<slug>` | A status page's public data                          | none                                |
| GET    | `/healthz`            | Health check, backend version and server features    | none                                |
| POST   | `https://mcp.pushr.sh` | The MCP server for [AI agents](#connect-ai-agents) (pushr cloud) | OAuth, set up by the agent        |

Self-hosted servers also answer `POST /pair`, which the app uses to redeem a connection code; see [Self-hosting](#self-hosting).
<!-- /endpoints-glance -->

---

## `POST /notify`

Sends one notification to every device the source app's owner has
registered (and to every accepted member's devices, if the app is shared).

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

### Request

```
POST /notify
Authorization: Bearer pshr_…
Content-Type: application/json
```

<!-- notify-fields -->
#### Required fields

| Field   | Type   | Notes                                                                |
| ------- | ------ | -------------------------------------------------------------------- |
| `title` | string | Banner title.                                                        |
| `body`  | string | Banner body. **Or** `message` (Gotify-compatible alias).             |

#### Content

| Field | Type | Notes |
| ----- | ---- | ----- |
| `url` | string | Tapping the banner opens this URL. See [Links and images](#links-and-images). |
| `data` | object | Arbitrary JSON delivered alongside the push (forwarded to the app's notification handler). Up to 4 KB as JSON, nested at most 8 levels, with no keys that start with `$`. A push must fit in Apple's 4 KB: if it wouldn't, `data` is left out of the push itself and then the body shortened; the app still shows both in full. |
| `image` | string | URL of an image to attach as a banner thumbnail. See [Links and images](#links-and-images). |
| `action` | object | Single action button (legacy). `{ label: string, url: string }`. Replaced by `actions` if both are set. |
| `replaceKey` | string (max 128) | A newer notification with the same key replaces this one, on the phone and in the feed. See [Replace keys](#replace-keys). |

#### Delivery

| Field | Type | Notes |
| ----- | ---- | ----- |
| `priority` | number 1–10 \| string | `1`–`6` and `"low"`/`"normal"`/`"default"` deliver at default priority. `7`–`10` and `"high"` wake the device with a high-priority push. Defaults to normal. Anything else is a `400`. See [Priority and interruption](#priority-and-interruption). |
| `deliverAt` | number (ms-epoch) | Schedule the push for a future time. Must be ≥ now − 60 s and within the next 365 days. Must be a number: an ISO string is ignored and the push sends at once. On pushr cloud, counts toward your monthly quota when accepted. See [Scheduled delivery](#scheduled-delivery). |
| `ack` | object | Ack-or-escalate alarm — see [Ack-or-escalate](#ack-or-escalate). |
| `critical` | boolean | Ring through mute and Do Not Disturb, where the source app allows critical alerts. See [Critical alerts](#critical-alerts). |

#### Interaction

| Field | Type | Notes |
| ----- | ---- | ----- |
| `actions` | array (max 4) | Rich interactive actions — see [Action buttons](#action-buttons). |
| `liveActivity` | object | Drive an iOS Live Activity — see [Live Activities](#live-activities). |
<!-- /notify-fields -->

### Response

<!-- notify-response -->
```json
{ "id": "j97...", "scheduledFor": null }
```

| Code | Body | When |
| ---- | ---- | ---- |
| 202  | `{ id, scheduledFor }`                                                                            | Accepted. `scheduledFor` is the `deliverAt` ms-epoch (or `null`). |
| 200  | `{ id, scheduledFor }` plus an `Idempotent-Replay: true` header                                   | A retry with an `Idempotency-Key` already used. Nothing is sent again. |

Anything else is an error; see [Errors and retries](#errors-and-retries).
<!-- /notify-response -->

---

## Guides

Each one is a field (or two) on `POST /notify`.

### Priority and interruption

```bash
# Wake the device — banner + sound:
-d '{"title":"DB disk > 90%","body":"prod","priority":"high"}'

# Numeric (Gotify-style 1-10):
-d '{"title":"FYI","body":"nightly backups complete","priority":4}'
```

<!-- priority-demo --><!-- /priority-demo -->

Priority also sets how hard the push may interrupt on iOS:

| Priority                       | iOS interruption level | Effect                                              |
| ------------------------------ | ---------------------- | --------------------------------------------------- |
| `1`–`3`, `"low"`               | passive                | Lands quietly in Notification Center, no screen wake |
| `4`–`6`, `"normal"` (default)  | active                 | A normal banner and sound                            |
| `7`–`10`, `"high"`             | time-sensitive         | Breaks through Focus and the notification summary    |
| any push with `ack`            | time-sensitive         | Same, for every re-push until acknowledged           |
| critical, where the app allows it | critical            | Plays its sound even with the ringer off or in Do Not Disturb |

During a source app's quiet hours, pushes are delivered as passive unless they
need acknowledgment.

### Links and images

```bash
-d '{
  "title": "PR #42 merged",
  "body":  "from peptide",
  "url":   "https://github.com/owner/repo/pull/42"
}'
```

```bash
-d '{
  "title": "New deploy",
  "body":  "Build #382 passed",
  "image": "https://ci.example.com/badges/build-382.png"
}'
```


<!-- links-demo --><!-- /links-demo -->

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

#### Decisions: one answer per notification

The `callback` actions on a notification are treated as one choice, like
Approve or Reject. Once one of them has gone through, the others are
refused (`"Already answered"`), whether the second tap comes from the feed,
the Lock Screen or another device, so your endpoint hears exactly one
answer. A callback that fails (a network error or a 4xx/5xx from your
endpoint) leaves the choice open to retry or change. `reply` and `open_url`
actions aren't part of the decision and keep working afterwards.

In the app's feed, the callbacks sit together as a full-width pair: the
first one that isn't `destructive` is the suggested action, and a
`destructive` one is shown in red. Once answered, the pair becomes a single
line with the answer and when it was given. Links and replies sit under
the pair as smaller buttons. So for a yes/no question, send one callback
for each answer and mark the risky one `destructive`:

```jsonc
"actions": [
  { "kind": "callback", "id": "approve", "label": "Approve", "callbackUrl": "https://ci.example.com/deploy/42/approve" },
  { "kind": "callback", "id": "reject",  "label": "Reject",  "callbackUrl": "https://ci.example.com/deploy/42/reject", "destructive": true },
  { "kind": "open_url", "id": "logs",    "label": "View logs", "url": "https://ci.example.com/deploy/42" }
]
```

If you need several independent buttons rather than one answer, send them
as separate notifications.

<!-- actions-demo --><!-- /actions-demo -->

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
that already trusts the server's egress IP (pushr cloud's, or your own
Convex deployment's if you self-host).

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
priority — ignoring quiet hours — until the user taps it. A muted source
app stays silent.

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

<!-- ack-demo --><!-- /ack-demo -->

Tapping the notification (or opening its `url`) acknowledges it and stops
the loop. Un-acked notifications are listed at the top of the feed with an
"ack needed" badge.

### On-call escalation

When a source app is shared with teammates, its owner can set an on-call
rotation in the app (source app → **On-call**). An urgent push then reaches
the first person on call only, and one more person each time it goes
unacknowledged, instead of waking everyone at once.

<!-- oncall-demo --><!-- /oncall-demo -->

- **Urgent** means a push with `ack`, or priority `7` or higher. Everything
  else still goes to everyone on the app.
- Each round waits the push's `ack.timeoutSec`, or the app's **Escalate
  after** time (1 to 60 minutes) when the push has no `ack`. pushr adds an
  ack loop long enough to reach everyone on the rotation.
- Acknowledging on any phone stops it for everyone.
- **Weekly rotation** moves who's first along by one person each week.
- Heartbeat and uptime alerts escalate the same way; their recoveries go to
  everyone.
- On-call is a Pro feature on pushr cloud, and needs at least two people
  and at most 10.

Nothing changes in the request: the same `/notify` call pages one person or
everyone, depending on the app's settings.

### Critical alerts

A critical alert plays its sound even when the phone is muted or in Do Not
Disturb, like a severe weather alert. Because it overrides the user's own
settings, the sender can't turn it on alone: the source app's owner chooses
in the app (source app → **Critical alerts**) which pushes may ring through:

| Setting | What rings through |
| ------- | ------------------ |
| Off (default) | Nothing |
| Marked critical | Pushes sent with `"critical": true` |
| All urgent | Those, plus every push with `ack` or priority `7`+, including heartbeat and uptime alerts |

```jsonc
{ "title": "Freezer above -10°C", "body": "Walk-in #2 · 4°C", "priority": "high", "critical": true }
```

- Critical alerts ignore quiet hours. A **muted** source app stays silent.
- Each phone also asks its owner's permission the first time it's turned on.
- iOS rings through mute only once Apple has approved pushr's critical-alerts
  entitlement. Until then these pushes arrive as time-sensitive.
- Critical alerts are a Pro feature on pushr cloud.

### Replace keys

Some notifications describe a state that keeps changing: disk usage, a
deploy, a queue's depth. Give them the same `replaceKey` and each one
replaces the last instead of stacking up.

```jsonc
{ "title": "Disk 91%", "body": "db-1 /var", "replaceKey": "disk-db-1" }
// …later
{ "title": "Disk 97%", "body": "db-1 /var", "priority": "high", "replaceKey": "disk-db-1" }
// …and once it's fixed
{ "title": "Disk OK",  "body": "db-1 /var · 62%", "replaceKey": "disk-db-1" }
```

<!-- replace-demo --><!-- /replace-demo -->

- **On the phone,** the earlier notification is removed from Notification
  Center when the new one arrives, so the Lock Screen shows only the latest.
- **In the feed,** only the latest shows, marked *Updated 2×*. Tap it to see
  the timeline of earlier versions with their times.
- **The badge** counts the latest only: replaced versions are marked read.
- Each push is still a full notification, with its own sound, priority and
  quota. Use a lower priority for routine updates and `high` when it gets
  worse.
- Keys are per source app, so two apps can use the same key safely.
- Send a key at most every few seconds. Many sends a second under one key
  contend with each other and some can fail with a `500`; for that pace,
  use a Live Activity.
- A scheduled push (`deliverAt`) replaces its predecessor when it's
  delivered, not when you send it.
- An `ack` stops escalating once its notification is replaced.
- Deleting the latest version from the feed deletes its timeline too.

For progress you want to watch live, such as a build, use a
[Live Activity](#live-activities) instead. A replace key suits things that
change every few minutes or hours, where a notification for each change is
worth it.

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


<!-- schedule-demo --><!-- /schedule-demo -->

### Live Activities

Drive iOS lockscreen / Dynamic Island progress indicators. Three actions:
`start` / `update` / `end`, all keyed by your own `activityId`. `state` is
required on every action, and `progress` must be between 0 and 1.

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

A push with `liveActivity` shows as the Live Activity instead of a
notification banner, so each step doesn't arrive twice; every step still
appears in the feed. The banner is sent instead only when the activity can't
be shown: `APNS_AUTH_KEY` isn't configured, no device has a push-to-start
token, or Apple rejects the start for every device. Updates and ends never
send a banner.

#### Ending, and failing

End with `"outcome": "failure"` in `state` and the activity turns red so
it can't be mistaken for a running one: a solid red **Failed** label, a red
glow, an ✕ beside the status, and the bar and ring stopped in red where the
job failed.

```jsonc
{
  "title": "Build #43",
  "body":  "3 tests failed",
  "liveActivity": {
    "action":     "end",
    "activityId": "build-43",
    "state":      { "status": "3 tests failed", "progress": 0.55, "icon": "xmark.octagon.fill", "outcome": "failure" }
  }
}
```

| `state.outcome` | Shows as | Stays on the Lock Screen |
| --------------- | -------- | ------------------------ |
| `"success"`, or a full bar with no outcome | Done, green | 15 minutes |
| `"failure"` | Failed, red | Until dismissed, up to iOS's 4 hours |

`dismissAfter` on an `end` sets how long a finished activity stays instead,
in seconds from `0` (gone at once) to `14400`. A failure ignores it and stays
until it's dismissed, so a failed job is never cleared before someone sees it. Always end an activity, failure included: one
that's never ended stays until iOS removes it, still saying it's running.

<!-- live-demo --><!-- /live-demo -->

#### Choosing an icon

`state.icon` is the name of any [SF Symbol](https://developer.apple.com/sf-symbols/),
Apple's icon set. It shows in the Dynamic Island and beside the status on the
Lock Screen, so pick one that says what the job is. Filled symbols (`….fill`)
read best at that size. Leave it out, or send a name iOS doesn't know, and the
Dynamic Island shows the initial of `attributes.name` instead.

<!-- icon-picker -->
| Job | Icons |
| --- | --- |
| Builds and deploys | `hammer.fill` `gearshape.2.fill` `terminal.fill` `testtube.2` `server.rack` |
| Transfers and backups | `arrow.up.circle.fill` `arrow.down.circle.fill` `arrow.triangle.2.circlepath` `externaldrive.fill` |
| Orders and deliveries | `shippingbox.fill` `box.truck.fill` `cart.fill` `creditcard.fill` `fork.knife` |
| Time and tracking | `timer` `hourglass` `calendar` `flag.checkered` `figure.run` |
| Home and devices | `house.fill` `lightbulb.fill` `thermometer.medium` `bolt.fill` `printer.fill` |
| Media | `play.fill` `film.fill` `music.note` `camera.fill` |
| Status | `checkmark.circle.fill` `xmark.octagon.fill` `exclamationmark.triangle.fill` `sparkles` |
<!-- /icon-picker -->

---

## Heartbeats

A heartbeat catches the failure no notification can report: a job that
silently stopped running. Your job pings pushr each time it finishes, and
pushr pushes to your phone when a ping is late, or when the job reports a
failure. When it pings again, a recovery replaces the alert.

```bash
# crontab: back up at 03:00 and check in afterwards
0 3 * * * /usr/local/bin/backup.sh && curl -fsS -H "Authorization: Bearer $PUSHR_TOKEN" "$PUSHR_URL/heartbeat/nightly-backup?every=1d"
```

<!-- heartbeat-demo --><!-- /heartbeat-demo -->

The first ping creates the heartbeat, so there's nothing to set up in the
app. It's watched from then on.

### Endpoints

| Request | Meaning |
| ------- | ------- |
| `GET` or `POST /heartbeat/<name>` | The job ran. Starts a new window. |
| `POST /heartbeat/<name>/start` | The job started. The next ping reports how long it took. Optional. |
| `POST /heartbeat/<name>/fail` | The job failed. Alerts at once; a text body (up to 500 characters) becomes the alert's text. |
| `DELETE /heartbeat/<name>` | Stop watching it. |

`<name>` is up to 64 letters, digits, dots, dashes or underscores, and is
unique within the source app.

| Query | Notes |
| ----- | ----- |
| `every` | How often the job runs: seconds, or a number with `s`, `m`, `h` or `d`, from `1m` to `30d`. Required on the first ping; send it again to change it. |
| `grace` | How long past `every` to wait before alerting, up to `7d`. Defaults to 20% of `every`, between 1 minute and 1 hour. |

The response is `200`:

```json
{ "ok": true, "name": "nightly-backup", "status": "up", "everySec": 86400, "graceSec": 3600, "dueAt": 1714525200000 }
```

`dueAt` is when pushr alerts if no ping arrives. It's `null` while the
heartbeat is down or paused.

### What you get

| Event | Notification | Priority |
| ----- | ------------ | -------- |
| No ping by `dueAt` | *nightly-backup missed its check-in* · Expected every 1d. Last ping 1d 1h ago. | high |
| `/fail` | *nightly-backup failed* · your body, or "The job reported a failure." | high |
| A ping after either | *nightly-backup is back up* · Down for 2h 14m. Took 3m 12s. | normal |

- One alert per outage: further misses and failures stay quiet until it
  recovers. A heartbeat that flaps sends at most 3 down alerts an hour;
  past that its status still changes, without a push. Each down alert that
  was sent gets its recovery.
- Alerts come from the token's source app and use the replace key
  `heartbeat:<name>`, so the recovery replaces the alert and the feed keeps
  the history. They follow the app's mutes and quiet hours like any push,
  and don't count toward your monthly quota.
- Lateness is checked every minute.
- Ping as often as you like: pings don't count toward your quota, and
  repeats within 10 seconds are ignored.
- On pushr cloud, Free includes 3 heartbeats and Pro 100, across all your
  apps; a single source app holds at most 50. Heartbeats made before a
  downgrade keep running.

### Report failures and durations

Wrap the job to report all three:

```bash
url="$PUSHR_URL/heartbeat/nightly-backup"
auth="Authorization: Bearer $PUSHR_TOKEN"
curl -fsS -X POST -H "$auth" "$url/start?every=1d"
if out=$(/usr/local/bin/backup.sh 2>&1); then
  curl -fsS -X POST -H "$auth" "$url"
else
  printf '%s' "$out" | tail -c 500 | curl -fsS -X POST -H "$auth" --data-binary @- "$url/fail"
fi
```

With the [SDK](#cli-and-sdk), `withHeartbeat` reports the start, success
or failure of a job for you, and never fails the job if pushr can't be
reached:

```ts
import { heartbeat, withHeartbeat } from '@pushrsh/sdk';

await withHeartbeat('nightly-backup', { every: '1d' }, runBackup);
await heartbeat('queue-worker', { every: '5m' }); // a plain check-in
```

### In the app

The **Monitors** tab lists every heartbeat with its status and last ping, and
**+ → Heartbeat** creates one with copy-ready setup for cron, the CLI, curl or
the SDK. Pause
one during maintenance so it can't alert. Pings while it's paused are
recorded but don't lift the pause, so a job that keeps running during
maintenance stays quiet; **Resume** starts a fresh window.

---

## Uptime checks

Heartbeats catch jobs that stop running. Uptime checks catch sites and APIs
that stop answering: pushr requests a URL on a schedule and pushes to your
phone when it fails, then again when it's back.

```bash
curl -X PUT "$PUSHR_URL/uptime/api" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -d '{"url":"https://api.example.com/health","every":"1m","keyword":"ok"}'
```

<!-- uptime-demo --><!-- /uptime-demo -->

You can also add and edit checks in the app: **Monitors → + → Uptime check**
tests the URL as you type.

### The check

| Field | Notes |
| ----- | ----- |
| `url` | `http` or `https`, on a public host. The name is looked up before every check, and an address that's private, loopback or link-local, or a name that points to one, is refused. Redirects aren't followed. |
| `every` | How often to check: `1m` to `1h` (seconds, or a number with `s`, `m` or `h`). On pushr cloud's Free plan, every 5 minutes at most. |
| `method` | `GET` (default) or `HEAD`. |
| `keyword` | Text the response body must contain, up to 200 characters. Not with `HEAD`. |
| `timeout` | Seconds to wait for a response, 1 to 30. Default 10. |
| `confirmAfter` | Failed checks in a row before it alerts, 1 to 5. Default 2, so one blip doesn't page you. |

A check passes when the response status is below 400 (redirects aren't
followed, so a `301` passes) and, with `keyword`, the body contains it. It
fails on a status of 400 or more, a missing keyword, an error, or no response
within `timeout`.

`PUT` creates the check or changes it, and answers `200` with its state;
`GET` answers the same; `DELETE` removes it:

```json
{
  "ok": true, "name": "api", "url": "https://api.example.com/health", "method": "GET",
  "intervalSec": 60, "timeoutSec": 10, "keyword": "ok", "confirmAfter": 2,
  "status": "up", "lastCheckedAt": 1714525200000, "lastStatusCode": 200,
  "lastLatencyMs": 182, "lastError": null, "downSince": null
}
```

`status` is `pending` until the first check, then `up`, `down` or `paused`.
The name follows the same rules as a heartbeat's.

### What you get

| Event | Notification | Priority |
| ----- | ------------ | -------- |
| `confirmAfter` failures in a row | *api is down* · HTTP 503 · api.example.com/health | high |
| The next passing check | *api is back up* · Down for 12m. Responded in 182ms. | normal |

Alerts work like a heartbeat's: one per outage, at most 3 down alerts an hour,
the recovery replaces the alert (replace key `uptime:<name>`), and they follow
the app's mutes, quiet hours, [on-call](#on-call-escalation) and
[critical alerts](#critical-alerts). They don't count toward your quota.
Checks come from pushr's servers (your own Convex deployment, if you self-host)
with the user agent `pushr-uptime/1`.

| | Free | Pro |
| --- | --- | --- |
| Uptime checks | 1 | 50 |
| Most often | Every 5 minutes | Every minute |

After a move from Pro to Free nothing is deleted. Your oldest check keeps
running, no faster than every 5 minutes; the others are **on hold** and
start again by themselves when you upgrade.

---

## Status pages

A status page shows some of an app's heartbeats and uptime checks to anyone,
at `status.pushr.sh/<slug>`: whether each is up now, 90 days of uptime, and recent
incidents. Create one in the app (**Monitors → + → Status page**), choose its
address, title and monitors, and give each monitor a public name if you like.
Addresses are 3 to 40 lowercase letters, digits or dashes; a few, such as
`docs` and `status`, are reserved. pushr's own status is at the root,
[status.pushr.sh](https://status.pushr.sh).

<!-- statuspage-demo --><!-- /statuspage-demo -->

### Branding

Out of the box a page uses the source app's logo and color. In the page's
editor you can also set:

| Option | Notes |
| ------ | ----- |
| Logo | Upload one for the page, or keep the app's. |
| Accent color | Tints the page's banner and highlights. Status colors stay green, amber and red. |
| Theme | Auto (follows the visitor), light or dark. |
| Website | A link back to your site at the top. |
| Description | A line under the title, up to 160 characters. |
| Announcement | Pinned at the top until you clear it, up to 280 characters: info, maintenance or warning. |
| Groups | Name a group on monitors to show them under headings, like *API* and *Jobs*. |

Visitors never see URLs, error messages or a job's output: an incident reads
as *Failed*, *Missed its check-in*, *HTTP 503*, *Timed out* or *Not
responding*.

### Incidents

Every outage of a monitor on the page is an incident. Outages that overlap
across the page's monitors (or start within two minutes of each other) are one
incident, like *API and Website*. Each opens to a timeline of what the checks
saw: when the first check failed (or a heartbeat's check-in was due), when it
was confirmed down, and when it came back, with the status code and response
time. The page lists 90 days of them, newest first, grouped by day.

**Updates.** Tell visitors what's happening. In the dashboard or the app, open
a monitor, then its incident: give it a title (up to 80 characters, like
*Checkout errors*) and post updates as it goes, each marked **Investigating**,
**Identified**, **Monitoring** or **Resolved**, up to 1,000 characters. Anyone
who can edit the app can post, so whoever's on call can; an AI agent can too,
with the [`incident_update` tool](#the-tools). An incident holds up to 30
updates. The latest update's status is the incident's on the page; without
one it shows *Ongoing* or *Resolved*. Updates are part of Pro, with status
pages, and go with the incident: after 90 days, or when its monitor or app is
deleted.

The page's data is public JSON, for your own page or a widget:

```
GET $PUSHR_URL/status-page/<slug>
```

```json
{
  "title": "Acme status",
  "description": "Live status for Acme's API and dashboard.",
  "logoUrl": "https://…", "accent": "#3E7BFA", "theme": "auto",
  "websiteUrl": "https://acme.com",
  "announcement": { "text": "Maintenance Sunday 2–3am UTC", "tone": "maintenance", "updatedAt": 1714500000000 },
  "overall": "operational",
  "updatedAt": 1714525200000,
  "monitors": [
    {
      "label": "API", "group": "Services", "kind": "uptime", "status": "up", "downSince": null,
      "uptime": 0.9994,
      "days": [{ "date": "2026-07-05", "downMs": 0 }, "… 90 days, oldest first"]
    }
  ],
  "incidents": [
    {
      "title": "Checkout errors", "status": "resolved",
      "monitor": "API and Website", "reason": "HTTP 503",
      "startedAt": 1714500000000, "endedAt": 1714500720000,
      "monitors": [
        {
          "label": "API", "reason": "HTTP 503", "startedAt": 1714500000000, "endedAt": 1714500720000,
          "firstFailedAt": 1714499940000, "statusCode": 503, "latencyMs": 41,
          "recoveredStatusCode": 200, "recoveredLatencyMs": 96
        },
        "… one per monitor in the incident"
      ],
      "updates": [
        { "status": "investigating", "body": "Some checkouts are failing. We're looking into it.", "at": 1714500180000 },
        { "status": "resolved", "body": "Fixed. Sorry for the trouble.", "at": 1714500780000 }
      ]
    }
  ]
}
```

- `overall` is `operational`, `degraded` (some monitors down) or `outage`
  (all of them).
- `days[].downMs` is `-1` for days before the monitor existed.
- `uptime` is over the last 90 days, or since the monitor was created.
- `incidents` are newest first, up to 50 from the last 90 days. `endedAt` is
  `null` while one is going on. `title` and `status` are `null` until someone
  writes an update; `status` is the latest update's. `monitor` (the monitors'
  names joined) and `reason` (the first outage's) are kept for readers of the
  older shape. `firstFailedAt`, `statusCode` and the `recovered…` fields are
  `null` when the check didn't see one (heartbeats have no status code).
- Answers `404` for an unknown or disabled page, and may be cached for 30
  seconds.
- Status pages are a Pro feature on pushr cloud, up to 5 per account. After a
  move to Free a page is kept but offline (`404`), and comes back when you
  upgrade.
- Self-hosted servers serve the JSON only; the app doesn't offer status pages
  there, since `status.pushr.sh` shows pushr cloud's pages.

---

## Other ways to send

### Webhook adapters

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
Payloads must be JSON; a form-encoded delivery gets `400 Invalid JSON body`.

<!-- webhook-demo --><!-- /webhook-demo -->

#### GitHub

Paste `$PUSHR_URL/hooks/github?token=$PUSHR_TOKEN` into your repo or org
webhook settings. Set the content type to **application/json** (GitHub
defaults to form-encoded). Subscribe to events you care about:

| Event               | Sent when                                  | Title                                  | Priority |
| ------------------- | ------------------------------------------ | -------------------------------------- | -------- |
| `push`              | Always                                     | "{repo}: N commits → {branch}"         | 5 |
| `pull_request`      | Opened, reopened, ready for review, closed | "{repo} PR #N {opened\|merged\|closed}" | 6 when opened, else 5 |
| `issues`            | Opened or reopened                         | "{repo} issue #N {action}"             | 5 |
| `release`           | Published                                  | "{repo} release {tag}"                 | 7 |
| `workflow_run`      | Failed or timed out                        | "{repo}: {name} failed"                | 8 |
| `check_run`         | Failed or timed out                        | "{repo}: {name} failed"                | 8 |
| `deployment_status` | Finished (not queued or in progress)       | "{repo}: deploy to {env} → {state}"    | 8 on failure or error, else 6 |
| Any other event     | Always                                     | "{repo}: {event}"                      | 5 |

Everything else (other `pull_request` and `issues` actions, releases that
aren't published, successful runs, deployments still queued or in progress,
and `ping`) is acknowledged with `200 { ignored: true }` and sends nothing.

To sign deliveries, open the source app in the iOS app → **API & token** →
**Webhooks** → **GitHub** and paste the same secret you set in GitHub. Once
it's saved, pushr checks `X-Hub-Signature-256` on every delivery and a
mismatch returns `401`.

#### Sentry

Add an Internal Integration (or legacy plugin webhook) at
`/hooks/sentry?token=…`. An issue becomes `{project}: {action} — {title}`
with its culprit as the body; an alert uses the event's own title; a legacy
plugin webhook is `sentry: {project}`. A payload of any other shape is
acknowledged with `200 { ignored: true }`. Severity maps to pushr priority:

| Sentry level | pushr priority |
| ------------ | -------------- |
| debug        | 2              |
| info         | 4              |
| warning      | 6              |
| error        | 8              |
| fatal        | 9              |
| anything else | 5             |

To verify Sentry signatures, set the integration's client secret in **API &
token → Webhooks → Sentry**. Once it's saved, pushr checks
`Sentry-Hook-Signature` (bare hex HMAC-SHA256 of the raw body) on every
delivery.

#### Grafana

Contact point → Webhook → URL `$PUSHR_URL/hooks/grafana?token=…`. The
adapter collapses the alert batch into one push titled
`<ruleName> (<n> firing)`, or `<ruleName> resolved` at priority 4 once it
clears. `commonLabels.severity` (else the first alert's `severity` label)
sets the priority: `info` 5, `warning` 6, `high`/`error` 8,
`critical`/`emergency` 9; anything else is 6. Grafana doesn't HMAC-sign webhook payloads, so
the bearer token is the only authenticator — keep the URL private.

#### Signing secrets

A single source app can be wired to multiple providers — each with its own
signing secret. Configure them independently in **API & token → Webhooks**.

| Provider | Header                  | Format         | Notes                  |
| -------- | ----------------------- | -------------- | ---------------------- |
| GitHub   | `X-Hub-Signature-256`   | `sha256=<hex>` | Required when set      |
| Sentry   | `Sentry-Hook-Signature` | bare `<hex>`   | Required when set      |
| Grafana  | —                       | —              | Bearer-only (no signing) |

When a secret is set for a provider that supports signing, every inbound
delivery to `/hooks/{provider}` must carry a valid signature or pushr
returns `401 { error: "Invalid signature" }`. Clearing the secret falls
back to bearer-only auth.

#### Adapter response

| Code | Body                          | When                                                      |
| ---- | ----------------------------- | --------------------------------------------------------- |
| 202  | `{ id, scheduledFor: null }`  | Adapter normalized the event and the push was queued.    |
| 200  | `{ ignored: true, provider }` | The adapter chose to ignore this event (e.g. GitHub `ping`). |

Errors are listed under [Errors and retries](#errors-and-retries).

### CLI and SDK

Both read `PUSHR_URL` and `PUSHR_TOKEN` from the environment and call
`POST /notify` for you.

**CLI** (`brew install cpreston321/tap/pushrsh`):

```bash
pushrsh "Deploy finished" "main → production" -p high
tail -n 5 deploy.log | pushrsh "Cron failed"         # stdin becomes the body
pushrsh "PR ready" "+812 / -96" -a "View=https://github.com/owner/repo/pull/318"
pushrsh la start deploy-42 --title "Deploy #42" --status Building --progress 0
pushrsh "Disk 94%" "db-1 /var" -r disk-db-1           # replaces the last disk-db-1
pushrsh hb nightly-backup --every 1d -- ./backup.sh    # heartbeat around a command
pushrsh uptime api https://api.example.com/health --every 1m --keyword ok
```

`pushrsh hb NAME -- COMMAND` runs the command between a start and a success
or fail ping, sends the last 500 characters of its output on failure, and
exits with the command's status.

**TypeScript SDK** (`bun add @pushrsh/sdk`, any fetch runtime):

```ts
import { notify, liveActivity, withHeartbeat } from "@pushrsh/sdk";

await notify({ title: "New sale", body: "$42 from Acme", priority: 9 });

const la = liveActivity("deploy-42");
await la.start({ status: "Building", progress: 0 });
await la.end({ status: "Live" });

await withHeartbeat("nightly-backup", { every: "1d" }, runBackup);
```

### Gotify compatibility

pushr accepts Gotify's `message` and `extras` click URL. See
[From Gotify or iGotify](#from-gotify-or-igotify) for the full mapping.

---

## Connect AI agents

pushr is an [MCP](https://modelcontextprotocol.io) server, so Claude,
ChatGPT, Cursor and other AI agents can reach you on your iPhone: ask before
they do something you'd want a say in, wait for your tap, tell you when
they're done, and show long tasks on your Lock Screen. There's no token to
copy: the agent signs in to your pushr account, and you choose which apps it
may use. This is a pushr cloud feature.

### Add pushr to your agent

<!-- agents-setup -->
The server's address is **`https://mcp.pushr.sh`**. `https://mcp.pushr.sh/mcp`, the usual `/mcp` form, works the same, and so does `https://pushr.sh/mcp`, its earlier address, for agents connected there.

| Agent | How |
| ----- | --- |
| Claude (claude.ai, Desktop, mobile) | **Settings → Connectors → Add custom connector**, paste the address |
| Claude Code | `claude mcp add --transport http pushr https://mcp.pushr.sh`, then run `/mcp` and choose **Authenticate** |
| ChatGPT | Add it as a connector (MCP server) in developer mode |
| Cursor | In `~/.cursor/mcp.json`: `{ "mcpServers": { "pushr": { "url": "https://mcp.pushr.sh" } } }` |
| VS Code | In `.vscode/mcp.json`: `{ "servers": { "pushr": { "type": "http", "url": "https://mcp.pushr.sh" } } }` |
| Anything else | Any client that speaks MCP's Streamable HTTP transport with OAuth |
<!-- /agents-setup -->

<!-- agents-connect -->
The agent then opens **pushr.sh/connect** in your browser:

1. **Sign in** with your pushr email and password. Made your account with
   Sign in with Apple? Choose **Email me a sign-in link** instead. Accounts
   are created in the app, not here.
2. **Choose the apps** the agent may send as, one or more. Its notifications
   come from those apps, like any other push, and it can read their
   monitors. With more than one, the agent picks the app for each message.
3. **Allow.** You're sent back to the agent, connected.
<!-- /agents-connect -->

The app's **Settings → AI agents** lists what's connected, which apps each
one uses and when it was last used. Tap one to disconnect it; it has to sign
in again to come back. Deleting an app removes it from every agent.

### The tools

<!-- agents-tools -->
| Tool | What it does |
| ---- | ------------ |
| `ask` | Pushes a question with a button per choice (default **Approve** / **Reject**, up to 4) and an optional **Reply** button, then waits for your tap. `urgent: true` re-pushes every minute, up to 5 times, until you answer. |
| `get_answer` | Keeps waiting for, or checks, the answer to an `ask` |
| `notify` | Sends a notification: `title`, `body`, `priority` (`low`, `normal`, `high`), `url`, `replace_key` |
| `progress` | Shows a task as a Live Activity. Call it again with the same `id` to move it on; `outcome: "success"` or `"failure"` ends it |
| `monitors` | The state of the chosen apps' uptime checks and heartbeats, worst first |
| `incident_update` | Posts an update to a monitor's current or latest [status page incident](#incidents) (within the last day): `monitor` (its name), `status` (`investigating`, `identified`, `monitoring`, `resolved`), `message`, optional `title`. Needs edit access to the app, and Pro |

`ask`, `notify` and `progress` take an `app` argument when the agent has
more than one app. The agent sees only the apps you chose.
<!-- /agents-tools -->

<!-- agents-notes -->
**How `ask` waits.** The first button you tap is the answer. One call waits
up to `wait_seconds` (default 90, at most 240). If you haven't answered by
then, the agent gets the question's `id` and keeps waiting with
`get_answer`; it's told never to assume an answer. Tapping later still
counts. The buttons appear on the notification and in the feed, like
[action buttons](#action-buttons), except no callback URL is involved: the
answer goes straight back to the agent.

**Plans.** Each `ask`, `notify` and `progress` step is a notification and
counts toward your monthly limit. An app that's paused on the Free plan
can't send, and the agent is told so.
<!-- /agents-notes -->

---

## Use with AI agents

pushr ships **agent skills**: task-focused guides that teach coding agents
(Claude Code, Cursor, Codex and others) how to integrate pushr the right
way, from picking a priority to building a callback endpoint. Install them
into your project once, then just ask.

### Set up the skills

<!-- skills-setup -->
1. **Add your credentials.** Put `PUSHR_URL` and `PUSHR_TOKEN` in the
   project's `.env` (and your CI secrets). The skills read them from the
   environment, like the SDK and CLI, and won't paste a token into code.
2. **Install the skills.** In your project, run:

   ```bash
   npx skills add cpreston321/pushr-backend
   ```

   and follow the prompts to choose which agents get them. For Claude Code
   by hand, copy the folders from
   [`skills/`](https://github.com/cpreston321/pushr-backend/tree/main/skills)
   into `.claude/skills/` in your project, or `~/.claude/skills/` for every
   project.
3. **No skills support?** Give your tool the docs instead. Add
   `https://pushr.sh/llms-full.txt` as a docs source (in Cursor: **@Docs →
   Add new doc**), or add one line to your `AGENTS.md` or `CLAUDE.md`:
   `For push notifications, follow https://pushr.sh/llms.txt`.
4. **Check it works.** Ask your agent *"Send me a test push with pushr."*
   A notification should arrive on your phone.
<!-- /skills-setup -->

### The skills

<!-- skills-list -->
| Skill | What it covers | Ask things like |
| ----- | -------------- | --------------- |
| `pushr-notify` | Setup and secrets, request fields, choosing a priority, replace keys, the SDK, CLI, Python, Go and GitHub Actions, errors and safe retries | "Notify my phone when this build finishes", "Ping me if the nightly backup fails" |
| `pushr-actions` | Buttons and replies, the callback request, building and securing the endpoint (Hono, Express, Next.js, FastAPI), approval gates | "Let me approve this deploy from my phone", "Add a Retry button to the failure alert" |
| `pushr-live-activities` | Start, update and end, choosing an icon, always ending on failure, update pacing | "Show this upload's progress on my Lock Screen", "Track the deploy in the Dynamic Island" |
| `pushr-alerts` | Urgency levels, ack-or-escalate, on-call rotations, critical alerts, quiet hours and mutes, GitHub, Sentry and Grafana webhooks with signing | "Wake me up if prod goes down", "Send failed GitHub workflows to my phone" |
| `pushr-heartbeats` | Heartbeats for cron jobs and workers, uptime checks for sites and APIs, status pages, the CLI wrapper, SDK and CI | "Tell me if the nightly backup stops running", "Alert me if the API goes down" |
| `pushr-types` | Drop-in TypeScript types and a dependency-free client with idempotent retries, Python types, a Zod schema | "Add a typed pushr client without the SDK", "Validate pushr payloads" |

The agent loads the right skill from what you ask, so you don't need to
name it. The skills use `PUSHR_URL` and `PUSHR_TOKEN` from the environment,
the same as the SDK and CLI: add them to your project's secrets first.
<!-- /skills-list -->

### Docs for LLM tools

<!-- llm-docs -->
Point any tool that takes a URL as context at these:

| URL | What it is |
| --- | ---------- |
| [`pushr.sh/llms.txt`](https://pushr.sh/llms.txt) | An index of pushr's docs and skills, in the [llms.txt](https://llmstxt.org) format |
| [`pushr.sh/llms-full.txt`](https://pushr.sh/llms-full.txt) | This whole reference plus every skill, in one file |
| [`pushr.sh/docs.md`](https://pushr.sh/docs.md) | This reference as plain Markdown |
| `pushr.sh/skills/<skill>/SKILL.md` | One skill, e.g. [`pushr-notify`](https://pushr.sh/skills/pushr-notify/SKILL.md) |

All of them are generated from this page, so they stay in step with it.
<!-- /llm-docs -->

---

## Errors and retries

### Status codes

<!-- status-codes -->
Every error body has an `error` string; some also carry a `code` to branch on.

| Code | Body | Applies to | When |
| ---- | ---- | ---------- | ---- |
| 400 | `{ error: "<reason>" }` | `/notify` and adapters | Validation error (missing fields, bad shape). |
| 401 | `{ error: "Invalid token" }` / `"Missing bearer token"` | `/notify` and adapters | Bad or absent token. |
| 401 | `{ error: "Invalid signature" }` | Webhook adapters | The provider's signature didn't match the signing secret you set. |
| 403 | `{ error: "Source app disabled" }` | `/notify` and adapters | Token is valid but the app was disabled. |
| 403 | `{ error, code: "APP_PAUSED" }` | `/notify` and adapters | pushr cloud only: the app is on hold because the account is on Free with more apps than Free allows. Choose the active app in the iOS app, or upgrade. |
| 409 | `{ error, code: "IDEMPOTENCY_KEY_REUSED" }` | `/notify` | The `Idempotency-Key` was used with a different payload. |
| 400 | `{ error, code: "EVERY_REQUIRED" }` | `/heartbeat` | The first ping to a new name didn't say `every`. |
| 404 | `{ error }` | `/heartbeat` | Not `/heartbeat/<name>`, `/start` or `/fail`, or `DELETE` of a name that doesn't exist. |
| 403 | `{ error, code: "PRO_REQUIRED" }` | `/heartbeat` | pushr cloud only: a new heartbeat past Free's 3. |
| 409 | `{ error, code: "HEARTBEAT_LIMIT" }` | `/heartbeat` | Pro's 100, or 50 on one source app, are in use. |
| 403 | `{ error, code: "PRO_REQUIRED" }` | `/uptime` | pushr cloud only: a second check, or checking more often than every 5 minutes, on Free. |
| 409 | `{ error, code: "UPTIME_LIMIT" }` | `/uptime` | The account already has 50 uptime checks. |
| 400 | `{ error }` | `/notify` | A field is over its [limit](#rate-limits-and-quotas), a link uses a forbidden scheme, or `deliverAt` is more than a year away. The message names the field and its limit. |
| 429 | `{ error, code: "RATE_LIMITED" }` with `Retry-After` | `/notify` and adapters | The source app sent more than 120 pushes in a minute. Wait `Retry-After` seconds. Replays with an `Idempotency-Key` don't count. |
| 429 | `{ error, code: "QUOTA_EXCEEDED", tier, count, limit }` | `/notify` and adapters | pushr cloud only: the monthly push limit is reached. See [Rate limits and quotas](#rate-limits-and-quotas). |
| 500 | `{ error: "Internal error" }` | `/notify`, `/heartbeat`, `/uptime` and adapters | Something failed on the server. Safe to retry with the same `Idempotency-Key`. |
<!-- /status-codes -->

### Retries and `Idempotency-Key`

Send an `Idempotency-Key` header (any string up to 255 characters, such as a
job id or UUID) to make retries safe:

```bash
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -H "Idempotency-Key: deploy-482-finished" \
  -d '{"title":"Deploy #482 finished"}'
```

<!-- idempotency-cases -->
- A retry with the same key and the same body returns the original `id` with
  `200` and `Idempotent-Replay: true`. It isn't pushed again and doesn't count
  toward your quota.
- The same key with a different body is a `409`, because that's a bug in the
  sender, not a retry.
- Keys are per source app and are remembered for at least 24 hours.
<!-- /idempotency-cases -->

---

## `GET /healthz`

```
GET /healthz
```

```json
{ "ok": true, "version": "0.1.0", "selfHosted": false, "appleSignIn": true }
```

`version` is the backend release, and `appleSignIn` says whether Sign in
with Apple is enabled on this server. A self-hosted server answers
`"selfHosted": true`, with `appleSignIn` false unless you've enabled it. Use this from a monitor to check that your deployment is reachable.

---

## Tokens and limits

### Source-app token format

Tokens always start with `pshr_` followed by a base64url payload. They're
shown **once** at creation time in the mobile app's **Apps** tab — the
server only stores the `sha256(token)` hash. Revoking an app invalidates its
token for good; rotating the token issues a new one and invalidates the old.

`tokenPrefix` (e.g. `pshr_abcd1234`) is safe to display in logs and CI
config; the full token is not.

### Rate limits and quotas

**Self-hosted:** there are no plans and no push quota. Every account on your
deployment gets every feature. A few fixed limits remain: 50 uptime checks
per account, 50 heartbeats per source app, and notification history is kept
90 days (a daily sweep deletes older pushes).

**Push limits, on both:** each source app can send 120 pushes a minute; past
that, `/notify` answers `429` with `code: "RATE_LIMITED"` and a
`Retry-After` header. `title` is at most 256 characters, `body` 4096, `url`,
`image`, `appUrl` and action URLs 2048, an action's `label` and `id` 64, and
`data` 4 KB as JSON. `url` and `image` must be `http` or `https`; `appUrl`
and `open_url` actions may use any app scheme (`myapp://…`) but never
`javascript:`, `data:`, `file:` or `vbscript:`. Provider webhooks
(`/hooks/*`) have over-long titles and bodies shortened instead of refused.

**Logos,** for an app or a status page, are PNG, JPEG, WebP or HEIC images up
to 5 MB. An upload that isn't attached to an app or page within a day is
deleted.

**Signing in, on both:** after 10 wrong passwords for one email address within
15 minutes, password sign-in for that address answers `429` with
`code: "TOO_MANY_SIGN_IN_ATTEMPTS"` until the 15 minutes pass. Password reset
and Sign in with Apple still work, and signing in before the limit starts the count over.

<!-- plans-compare -->
**pushr cloud:**

| | Free | Pro |
| --- | --- | --- |
| Pushes per month | 1,000 | 10,000 |
| Source apps | 1 | Unlimited |
| History | 7 days | 90 days |
| People per shared app | 1 | Unlimited |
| Quiet hours, Slack and Discord forwarding | No | Yes |
| Uptime checks | 1, every 5 minutes | 50, every minute |
| Heartbeats | 3 | 100 |
| Status pages | No | 5 |
| On-call escalation and critical alerts | No | Yes |
<!-- /plans-compare -->

Past the monthly limit, `/notify` answers `429`:

```json
{
  "error": "Monthly quota exceeded",
  "code": "QUOTA_EXCEEDED",
  "tier": "free",
  "count": 1000,
  "limit": 1000
}
```

The count resets at the start of each month (UTC). Replays with an
`Idempotency-Key` don't count.

---

## Migrating from other apps

Every guide below ends the same way: create a source app in the iPhone app
(**Apps → +**), copy its token, and send JSON to `POST /notify` with
`Authorization: Bearer $PUSHR_TOKEN`. A source app plays the part of a
Pushover application, an ntfy topic, a Gotify app or a Hark service: give each
sender its own, with its own name, logo and colour.

<!-- migrate-intro -->
Two things differ from most of these services:

- **`title` and `body` are both required.** Where you relied on a default
  title, send one.
- **Bodies are JSON, and plain text.** Form fields, a raw text body and
  Markdown aren't read.
<!-- /migrate-intro -->

### From Pushover

<!-- migrate-pushover -->
```bash
# Before
curl -s https://api.pushover.net/1/messages.json \
  --form-string "token=$APP_TOKEN" --form-string "user=$USER_KEY" \
  --form-string "title=Backup failed" --form-string "message=exit 2" \
  --form-string "priority=1"

# After
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -d '{ "title": "Backup failed", "body": "exit 2", "priority": "high" }'
```

| Pushover | pushr |
| -------- | ----- |
| `token` (application) | The source app's token, as a bearer header |
| `user` / group key | Not needed: a push reaches everyone the source app is [shared](#post-notify) with |
| `title`, `message` | `title`, `body` |
| `url`, `url_title` | `url`, or an `open_url` [action](#action-buttons) with your own label |
| `priority` `-2` / `-1` / `0` / `1` | `1` / `3` / `5` / `8` (see [Priority and interruption](#priority-and-interruption)) |
| `priority=2` with `retry` and `expire` | `"priority": "high"` plus `ack: { timeoutSec: retry, maxAttempts: expire ÷ retry }` (at most 20), see [Ack-or-escalate](#ack-or-escalate) |
| `sound` | Picked per priority level in the app, under **Settings → Sounds** |
| `attachment` (uploaded file) | `image`: a public URL rather than an upload |
| `device` | Chosen on the phone instead: each person switches delivery off for any of their devices in **Settings → Devices** |
| `html`, `ttl`, `timestamp` | Not available |
<!-- /migrate-pushover -->

### From ntfy

<!-- migrate-ntfy -->
ntfy publishes to a topic with the message as the request body and the rest
as headers. pushr takes one JSON object instead.

```bash
# Before
curl -H "Title: Backup failed" -H "Priority: high" \
     -H "Click: https://homelab.lan" -d "exit 2" ntfy.sh/homelab-backups

# After
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -d '{ "title": "Backup failed", "body": "exit 2", "priority": "high", "url": "https://homelab.lan" }'
```

| ntfy | pushr |
| ---- | ----- |
| Topic in the URL | A source app; its token replaces the topic name and any `tk_` access token |
| Request body (the message) | `body` |
| `Title` | `title` (required) |
| `Priority` `1` min / `2` low / `3` default / `4` high / `5` max | `1` / `3` / `5` / `8` / `10` |
| `Click` | `url` |
| `Attach` (a URL) | `image` |
| `Actions` `view` | `open_url` [action](#action-buttons) |
| `Actions` `http` | `callback` action: a `POST` with pushr's own JSON body, no custom method, headers or body |
| `Delay` / `At` | `deliverAt`, as a millisecond timestamp |
| `Tags` (emoji) | Not available: put the emoji in the `title` |
| `Markdown`, `Email`, `Call` | Not available |
| GitHub and Grafana templates | `/hooks/github` and `/hooks/grafana`, plus Sentry: see [Webhook adapters](#webhook-adapters) |

Scripts that pipe into `curl -d` read naturally with the
[CLI](#cli-and-sdk): `tail -n 5 backup.log | pushrsh "Backup failed"`.
<!-- /migrate-ntfy -->

### From Gotify or iGotify

<!-- migrate-gotify -->
pushr accepts Gotify's field names, so a sender usually needs only a new
URL and header. Point it at `/notify` and send the token as a bearer
header: Gotify's `/message` route, `?token=` parameter and `X-Gotify-Key`
header aren't supported.

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

| Gotify | pushr |
| ------ | ----- |
| App token | Source app token, as a bearer header |
| `title`, `message` | `title` (required), `message` (or `body`) |
| `priority` `1`–`10` | The same scale |
| `priority` `0` | Rejected: send `1`, or leave `priority` out |
| `extras["client::notification"].click.url` | `url` |
| `extras["client::notification"].bigImageUrl` | Not read: send `image` |
| `extras["client::display"]` Markdown | Not available: bodies are plain text |

There's no Gotify server to keep running, and iGotify's bridge isn't needed:
pushr delivers to the iPhone app itself.
<!-- /migrate-gotify -->

### From Hark

<!-- migrate-hark -->
Hark and pushr are both webhook-to-iPhone services, so most fields carry
straight over. A Hark service is a pushr source app, and the secret webhook
URL becomes `POST /notify` with a bearer token.

```bash
# Before
curl -X POST https://hark.ryan.ceo/hooks/whk_your_token \
  -H 'Content-Type: application/json' \
  -d '{ "title": "GitHub", "body": "Production deployed", "url": "https://github.com/acme/app/actions" }'

# After
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -d '{ "title": "GitHub", "body": "Production deployed", "url": "https://github.com/acme/app/actions" }'
```

| Hark | pushr |
| ---- | ----- |
| Webhook URL (`/hooks/whk_…`) | `POST /notify` with the source app's token |
| `body`, `title`, `url` | The same; `title` is required |
| `imageUrl` (sender avatar) | The source app's logo, set once in the app. `image` is a picture attached to one push |
| `project` | One source app per project |
| `Idempotency-Key` header | The same header, see [Retries and `Idempotency-Key`](#retries-and-idempotency-key) |
| `response` `approval` / `yes_no` | Two `callback` [actions](#action-buttons), the risky one `destructive` |
| `response` `text` | A `reply` action |
| `callback.url` with `callback.token` | Each action's `callbackUrl`; put the token in the URL, since callbacks are unsigned |
| Reading or cancelling a response | Not available over HTTP; agents wait for answers with [`ask`](#connect-ai-agents) |
| Withdrawing a notification | Send a newer one with the same [`replaceKey`](#replace-keys) |
| `deviceIds` | Chosen on the phone instead of per push: each person switches delivery off for any of their devices in **Settings → Devices**, and a source app can be muted or given quiet hours |
| `bodyFormat` Markdown, `summary` | Not available |

Live Activities are a field on `/notify` rather than their own endpoints.
You choose the `activityId` instead of reading one back, and send
`liveActivity.action` `start`, `update` or `end`:

| Hark | pushr |
| ---- | ----- |
| Start, update, end endpoints | `liveActivity.action`: `start` / `update` / `end` on `/notify` |
| `title`, `status`, `progress` (0–1) | `state.title`, `state.status`, `state.progress` (0–1) |
| `symbol` | `state.icon`: any SF Symbol name |
| Failure on end | `state.outcome: "failure"` |
| `accentColor`, `style`, `ifSequence` | Not available |

See [Live Activities](#live-activities) for the full shape.

With the CLIs, `harkctl notify` becomes `pushrsh "Title" "Body"` and
`harkctl activity start|update|end` becomes `pushrsh la start|update|end`
(see [CLI and SDK](#cli-and-sdk)). Instead of `harkctl permissions setup`,
add `https://mcp.pushr.sh` to Claude, ChatGPT or Cursor and they ask on your
phone with the `ask` tool: see [Connect AI agents](#connect-ai-agents).
<!-- /migrate-hark -->

---

## Self-hosting

pushr's backend is open source. You can run it on your own Convex
deployment and point the iPhone app at it, so your notifications never touch
pushr's servers. Self-hosted backends have no plans or push quota: every
feature is unlocked, for free, within a few
[fixed limits](#rate-limits-and-quotas).

### What you need

<!-- selfhost-overview -->
- [Bun](https://bun.sh).
- A Convex backend: a free [Convex](https://convex.dev) account, or Convex
  itself in Docker on your own server (see
  [Run Convex yourself](#run-convex-yourself-with-docker)).
- The pushr iPhone app.
- The [`pushr-backend`](https://github.com/cpreston321/pushr-backend) source.
<!-- /selfhost-overview -->

### 1. Create your deployment

<!-- host:cloud -->
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
<!-- /host:cloud -->

<!-- host:docker -->
#### Run Convex yourself with Docker

A Convex account is optional: Convex's backend is open source too, and runs
in Docker. Two addresses matter, and the iPhone needs both over HTTPS:

| Port | Convex calls it | pushr calls it |
| ---- | --------------- | -------------- |
| `3210` | `CONVEX_CLOUD_ORIGIN` | Convex URL |
| `3211` | `CONVEX_SITE_ORIGIN` | Site URL (`/notify`, `/healthz`) |

Put a reverse proxy such as Caddy or nginx in front, with a hostname for each,
for example `convex.example.com` → `3210` and `push.example.com` → `3211`.

##### Recommended server

<!-- selfhost-vps -->
Any VPS that runs Docker works: Hetzner Cloud, DigitalOcean, Vultr, Linode
or AWS Lightsail all fit. An x86-64 (Intel or AMD) plan is the safest
choice. Size it by how much you send:

| Use | vCPU | Memory | Disk |
| --- | ---- | ------ | ---- |
| Just you, or a small team | 2 | 4 GB | 40 GB SSD |
| A busy team, many monitors | 4 | 8 GB | 80 GB SSD |
| Heavy production traffic | 8 | 16 GB | 160 GB SSD |

Pick a region near where your servers send from: pushes go phone-ward
through Apple, so the VPS's distance to your phones matters little.

The templates below are sized for the largest row. On a smaller server,
lower `cpus` and `mem_limit` to fit it: Docker won't start a container that
asks for more CPUs than the machine has. On a 2 vCPU, 4 GB server, for
example, give the backend `cpus: 1.5` and `mem_limit: 2G`, and Postgres
`cpus: 0.5`, `mem_limit: 1G` and `shm_size: 256mb`.

Pick a template. Both keep the database in Postgres; they differ in where
Convex keeps files (uploaded logos, function code, search indexes and
exports).
<!-- /selfhost-vps -->

<!-- selfhost-compose -->
##### Postgres

Start here. Files stay on a `convex-data` volume on the same machine.

```yaml
services:
  backend:
    image: 'ghcr.io/get-convex/convex-backend:latest'
    stop_grace_period: 10s
    stop_signal: SIGINT
    cpus: 8
    mem_limit: 10G
    ports:
      - '127.0.0.1:3210:3210'
      - '127.0.0.1:3211:3211'
    volumes:
      - 'convex-data:/convex/data'
    environment:
      - 'INSTANCE_NAME=${INSTANCE_NAME:-convex-self-hosted}'
      - 'INSTANCE_SECRET=${INSTANCE_SECRET:-}'
      - 'CONVEX_RELEASE_VERSION_DEV=${CONVEX_RELEASE_VERSION_DEV:-}'
      - 'ACTIONS_USER_TIMEOUT_SECS=${ACTIONS_USER_TIMEOUT_SECS:-}'
      - 'CONVEX_CLOUD_ORIGIN=${CONVEX_CLOUD_ORIGIN:-http://127.0.0.1:3210}'
      - 'CONVEX_SITE_ORIGIN=${CONVEX_SITE_ORIGIN:-http://127.0.0.1:3211}'
      - 'POSTGRES_URL=${POSTGRES_URL:-}'
      - 'DISABLE_BEACON=${DISABLE_BEACON:-true}'
      - 'REDACT_LOGS_TO_CLIENT=${REDACT_LOGS_TO_CLIENT:-true}'
      - 'RUST_LOG=${RUST_LOG:-info}'
      - 'RUST_BACKTRACE=${RUST_BACKTRACE:-}'
      - 'DO_NOT_REQUIRE_SSL=${DO_NOT_REQUIRE_SSL:-1}'
      - EXPORT_STORAGE_GET_CONCURRENCY=4
      - EXPORT_MAX_INFLIGHT_PREFETCH_BYTES=8388608
      - EXPORT_WORKER_PAGE_SIZE=100
      - MALLOC_ARENA_MAX=2
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: 'curl -f http://localhost:3210/version'
      interval: 5s
      start_period: 5s
  postgres:
    image: 'postgres:17-alpine'
    cpus: 3
    mem_limit: 6G
    shm_size: 1gb
    environment:
      - POSTGRES_USER=postgres
      - 'POSTGRES_PASSWORD=${DB_PASSWORD}'
      - POSTGRES_DB=convex_self_hosted
    volumes:
      - 'postgres-data:/var/lib/postgresql/data'
    healthcheck:
      test:
        - CMD-SHELL
        - 'pg_isready -U postgres'
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  convex-data: null
  postgres-data: null
```

##### Postgres and S3

For a production server where files should live in S3-compatible storage
(AWS S3, Cloudflare R2, MinIO…), so the machine itself holds nothing you'd
lose. Create the five buckets first.

```yaml
services:
  backend:
    image: 'ghcr.io/get-convex/convex-backend:latest'
    stop_grace_period: 10s
    stop_signal: SIGINT
    cpus: 8
    mem_limit: 10G
    ports:
      - '127.0.0.1:3210:3210'
      - '127.0.0.1:3211:3211'
    environment:
      - AWS_REGION=us-east-1
      - 'AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}'
      - 'AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}'
      - S3_STORAGE_EXPORTS_BUCKET=convex-snapshot-exports
      - S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET=convex-snapshot-imports
      - S3_STORAGE_MODULES_BUCKET=convex-modules
      - S3_STORAGE_FILES_BUCKET=convex-user-files
      - S3_STORAGE_SEARCH_BUCKET=convex-search-indexes
      - 'S3_ENDPOINT_URL=${S3_ENDPOINT_URL}'
      - 'INSTANCE_NAME=${INSTANCE_NAME:-convex-self-hosted}'
      - 'INSTANCE_SECRET=${INSTANCE_SECRET:-}'
      - 'CONVEX_RELEASE_VERSION_DEV=${CONVEX_RELEASE_VERSION_DEV:-}'
      - 'ACTIONS_USER_TIMEOUT_SECS=${ACTIONS_USER_TIMEOUT_SECS:-}'
      - 'CONVEX_CLOUD_ORIGIN=${CONVEX_CLOUD_ORIGIN:-http://127.0.0.1:3210}'
      - 'CONVEX_SITE_ORIGIN=${CONVEX_SITE_ORIGIN:-http://127.0.0.1:3211}'
      - 'POSTGRES_URL=${POSTGRES_URL:-}'
      - 'DISABLE_BEACON=${DISABLE_BEACON:-true}'
      - 'REDACT_LOGS_TO_CLIENT=${REDACT_LOGS_TO_CLIENT:-true}'
      - 'RUST_LOG=${RUST_LOG:-info}'
      - 'RUST_BACKTRACE=${RUST_BACKTRACE:-}'
      - 'DO_NOT_REQUIRE_SSL=${DO_NOT_REQUIRE_SSL:-1}'
      - EXPORT_STORAGE_GET_CONCURRENCY=4
      - EXPORT_MAX_INFLIGHT_PREFETCH_BYTES=8388608
      - EXPORT_WORKER_PAGE_SIZE=100
      - MALLOC_ARENA_MAX=2
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: 'curl -f http://localhost:3210/version'
      interval: 5s
      start_period: 5s
  postgres:
    image: 'postgres:17-alpine'
    cpus: 3
    mem_limit: 6G
    shm_size: 1gb
    environment:
      - POSTGRES_USER=postgres
      - 'POSTGRES_PASSWORD=${DB_PASSWORD}'
      - POSTGRES_DB=convex_self_hosted
    volumes:
      - 'postgres-data:/var/lib/postgresql/data'
    healthcheck:
      test:
        - CMD-SHELL
        - 'pg_isready -U postgres'
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  postgres-data: null
```

Put the values in a `.env` beside the compose file. `POSTGRES_URL` points at
the `postgres` service without a database name, because Convex uses
`INSTANCE_NAME` with `-` turned into `_` (`convex_self_hosted`, matching
`POSTGRES_DB`; change both together). The origins are your two public HTTPS
addresses:

```bash
INSTANCE_SECRET=<openssl rand -hex 32>
DB_PASSWORD=<a strong password>
POSTGRES_URL=postgresql://postgres:<the same password>@postgres:5432
CONVEX_CLOUD_ORIGIN=https://convex.example.com
CONVEX_SITE_ORIGIN=https://push.example.com

# Postgres and S3 only
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
S3_ENDPOINT_URL=https://<your S3-compatible endpoint>
```
<!-- /selfhost-compose -->

For a single machine without Postgres either, Convex's own
[self-hosting guide](https://github.com/get-convex/convex-backend/tree/main/self-hosted)
has a smaller compose file.

Start it, make an admin key, and point the pushr backend at it instead of
running `bun run dev`:

```bash
docker compose up -d
docker compose exec backend ./generate_admin_key.sh

git clone https://github.com/cpreston321/pushr-backend
cd pushr-backend
bun install

# in pushr-backend/.env.local
CONVEX_SELF_HOSTED_URL=https://convex.example.com
CONVEX_SELF_HOSTED_ADMIN_KEY=<the key it printed>

bun run push
```

`bun run push` deploys the schema and functions to your backend, and the
`bunx convex` commands in the next steps use it too. Wherever they mention
the `.convex.cloud` URL, use your Convex URL; for the `.convex.site` URL,
your Site URL.

<!-- /host:docker -->

### 2. Set the server secrets

These live in the Convex deployment, not in `.env.local`:

<!-- host:cloud -->
```bash
bunx convex env set BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
bunx convex env set SITE_URL "https://<your-deployment>.convex.site"
```
<!-- /host:cloud -->

<!-- host:docker -->
With your own Convex, `SITE_URL` is your Site URL:

```bash
bunx convex env set BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
bunx convex env set SITE_URL "https://push.example.com"
```
<!-- /host:docker -->

### 3. Create your account

```bash
bunx convex run seed:createAdmin '{"email":"you@example.com","password":"<a strong password>"}'
```

### 4. Connect the app

<!-- host:cloud -->
1. In pushr, open **Settings → Server**.
2. Under **Custom Convex Deployment**, paste your `.convex.cloud` URL. The
   `.convex.site` URL is filled in from it.
<!-- /host:cloud -->

<!-- host:docker -->
1. In pushr, open **Settings → Server**.
2. Under **Custom Convex Deployment**, tap **Custom domain?** and enter your
   Convex URL (`https://convex.example.com`) and Site URL
   (`https://push.example.com`).
<!-- /host:docker -->

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

After 20 wrong codes in 15 minutes, `/pair` answers further wrong codes with
`429` (`PAIRING_LOCKED`) until the window passes. A real code always works.

**The server's owner** is any account `seed:createAdmin` made; run it again
with an existing account's email to make that account an owner too. On a
server set up before owners were recorded, the first account is the owner.
Anyone on the server can share an app with someone who already has an
account, but only the owner's invites let someone **new** sign up without a
code.

To go back, return to the same screen and tap **Use pushr cloud**.

#### If you change `BETTER_AUTH_SECRET`

The key that signs the app's Convex tokens is stored encrypted with the
secret. After changing it, sign-in still works but the app can't load
anything, and the logs show `Failed to decrypt private key`. Generate a new
key with:

```bash
bunx convex run maintenance:resetAuthKeys
```

### 5. Send a push

Create a source app in the **Apps** tab and copy its token, then:

<!-- host:cloud -->
```bash
curl -X POST "https://<your-deployment>.convex.site/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","body":"from my own server"}'
```
<!-- /host:cloud -->

<!-- host:docker -->
```bash
curl -X POST "https://push.example.com/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","body":"from my own server"}'
```
<!-- /host:docker -->

### Updating

Pull the latest source and run `bun run push`: it updates the deployment
from step 1, the one your app and variables are on. Schema changes deploy
with the functions; there's no separate migration step. If you run a
separate production deployment (`bun run deploy`), it starts empty: set its
variables with `bunx convex env set --prod …`, create your account with
`bunx convex run --prod seed:createAdmin …`, point the app at its URLs, and
update it with `bun run deploy`.

### Differences from pushr cloud

- **Live Activities are not available** with the App Store app. Starting and
  updating them needs an APNs key from the team that publishes the app. A
  push with `liveActivity` is still accepted and arrives as a normal push.
  Everything else (pushes, actions, ack-or-escalate, widgets, webhooks)
  works.
- **Delivery goes through Expo's push service,** the same as pushr cloud.
  Your server only needs outbound HTTPS.
- **Plans don't apply.** Pro features are on for every account on your
  deployment.
- **AI agents connect to pushr cloud only.** `mcp.pushr.sh` signs in to a
  pushr cloud account. On your own server, agents send with the
  [skills](#use-with-ai-agents), SDK or CLI and a token instead.
- **Status pages** are served as JSON at `/status-page/<slug>` on your
  deployment; the `status.pushr.sh/<slug>` page shows pushr cloud's pages only.
- **The web dashboard works with your server.** At
  [app.pushr.sh](https://app.pushr.sh), choose **Change server** and enter
  your `.convex.cloud` address, then sign in with your email and password
  (no emailed links or Apple there). Status pages and plans are hidden. The
  server must allow the dashboard's origin: `https://app.pushr.sh` by default,
  or set `DASHBOARD_URL` if you host the dashboard yourself.
- **Sign in with Apple is off** unless you set `APPLE_SIGN_IN=enabled`. Apple
  gives every server for the pushr app the same identifier for a person, so
  signing in to your server would link their Apple ID to their pushr cloud
  account. Deletion also can't revoke the Apple sign-in (that needs the
  publisher's key), and Hide My Email addresses only get email if your sending
  domain is registered with Apple.
