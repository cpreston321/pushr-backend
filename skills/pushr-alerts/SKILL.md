---
name: pushr-alerts
description: Set up urgent, on-call style alerting with pushr: priorities that break through Focus, ack-or-escalate pushes that re-alert until acknowledged, on-call rotations that escalate from one teammate to the next, critical alerts that ring through mute, quiet hours, and webhook adapters that turn GitHub, Sentry and Grafana events into pushes without code. Use when the user asks to "page me", "wake me up if prod goes down", "keep alerting until I respond", "on-call alerts", "escalate to my teammate", "ring even on silent", "forward GitHub/Sentry/Grafana to pushr", or "don't bother me at night unless it's critical".
---

# Alerts, escalation and webhooks with pushr

Sending basics are in the `pushr-notify` skill. Full reference:
https://pushr.sh/llms-full.txt

## Match the urgency

| Situation | Send |
| --------- | ---- |
| FYI, can wait for the next time they look | `priority: "low"` |
| Should see it, no rush | default (normal) |
| Needs attention soon, even in Focus | `priority: "high"` (time-sensitive) |
| Must not be missed until someone responds | `priority: "high"` + `ack` |

Escalate on state *transitions* (healthy → down), send a matching
"recovered" push at normal priority, and don't repeat while the state holds.
Give the alert and its recovery the same `replaceKey` (e.g.
`"api-prod-health"`): the recovery then replaces the alert on the Lock
Screen instead of leaving a stale "down" behind, the feed keeps both as a
timeline, and any `ack` loop on the alert stops once it's replaced.

To be alerted when a scheduled job *doesn't run*, use a heartbeat instead of
sending pushes yourself: see the `pushr-heartbeats` skill.

## Ack-or-escalate

```json
{
  "title": "api-prod is down",
  "body": "5xx rate 38% across 3 regions",
  "priority": "high",
  "url": "https://status.example.com/incidents/91",
  "ack": { "timeoutSec": 120, "maxAttempts": 5 }
}
```

- `timeoutSec` (10–86400): seconds between re-pushes.
- `maxAttempts` (integer 1–20): re-pushes **after** the first send. `5` means up to 6 pushes.
- Re-pushes are time-sensitive and ignore quiet hours. A **muted** source app stays silent.
- Tapping the notification, or opening its `url`, acknowledges it and stops the loop.
- Unacknowledged pushes sit at the top of the pushr feed with an "ack needed" badge.
- With `deliverAt`, the ack timer starts from the delivery time.

CLI: `pushrsh "api-prod is down" "5xx 38%" -p high --ack 120/5`.

Pick `timeoutSec` from how long a response may reasonably take (60–300 s
for paging), and `maxAttempts` so the total window matches your escalation
policy (e.g. 120 s × 5 ≈ 10 minutes). After the last attempt pushr stops;
if you need a second person, escalate from your own system.

## On-call escalation (set by the app's owner)

If the source app is shared, its owner can set an on-call rotation in the
app (source app → **On-call**, Pro on pushr cloud). Then an urgent push (one
with `ack`, or priority 7+) reaches the first person on call only, and one
more person each unacknowledged round, instead of everyone at once.

- Rounds wait `ack.timeoutSec`, or the app's **Escalate after** (1–60 min)
  when the push has no `ack`; pushr extends the ack loop to reach everyone.
- Acknowledging on any phone stops it; weekly rotation moves who's first.
- The request doesn't change: send `ack` and `priority: "high"` as usual and
  let the app's settings decide who gets paged. Don't build your own
  rotation in the sender.

## Critical alerts (allowed by the app's owner)

`"critical": true` asks for an iOS critical alert, which plays its sound even
on mute and in Do Not Disturb. It only takes effect where the source app's
owner set **Critical alerts** to *Marked critical* (or *All urgent*, which
also covers every `ack`/priority 7+ push) and the phone granted permission;
otherwise it's an ordinary push. Reserve it for things that justify waking
someone through silent: safety, data loss, a production outage. Critical
alerts ignore quiet hours; a muted app stays silent. iOS rings through mute
only once Apple has approved pushr's entitlement; until then they arrive as
time-sensitive.

```json
{ "title": "Freezer above -10°C", "body": "Walk-in #2 · 4°C", "priority": "high", "critical": true, "ack": { "timeoutSec": 120, "maxAttempts": 5 } }
```

## Quiet hours and mutes (set by the user in the app)

- **Quiet hours** (per source app, Pro on pushr cloud): pushes arrive
  passively during the window, except ones with `ack`.
- **Mute** (per source app): nothing alerts, ack included; pushes still land in the feed.

These are the user's controls; senders don't override them. If the user
wants night-time silence except emergencies, tell them to set quiet hours
and send emergencies with `ack`.

## Webhook adapters (no code)

Point a provider's webhook at pushr. Auth is the source-app token, as a
header or in the URL:

```
$PUSHR_URL/hooks/github?token=$PUSHR_TOKEN
$PUSHR_URL/hooks/sentry?token=$PUSHR_TOKEN
$PUSHR_URL/hooks/grafana?token=$PUSHR_TOKEN
```

Prefer `Authorization: Bearer $PUSHR_TOKEN` where the provider allows custom
headers: a token in the query string can end up in the provider's logs.
Treat the URL as a secret either way.

### GitHub

Repo or org → Settings → Webhooks → payload URL above, content type
`application/json`. What gets pushed:

| Event | Sent when | Priority |
| ----- | --------- | -------- |
| `push` | Always | 5 |
| `pull_request` | Opened, reopened, ready for review, closed/merged | 6 when opened, else 5 |
| `issues` | Opened or reopened | 5 |
| `release` | Published | 7 |
| `workflow_run`, `check_run` | Failed or timed out (successes are ignored) | 8 |
| `deployment_status` | Finished | 8 on failure/error, else 6 |
| Any other event | Always | 5 |

Subscribe only to the events the user cares about (often just
`workflow_run` + `release`). Ignored events get `200 { ignored: true }`.

### Sentry

Internal Integration (or legacy webhook plugin) → webhook URL above. Level
→ priority: `debug` 2, `info` 4, `warning`/`warn` 6, `error` 8, `fatal` 9,
anything else 5.

### Grafana

Alerting → Contact points → Webhook → URL above. One push per alert batch,
titled `<ruleName> (<n> firing)`, and `<ruleName> resolved` at priority 4
when it clears. Severity label → priority: `info` 5, `warning` 6,
`high`/`error` 8, `critical`/`emergency` 9, anything else 6. Grafana doesn't
sign payloads, so the token is the only authentication.

### Signing secrets

GitHub (`X-Hub-Signature-256`, `sha256=<hex>`) and Sentry
(`Sentry-Hook-Signature`, hex) can sign deliveries. Set the same secret in
the provider and in pushr (source app → **API & token** → **Webhook
integrations**); unsigned or mismatched deliveries then get
`401 { "error": "Invalid signature" }`.

Adapters return `202 { id, scheduledFor: null }` when a push is queued and
`200 { ignored: true, provider }` when an event is skipped. Errors match
`/notify`, except there's no `409`: adapters take no `Idempotency-Key`.

## Need richer alerts than an adapter gives?

Send your own `POST /notify` from a small relay (a Worker or function that
receives the provider webhook), so you control the title, priority, `url`,
`ack` and `actions` (for example an "Acknowledge in PagerDuty" callback; see
the `pushr-actions` skill).
