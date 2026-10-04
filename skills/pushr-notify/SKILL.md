---
name: pushr-notify
description: Send push notifications to the user's iPhone with pushr (POST /notify), from any language, script, server, CI job or cron. Use when the user asks to "notify me when…", "send a push to my phone", "ping me when the build/deploy/job finishes", "alert me if this fails", "add pushr to my app/script", or wants notifications from GitHub Actions, a cron job, a backend or a CLI. Covers setup (URL and token), the request fields, priority, links and images, scheduling, idempotent retries, errors, the TypeScript SDK and the pushrsh CLI.
---

# Send notifications with pushr

pushr turns one HTTP request into a push notification on the user's iPhone.
Everything goes through `POST $PUSHR_URL/notify` with a source-app bearer
token. Full reference: https://pushr.sh/llms-full.txt

## 1. Setup: URL and token

Two values, always from the environment, never hard-coded or committed:

| Variable      | What it is                                                                 |
| ------------- | -------------------------------------------------------------------------- |
| `PUSHR_URL`   | The server's site URL. pushr cloud: shown in the app's **API & token** sheet. Self-hosted: `https://<deployment>.convex.site`. |
| `PUSHR_TOKEN` | A source-app token, `pshr_…`, created in the app's **Apps** tab. Shown once. |

Each source app is one sender (a CI, a service, a script). Use one token per
sender so the user can mute or revoke it alone. If the user hasn't got a
token yet, tell them: open pushr → Apps → + → name it → copy the token.

When adding pushr to a project: read these from env (`.env`, CI secrets,
your platform's secret store), add them to `.env.example` without values,
and make sure `.env` is git-ignored.

## 2. The request

```bash
curl -X POST "$PUSHR_URL/notify" \
  -H "Authorization: Bearer $PUSHR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Build succeeded","body":"main → staging"}'
```

Required: `title` and `body` (`message` is accepted as an alias for `body`).

| Field        | Type                  | Use it for |
| ------------ | --------------------- | ---------- |
| `priority`   | `1`–`10`, or `"low"`/`"normal"`/`"default"`/`"high"` | How hard it interrupts. See below. Default normal. |
| `url`        | string                | Opened when the notification is tapped. |
| `image`      | string (URL)          | Thumbnail on the banner. |
| `data`       | object                | Arbitrary JSON passed to the app. |
| `deliverAt`  | number, ms since epoch | Send later. Must be a number (an ISO string is ignored and it sends now) and ≥ now − 60 s. |
| `replaceKey` | string, max 128       | A newer push with the same key replaces this one on the phone and in the feed. See below. |
| `critical`   | boolean               | Ring through mute where the app's owner allows critical alerts: use the `pushr-alerts` skill. |
| `actions`    | array, max 4          | Buttons and replies: use the `pushr-actions` skill. |
| `ack`        | `{ timeoutSec, maxAttempts }` | Re-push until acknowledged: use the `pushr-alerts` skill. |
| `liveActivity` | object              | Lock Screen / Dynamic Island progress: use the `pushr-live-activities` skill. |

Success is `202 { "id": "…", "scheduledFor": null | <ms> }`.

## 3. Choosing a priority

Pick by what the user needs to do, not by how important the event feels:

| Priority | iOS behaviour | Use for |
| -------- | ------------- | ------- |
| `1`–`3` / `"low"` | Passive: lands quietly in Notification Center, no sound, screen stays off | FYIs, digests, "nightly backup done" |
| `4`–`6` / `"normal"` (default) | A normal banner and sound | Most things: build passed, order received |
| `7`–`10` / `"high"` | Time-sensitive: breaks through Focus | Needs attention soon: prod down, payment failed |

Don't default everything to high: it trains the user to ignore it. During a
source app's quiet hours, pushes arrive passively unless they need an ack.

## 4. Pick the client

- **Shell, CI, cron:** curl (above) or the `pushrsh` CLI.
- **TypeScript / JavaScript (any fetch runtime: Node 18+, Bun, Deno, Workers, edge):** `@pushrsh/sdk`.
- **Anything else:** a plain HTTPS POST. Python and Go below.

### TypeScript SDK

```ts
// bun add @pushrsh/sdk   (or npm i @pushrsh/sdk)
import { notify, PushrError } from "@pushrsh/sdk"; // reads PUSHR_URL and PUSHR_TOKEN

await notify({ title: "New sale", body: "$42 from Acme", priority: "high", url: "https://dash.example.com/orders/981" });
```

For explicit config (several tokens, or env names you don't control):

```ts
import { Pushr } from "@pushrsh/sdk";
const pushr = new Pushr({ url: process.env.PUSHR_URL!, token: process.env.PUSHR_TOKEN! });
await pushr.notify({ title: "Backup done", body: "18 TB verified", priority: "low" });
```

`deliverAt` accepts a `Date` in the SDK. Failures throw `PushrError` with
`status`, `code` and `data`. The SDK does not send `Idempotency-Key`; when a
retry must not double-send, call `fetch` directly (section 6).

### CLI

```bash
# brew install cpreston321/tap/pushrsh   (reads PUSHR_URL and PUSHR_TOKEN)
pushrsh "Deploy finished" "main → production" -p high -u https://example.com/deploys/42
tail -n 20 build.log | pushrsh "Build failed" -p high      # stdin becomes the body
pushrsh "Standup" "Time to gather" --at +15m               # schedule
pushrsh ping                                               # check the server
```

Other flags: `-i URL` image, `-d KEY=VALUE` data (repeatable),
`--ack 60/5`, `-r KEY` replace key, `--json FILE|-` to send a raw body, `-q`
to print only the id. `pushrsh hb NAME --every 1d -- COMMAND` wraps a cron
job in a heartbeat: see the `pushr-heartbeats` skill.

### Python

```python
import os, requests

def notify(title: str, body: str, **fields) -> dict:
    res = requests.post(
        f"{os.environ['PUSHR_URL']}/notify",
        headers={"Authorization": f"Bearer {os.environ['PUSHR_TOKEN']}"},
        json={"title": title, "body": body, **fields},
        timeout=10,
    )
    res.raise_for_status()
    return res.json()

notify("Training finished", "val_loss 0.231 after 12 epochs", url="https://wandb.ai/run/abc")
```

### Go

```go
body, _ := json.Marshal(map[string]any{"title": "Job done", "body": "3,402 rows imported"})
req, _ := http.NewRequest("POST", os.Getenv("PUSHR_URL")+"/notify", bytes.NewReader(body))
req.Header.Set("Authorization", "Bearer "+os.Getenv("PUSHR_TOKEN"))
req.Header.Set("Content-Type", "application/json")
res, err := http.DefaultClient.Do(req)
```

### GitHub Actions

```yaml
- name: Notify phone
  if: always()
  env:
    PUSHR_URL: ${{ secrets.PUSHR_URL }}
    PUSHR_TOKEN: ${{ secrets.PUSHR_TOKEN }}
  run: |
    curl -fsS -X POST "$PUSHR_URL/notify" \
      -H "Authorization: Bearer $PUSHR_TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -n --arg s "${{ job.status }}" --arg r "$GITHUB_REPOSITORY" \
            '{title: "\($r): \($s)", body: "${{ github.workflow }} on ${{ github.ref_name }}",
              priority: (if $s == "success" then "normal" else "high" end),
              url: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}')"
```

Build JSON with `jq` (or your language's encoder), never by string
concatenation: titles with quotes or newlines would break the body.

## 5. Writing good notifications

- **Title:** the outcome in a few words ("Deploy #482 failed"), not the system name.
- **Body:** the one detail that decides what to do next ("tests: 3 failed in auth").
- **`url`:** where the user would go next: the run, the order, the dashboard.
- Notify on transitions (failed, recovered, finished), not on every poll.
- For a state that keeps changing (disk usage, a queue, a deploy's stage),
  send every push with the same `replaceKey`, e.g. `"disk-db-1"`. Each one
  replaces the last, so the Lock Screen shows only the current state and the
  feed keeps the earlier ones as a timeline. Keys are per source app. For
  second-by-second progress, use a Live Activity instead.
- To know when a cron job or worker *stops* running, don't build it from
  `/notify`: use a heartbeat (the `pushr-heartbeats` skill).

## 6. Errors and safe retries

| Status | Meaning | What to do |
| ------ | ------- | ---------- |
| `202` | Accepted | Done. |
| `200` + `Idempotent-Replay: true` | A retry with a key already used | Done; nothing was sent twice. |
| `400` | Bad request (`error` says why) | Fix the payload; don't retry. |
| `401` | Missing, invalid or revoked token | Check `PUSHR_TOKEN`; don't retry. |
| `403` | App disabled, or `code: "APP_PAUSED"` (cloud: Free plan over its app limit) | Tell the user; don't retry. |
| `409` `IDEMPOTENCY_KEY_REUSED` | Same key, different body | A bug in the sender; use a new key per distinct message. |
| `429` `RATE_LIMITED` | Over 120 pushes a minute from this source app | Wait the `Retry-After` seconds, then retry. |
| `429` `QUOTA_EXCEEDED` | Monthly quota reached (pushr cloud) | Stop and tell the user; don't retry until next month. |
| `5xx`, network error | Transient | Retry with backoff, with an `Idempotency-Key`. |

To retry without ever sending twice, send the same `Idempotency-Key` header
(≤ 255 chars, e.g. a job id) on every attempt. Keys are per source app and
remembered for at least 24 hours; replays don't count toward the quota.

```ts
async function notifyOnce(key: string, payload: object) {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(`${process.env.PUSHR_URL}/notify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PUSHR_TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt === 4) throw err; // network error: retried
    }
    if (res?.ok) return res.json();
    // Rate limited: wait as long as the server says, then try again.
    const wait = res?.status === 429 ? Number(res.headers.get("Retry-After")) : NaN;
    if (wait > 0 && attempt < 4) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    // Any other 4xx won't succeed on a retry.
    if (res && res.status < 500) throw new Error(`pushr ${res.status}: ${(await res.json()).error}`);
    if (attempt === 4) throw new Error(`pushr ${res?.status ?? "unreachable"}`);
    await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
  }
}
```

A notification must never break the job it reports on: wrap the call so a
pushr failure is logged, not thrown, unless the user asked otherwise.

## 7. Limits (pushr cloud)

Free: 1,000 pushes a month and 1 source app. Pro: 10,000 a month and
unlimited apps. Self-hosted servers have no plans or push quota (just 50
uptime checks per account, 50 heartbeats per app, 90 days of history). Check the server with
`GET $PUSHR_URL/healthz` → `{ "ok": true, "version": …, "selfHosted": … }`.
