---
name: pushr-heartbeats
description: Monitor cron jobs, workers and backups with pushr heartbeats, websites and APIs with pushr uptime checks, and publish them on a public status page, so the user's phone is alerted when a job stops running or a URL stops answering, and again when it recovers. Use when the user asks to "tell me if my cron stops", "alert me if the backup didn't run", "dead man's switch", "monitor this scheduled job", "uptime monitoring", "tell me if my site goes down", "health check my API", "UptimeRobot / healthchecks.io / Cronitor style", "status page", or "make sure this worker is still alive".
---

# Heartbeats, uptime checks and status pages with pushr

Two monitors, one alert path:

- **Heartbeat:** the job pings pushr. Use it for anything that *runs*: cron,
  backups, queues, scheduled CI. Below first.
- **Uptime check:** pushr requests a URL. Use it for anything that *answers*:
  websites, APIs, health endpoints. See [Uptime checks](#uptime-checks).

## Heartbeats

A heartbeat catches the failure a notification can't report: a job that
silently stopped. The job pings pushr each time it runs; pushr pushes to the
phone when a ping is late or the job reports a failure, and again when it
recovers. Sending basics are in the `pushr-notify` skill. Full reference:
https://pushr.sh/llms-full.txt

Read `PUSHR_URL` and `PUSHR_TOKEN` from the environment or the scheduler's
secrets. Never paste the token into a crontab or code.

### The endpoints

All take `Authorization: Bearer $PUSHR_TOKEN`.

| Request | Meaning |
| ------- | ------- |
| `GET` or `POST /heartbeat/<name>` | The job ran. Starts a new window. |
| `POST /heartbeat/<name>/start` | The job started. Optional; the next ping then reports how long it took. |
| `POST /heartbeat/<name>/fail` | The job failed. Alerts at once; a text body (≤ 500 chars) becomes the alert text. |
| `DELETE /heartbeat/<name>` | Stop watching it. |

- `<name>`: up to 64 letters, digits, `.`, `-`, `_`, unique per source app.
  Name it after the job: `nightly-backup`, `invoice-sync`.
- `?every=`: how often the job runs, from `1m` to `30d` (`90s`, `15m`,
  `1h`, `1d`, or plain seconds). **Required on the first ping**, which
  creates the heartbeat; omit or repeat it afterwards (repeating keeps the
  config in code, which is better).
- `?grace=`: extra time past `every` before alerting, up to `7d`. Default
  20% of `every`, between 1 minute and 1 hour. Set it to the job's normal
  run-time spread: a backup that takes 10–40 minutes wants `grace=1h`.
- Response: `200 { ok, name, status: "up"|"down"|"paused", everySec, graceSec, dueAt }`.
  Errors: `400` bad name/interval or `code: "EVERY_REQUIRED"`, `401` bad
  token, `403 code: "PRO_REQUIRED"` (pushr cloud Free: 3 heartbeats per
  account; Pro: 100), `409 code: "HEARTBEAT_LIMIT"` (Pro's 100, or 50 on one
  app).

### Pick the integration

#### Crontab: ping after success

```cron
0 3 * * * /usr/local/bin/backup.sh && curl -fsS -m 10 --retry 3 -H "Authorization: Bearer $PUSHR_TOKEN" "$PUSHR_URL/heartbeat/nightly-backup?every=1d&grace=1h" >/dev/null
```

`&&` means a failed run doesn't ping, so it alerts as *missed* after the
grace period. Cron doesn't load shell profiles: put `PUSHR_URL` and
`PUSHR_TOKEN` at the top of the crontab or in the script's environment.

#### Any command: the CLI wrapper (best default)

```bash
pushrsh hb nightly-backup --every 1d --grace 1h -- /usr/local/bin/backup.sh
```

Pings start, then success or fail with the last 500 characters of output,
and exits with the command's status. Failures alert immediately instead of
waiting for the window to close.

#### Shell without the CLI

```bash
url="$PUSHR_URL/heartbeat/nightly-backup"
auth="Authorization: Bearer $PUSHR_TOKEN"
curl -fsS -m 10 -X POST -H "$auth" "$url/start?every=1d" || true
if out=$(/usr/local/bin/backup.sh 2>&1); then
  curl -fsS -m 10 -X POST -H "$auth" "$url" || true
else
  printf '%s' "$out" | tail -c 500 | curl -fsS -m 10 -X POST -H "$auth" --data-binary @- "$url/fail" || true
  exit 1
fi
```

#### TypeScript

```ts
import { heartbeat, withHeartbeat } from '@pushrsh/sdk';

// Wraps the job: start → success, or fail with the error, then rethrows.
await withHeartbeat('invoice-sync', { every: '15m' }, syncInvoices);

// A long-running worker: check in from its loop.
setInterval(() => heartbeat('queue-worker', { every: '5m' }).catch(() => {}), 60_000);
```

#### Python

```python
import os, requests

def ping(name, suffix="", body=None, every="1d"):
    try:
        requests.post(
            f"{os.environ['PUSHR_URL']}/heartbeat/{name}{suffix}",
            params={"every": every},
            headers={"Authorization": f"Bearer {os.environ['PUSHR_TOKEN']}"},
            data=body, timeout=10,
        )
    except requests.RequestException:
        pass  # monitoring must never break the job

ping("nightly-backup", "/start")
try:
    run_backup()
    ping("nightly-backup")
except Exception as e:
    ping("nightly-backup", "/fail", body=repr(e)[:500])
    raise
```

#### GitHub Actions (scheduled workflows)

```yaml
      - name: Check in
        if: success()
        run: curl -fsS -H "Authorization: Bearer ${{ secrets.PUSHR_TOKEN }}" "${{ secrets.PUSHR_URL }}/heartbeat/nightly-etl?every=1d&grace=2h"
      - name: Report failure
        if: failure()
        run: curl -fsS -X POST -H "Authorization: Bearer ${{ secrets.PUSHR_TOKEN }}" -d "Run ${{ github.run_id }} failed" "${{ secrets.PUSHR_URL }}/heartbeat/nightly-etl/fail"
```

GitHub can delay scheduled runs by many minutes, so give scheduled
workflows a generous `grace`.

### Rules that matter

- **Never let monitoring fail the job.** Short timeout, swallow ping errors
  (`|| true`, `.catch`, `try/except`).
- **Ping after the work, not before.** A ping at the start of a job that then
  crashes reports a healthy run. Use `/start` if you want the start recorded.
- **`every` is the schedule, not the run time.** A job every 15 minutes is
  `every=15m`, however long a run takes; cover run-time spread with `grace`.
- **Workers:** ping from the work loop (not a separate timer that keeps
  pinging while the loop is stuck), at a fraction of `every`.
- **Don't also send your own /notify on failure** from the same job: `/fail`
  already alerts, and recovery replaces it.

### What the user gets

| Event | Push | Priority |
| ----- | ---- | -------- |
| No ping by `dueAt` | "nightly-backup missed its check-in" · Expected every 1d. Last ping 1d 1h ago. | high |
| `/fail` | "nightly-backup failed" · the body, or "The job reported a failure." | high |
| Next successful ping | "nightly-backup is back up" · Down for 2h 14m. Took 3m 12s. | normal |

One alert per outage, and at most 3 down alerts an hour for a flapping job; recovery replaces the alert (replace key
`heartbeat:<name>`) and the feed keeps the history. Alerts follow the source
app's mutes and quiet hours and don't count toward the monthly quota; pings
never count. Lateness is checked every minute. In the app's **Monitors** tab the
user can see every heartbeat, and pause one during maintenance; pings are
recorded while paused, and only Resume in the app ends the pause.

## Uptime checks

```bash
curl -X PUT "$PUSHR_URL/uptime/api" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -d '{"url":"https://api.example.com/health","every":"1m","keyword":"ok"}'
```

Or `pushrsh uptime api https://api.example.com/health --every 1m --keyword ok`,
or `await uptime('api', { url, every: '1m', keyword: 'ok' })` from
`@pushrsh/sdk`. `PUT` is idempotent, so put it in deploy scripts or
infrastructure code to keep checks next to the services they watch.

| Field | Notes |
| ----- | ----- |
| `url` | `http`/`https` on a public host; private and internal addresses are refused. |
| `every` | `1m`–`1h`; on pushr cloud Free, one check and every 5 minutes at most often. |
| `method` | `GET` (default) or `HEAD`. |
| `keyword` | Body must contain it (≤ 200 chars). Best signal: check for text only a healthy page has, not just a 200. |
| `timeout` | 1–30 s, default 10. |
| `confirmAfter` | Failures in a row before alerting, 1–5, default 2. Keep 2+ for public sites to ride out blips. |

- Passes on status < 400 (redirects aren't followed: point it at the final
  URL), fails on ≥ 400, missing keyword, error or timeout.
- `GET /uptime/<name>` returns the state (`pending`, `up`, `down`,
  `paused`, last status code and latency); `DELETE` removes it.
- Alerts: *api is down* · HTTP 503 · api.example.com/health (high), then
  *api is back up* · Down for 12m. Responded in 182ms. Same rules as
  heartbeats: one per outage, replace key `uptime:<name>`, quota-free.
- Point it at a cheap health endpoint, not a heavy page; the check runs from
  pushr's servers (your own Convex deployment, if self-hosted) with user agent
  `pushr-uptime/1` (allow it through bot protection).

## Status pages

The user can publish chosen heartbeats and uptime checks at
`status.pushr.sh/<slug>` (**Monitors → + → Status page** in the app; Pro on pushr
cloud): current status, 90 days of uptime and recent incidents, never URLs or
error text. The data is public JSON at `GET $PUSHR_URL/status-page/<slug>`
(`title`, `overall`, `monitors[]` with `status`, `uptime`, 90 `days` of
`downMs`, and `incidents[]`) if they want it on their own site.

Outages that overlap across a page's monitors show as one incident, with a
timeline of what the checks saw. During an outage the user (or anyone who can
edit the app) can post updates for visitors from the dashboard or the app:
a title, then **Investigating → Identified → Monitoring → Resolved**, each with
a short message. If you're connected over MCP, the `incident_update` tool posts
one to a monitor's current or latest incident (`monitor`, `status`, `message`,
optional `title`). It's public, so draft it with the user unless they asked you
to post. Updates are Pro, with status pages.
