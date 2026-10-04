---
name: pushr-actions
description: Add tappable buttons and inline replies to pushr notifications, and implement the HTTPS endpoint that receives the taps. Use when the user asks for "approve/reject from my phone", "a button on the notification", "let me confirm/deny/retry from the push", "reply to the notification", "human-in-the-loop approval", "deploy gate", or needs to build or secure a pushr callback endpoint (Express, Hono, Next.js, FastAPI, Workers…).
---

# Notification actions and callbacks

Add up to **4** `actions` to a `POST /notify` request (sending basics are in
the `pushr-notify` skill). Full reference: https://pushr.sh/llms-full.txt

## The three kinds

| `kind`     | Required fields | Optional | What happens on tap |
| ---------- | --------------- | -------- | ------------------- |
| `callback` | `id`, `label`, `callbackUrl` | `destructive`, `authRequired` | pushr POSTs to `callbackUrl` |
| `reply`    | `id`, `label`, `callbackUrl` | `placeholder` | Inline text field; pushr POSTs the text |
| `open_url` | `id`, `label`, `url` | `destructive` | Opens `url` on the phone; nothing is POSTed |

Validation (a `400` otherwise): `id`s unique within the notification, at
most one `reply`, a known `kind`. Reply text is capped at 2,000 characters.

## Designing the buttons

- **A decision (yes/no):** one `callback` per answer, mark the risky one
  `destructive`. Callbacks on one notification are a single choice: once one
  goes through, the others are refused ("Already answered") on every device,
  so your endpoint hears exactly one answer.
- **Several independent buttons** (not one answer): send separate notifications.
- **Context:** add an `open_url` (logs, diff, order) next to the decision.
- `reply` and `open_url` stay usable after the decision.
- Lock Screen banners show generic labels ("Action 1", "Reply") because iOS
  needs categories registered ahead of time; the pushr feed shows your real
  labels. Keep labels short and put the meaning in the title/body too.

```json
{
  "title": "Staging deploy ready",
  "body": "a1f93c · 38 checks passed. Promote to production?",
  "priority": "high",
  "actions": [
    { "kind": "callback", "id": "approve", "label": "Approve", "callbackUrl": "https://ci.example.com/hooks/pushr/deploy/42?key=SECRET" },
    { "kind": "callback", "id": "reject", "label": "Reject", "callbackUrl": "https://ci.example.com/hooks/pushr/deploy/42?key=SECRET", "destructive": true },
    { "kind": "open_url", "id": "logs", "label": "Logs", "url": "https://ci.example.com/deploy/42" }
  ]
}
```

One `callbackUrl` for every button is fine: the action id arrives in the
request, so one handler can branch on it.

## What your endpoint receives

```
POST <callbackUrl>
Content-Type: application/json
User-Agent: pushr/1.0
X-Pushr-Source: pushr
X-Pushr-Notification: <notificationId>
X-Pushr-Action: <action id>

{ "notificationId": "…", "actionId": "approve", "respondedAt": 1712160000000, "reply": "LGTM" }
```

`reply` is present only for `kind: "reply"`.

Rules that shape the implementation:

- `callbackUrl` must be **public `https://`**: no localhost, private or
  link-local addresses, no embedded credentials. Redirects aren't followed.
  For local development, expose the endpoint through a tunnel.
- pushr waits **10 seconds**, then counts the tap as failed. Respond fast;
  queue slow work and return `200` immediately.
- Any `2xx` counts as success. A network error or `4xx`/`5xx` leaves the
  choice open, so the user can tap again. Return non-2xx only when you
  want them to be able to retry.
- pushr stores only your status code, never the response body.
- **Requests are unsigned.** Authenticate with a secret in the URL
  (`?key=…`, compared in constant time) or a path segment you can verify.
- Make the handler idempotent: key on `notificationId` + `actionId`.
- Viewers of a shared app can open links but can't trigger callbacks or replies.

## Implementations

### Hono (Workers, Bun, Node)

```ts
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";

const app = new Hono();

app.post("/hooks/pushr/deploy/:id", async (c) => {
  const key = c.req.query("key") ?? "";
  const expected = process.env.PUSHR_CALLBACK_KEY!;
  if (key.length !== expected.length || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    return c.text("forbidden", 403);
  }
  const { notificationId, actionId, reply } = await c.req.json<{
    notificationId: string;
    actionId: string;
    respondedAt: number;
    reply?: string;
  }>();
  if (await alreadyHandled(notificationId, actionId)) return c.text("ok"); // idempotent
  await enqueue({ deploy: c.req.param("id"), decision: actionId, note: reply }); // don't block the 10 s window
  return c.text("ok");
});
```

### Express

```ts
app.post("/hooks/pushr/deploy/:id", express.json(), async (req, res) => {
  if (!validKey(req.query.key)) return res.sendStatus(403);
  const { notificationId, actionId, reply } = req.body;
  await queue.add("deploy-decision", { id: req.params.id, notificationId, actionId, reply });
  res.sendStatus(200);
});
```

### Next.js route handler

```ts
// app/api/pushr/route.ts
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!validKey(url.searchParams.get("key"))) return new Response("forbidden", { status: 403 });
  const { notificationId, actionId, reply } = await req.json();
  await recordDecision(notificationId, actionId, reply);
  return new Response("ok");
}
```

### FastAPI

```python
@app.post("/hooks/pushr/deploy/{deploy_id}")
async def pushr_callback(deploy_id: str, key: str, payload: dict):
    if not hmac.compare_digest(key, os.environ["PUSHR_CALLBACK_KEY"]):
        raise HTTPException(403)
    await queue.put((deploy_id, payload["notificationId"], payload["actionId"], payload.get("reply")))
    return {"ok": True}
```

## Waiting for an answer (approval gates)

To block a job until the user decides: send the notification, store
`{ notificationId → job }`, and have the callback resolve it. Poll your own
store with a timeout and pick a safe default (usually "reject") if no answer
arrives. For a decision that must not be missed, combine with `ack` (see
`pushr-alerts`) so the push keeps re-alerting until it's opened.

## Other entry points

- SDK: `notify({ ..., actions: [...] })`; the `Action` type in `@pushrsh/sdk`
  matches the table above.
- CLI: `pushrsh "PR ready" "+812 / -96" -a "View=https://example.com/pr/318"`
  adds a single legacy link button (`action: { label, url }`); use `--json`
  for callbacks or replies.
