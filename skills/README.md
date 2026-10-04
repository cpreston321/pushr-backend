# pushr agent skills

Task-focused guides that teach coding agents (Claude Code, Cursor, Codex and
others) how to integrate pushr correctly.

```bash
npx skills add cpreston321/pushr-backend
```

| Skill | Use it for |
| ----- | ---------- |
| [`pushr-notify`](pushr-notify/SKILL.md) | Sending a push from any language, script, CI job or cron: setup, fields, priority, retries, errors |
| [`pushr-actions`](pushr-actions/SKILL.md) | Buttons and replies on a notification, and the HTTPS endpoint that receives the taps |
| [`pushr-live-activities`](pushr-live-activities/SKILL.md) | Live progress on the Lock Screen and Dynamic Island for long-running jobs |
| [`pushr-alerts`](pushr-alerts/SKILL.md) | On-call alerting: time-sensitive pushes, ack-or-escalate, on-call rotations, critical alerts, quiet hours, GitHub/Sentry/Grafana webhooks |
| [`pushr-heartbeats`](pushr-heartbeats/SKILL.md) | Knowing when a cron job, backup or worker stops running, or a site or API stops answering: heartbeats, uptime checks and status pages |
| [`pushr-types`](pushr-types/SKILL.md) | Drop-in TypeScript types and client, Python types, and validation rules |

The same content is on the web for LLM tools: [pushr.sh/llms.txt](https://pushr.sh/llms.txt)
and, in a single file, [pushr.sh/llms-full.txt](https://pushr.sh/llms-full.txt).
