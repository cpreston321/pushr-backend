---
name: pushr-live-activities
description: Show live progress on the user's iPhone Lock Screen and Dynamic Island with pushr Live Activities (start / update / end). Use when the user asks to "show build/deploy progress on my lock screen", "track this job live", "Dynamic Island progress", "progress bar for my upload/backup/training/order", or wants a long-running script, CI pipeline, worker or delivery tracker to report progress as it runs.
---

# Live Activities with pushr

A Live Activity is a progress card on the Lock Screen and in the Dynamic
Island, driven by `POST /notify` with a `liveActivity` field. Sending basics
are in the `pushr-notify` skill. Full reference: https://pushr.sh/llms-full.txt

## Lifecycle

Three actions, all keyed by an `activityId` you choose:

1. **`start`**: once, when the job begins. Send `attributes` here (they're fixed for the activity's life).
2. **`update`**: as progress changes. Send only the new `state`.
3. **`end`**: exactly once, on success **and** on failure. Never leave an activity running.

```json
{
  "title": "Deploy #42",
  "body": "Building",
  "liveActivity": {
    "action": "start",
    "activityId": "deploy-42",
    "attributes": { "name": "ci.example.com" },
    "state": { "title": "Deploy #42", "status": "Building image", "progress": 0.1, "icon": "hammer.fill" }
  }
}
```

| Field | Rules |
| ----- | ----- |
| `activityId` | Required, non-empty. Stable per job (`deploy-42`, `backup-2026-10-02`), unique across concurrent jobs. Reusing an id restarts that activity. |
| `state` | **Required on every action**, including `update` and `end`. `title`, `status`, `progress` (0–1), `icon` (all optional inside). |
| `attributes` | `start` only: `name` (shown on the card, and its initial is the fallback icon), optional `logoUrl`. |
| `staleDate` | Optional, ms since epoch: when iOS should show the activity as stale. |
| `relevanceScore` | Optional, 0–1: ordering when several activities run. |
| top-level `title`/`body` | Required as for any push. |

`progress` and `relevanceScore` outside 0–1 are a `400`. `update`/`end` for
an unknown id still deliver as a normal push.

## Choosing `state.icon`

Any SF Symbol name; filled variants read best. Unknown or missing names fall
back to the initial of `attributes.name`.

| Job | Icons |
| --- | --- |
| Builds and deploys | `hammer.fill` `gearshape.2.fill` `terminal.fill` `testtube.2` `server.rack` |
| Transfers and backups | `arrow.up.circle.fill` `arrow.down.circle.fill` `arrow.triangle.2.circlepath` `externaldrive.fill` |
| Orders and deliveries | `shippingbox.fill` `box.truck.fill` `cart.fill` `creditcard.fill` `fork.knife` |
| Time and tracking | `timer` `hourglass` `calendar` `flag.checkered` `figure.run` |
| Home and devices | `house.fill` `lightbulb.fill` `thermometer.medium` `bolt.fill` `printer.fill` |
| Media | `play.fill` `film.fill` `music.note` `camera.fill` |
| Status | `checkmark.circle.fill` `xmark.octagon.fill` `exclamationmark.triangle.fill` `sparkles` |

On `end`, set `state.outcome` to `"success"` or `"failure"` and switch the
icon to `checkmark.circle.fill` or `xmark.octagon.fill`. A failure shows as
**Failed** in red and stays on the Lock Screen until it's seen (up to 4
hours); a success shows **Done** and leaves after 15 minutes. `dismissAfter`
(seconds, 0–14400) on the `end` overrides how long a success stays; a failure
ignores it.

## TypeScript SDK

```ts
import { liveActivity } from "@pushrsh/sdk"; // reads PUSHR_URL and PUSHR_TOKEN

const la = liveActivity(`deploy-${build.id}`, { name: "ci.example.com" });
await la.start({ title: `Deploy #${build.id}`, status: "Building image", progress: 0, icon: "hammer.fill" });
try {
  await build.run(async (pct, step) => la.update({ title: `Deploy #${build.id}`, status: step, progress: pct }));
  await la.end({ title: `Deploy #${build.id}`, status: "Live", progress: 1, icon: "checkmark.circle.fill" });
} catch (err) {
  await la.end({ title: `Deploy #${build.id}`, status: "Failed", icon: "xmark.octagon.fill" });
  throw err;
}
```

The handle sends `attributes` with every call and uses `state.title` /
`state.status` as the push's title and body. `start` and `update` take an
optional `{ staleDate, relevanceScore }`.

## CLI

```bash
pushrsh la start  deploy-42 --title "Deploy #42" --status Building --progress 0 --icon hammer.fill --name ci.example.com
pushrsh la update deploy-42 --status "Tests pass" --progress 0.6
pushrsh la end    deploy-42 --status Live
pushrsh la test                      # a demo activity, to check the phone receives them
```

In a shell script, end the activity from a `trap` so a crash still ends it:

```bash
ID="backup-$(date +%Y%m%d)"
pushrsh la start "$ID" --title "Nightly backup" --status Starting --progress 0 --icon externaldrive.fill
trap 'pushrsh la end "$ID" --status Failed' ERR
rsync … && pushrsh la update "$ID" --status Verifying --progress 0.8
pushrsh la end "$ID" --status Done
```

## Good practice

- **Update on meaningful change**: a new step, or progress moving a few
  percent. Not every loop tick; throttle to roughly one update every few seconds.
- **Status text is the headline**: "Running tests (212/380)", not "In progress".
- **Always end** in `finally`/`trap`, with the real outcome: `outcome:
  "failure"` on error, so it doesn't read as finished successfully.
- Unknown total? Omit `progress` and keep `status` descriptive.
- Pair with a normal push for the final result if the user should be
  alerted (`priority: "high"` on failure).

## When it doesn't show

- The user needs iOS 16.2+ with Live Activities allowed for pushr (Settings → pushr → Live Activities).
- `start` needs the phone to have registered for push-to-start, which the app does on first launch.
- Self-hosted servers need the `APNS_*` variables set (`APNS_AUTH_KEY`,
  `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`).
  Without `APNS_AUTH_KEY` the `liveActivity` field is ignored and a normal
  push is delivered instead.
