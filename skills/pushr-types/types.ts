/**
 * pushr HTTP API types, matching @pushrsh/sdk. Copy into a project that
 * can't take the SDK as a dependency. Reference: https://pushr.sh/llms-full.txt
 */

/** 1–3 passive, 4–6 normal (default), 7–10 time-sensitive. Strings: low=3, normal/default=5, high=8. */
export type Priority = 'low' | 'normal' | 'default' | 'high' | number;

export type Action =
  | { kind: 'open_url'; id: string; label: string; url: string; destructive?: boolean }
  | { kind: 'callback'; id: string; label: string; callbackUrl: string; destructive?: boolean; authRequired?: boolean }
  | { kind: 'reply'; id: string; label: string; callbackUrl: string; placeholder?: string };

export interface AckConfig {
  /** 10–86400 seconds between re-pushes. */
  timeoutSec: number;
  /** 1–20 re-pushes after the initial send. */
  maxAttempts: number;
}

export interface LiveActivityState {
  title?: string;
  status?: string;
  /** 0–1 */
  progress?: number;
  /** An SF Symbol name, e.g. "hammer.fill". */
  icon?: string;
  /** On end: success shows green; failure shows red and stays until dismissed. */
  outcome?: 'success' | 'failure';
}

export interface LiveActivityAttributes {
  name?: string;
  logoUrl?: string;
}

export interface LiveActivityPayload {
  action: 'start' | 'update' | 'end';
  /** Stable per job; reused for update and end. */
  activityId: string;
  /** Required on every action. */
  state: LiveActivityState;
  /** Only on start. */
  attributes?: LiveActivityAttributes;
  /** ms since epoch */
  staleDate?: number;
  /** 0–1 */
  relevanceScore?: number;
  /** On end: seconds a finished activity stays, 0–14400. A failure ignores it. */
  dismissAfter?: number;
}

/** Body of POST /notify. */
export interface NotifyInput {
  title: string;
  body: string;
  priority?: Priority;
  url?: string;
  image?: string;
  data?: Record<string, unknown>;
  /** Legacy single button; `actions` wins if both are set. */
  action?: { label: string; url: string };
  /** At most 4; unique ids; at most one reply. */
  actions?: Action[];
  ack?: AckConfig;
  liveActivity?: LiveActivityPayload;
  /** ms since epoch, ≥ now − 60 s. Must be a number on the wire. */
  deliverAt?: number;
  /** ≤ 128 chars, per source app. A newer push with the same key replaces this one. */
  replaceKey?: string;
  /** Ring through mute, where the source app's owner allows critical alerts. */
  critical?: boolean;
}

/** 202 Accepted, or 200 with `Idempotent-Replay: true` for a replayed Idempotency-Key. */
export interface NotifyResponse {
  id: string;
  scheduledFor: number | null;
}

/** A bad or revoked token is a plain 401 `{ error: "Invalid token" }`, with no code. */
export type PushrErrorCode =
  | 'APP_PAUSED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'EVERY_REQUIRED'
  | 'HEARTBEAT_LIMIT'
  | 'PRO_REQUIRED'
  | 'UPTIME_LIMIT';

/** Every error response: 400, 401, 403, 409, 429, 500. */
export interface PushrErrorBody {
  error: string;
  code?: PushrErrorCode | string;
  /** On QUOTA_EXCEEDED. */
  tier?: string;
  count?: number;
  limit?: number;
  /** pushr cloud, on QUOTA_EXCEEDED and APP_PAUSED, when configured. */
  upgrade?: string;
}

/** GET /healthz */
export interface HealthResponse {
  ok: true;
  version: string;
  selfHosted: boolean;
  appleSignIn: boolean;
}

/** What pushr POSTs to an action's callbackUrl. Headers: X-Pushr-Notification, X-Pushr-Action, X-Pushr-Source: pushr. */
export interface ActionCallbackPayload {
  notificationId: string;
  actionId: string;
  /** ms since epoch */
  respondedAt: number;
  /** kind: "reply" only; up to 2,000 characters. */
  reply?: string;
}

/**
 * `/heartbeat/<name>[/start|/fail]` query. An interval is seconds, or a number
 * with s, m, h or d ("15m"). `every` (1m–30d) is required on the first ping.
 */
export interface HeartbeatQuery {
  every?: string | number;
  /** ≤ 7d. Default 20% of every, clamped to 1m–1h. */
  grace?: string | number;
}

/** 200 from GET/POST /heartbeat/<name>, /start and /fail. */
export interface HeartbeatResponse {
  ok: true;
  name: string;
  status: 'up' | 'down' | 'paused';
  everySec: number;
  graceSec: number;
  /** When pushr alerts if no ping arrives; null while down or paused. */
  dueAt: number | null;
}

/** PUT /uptime/<name> body. Intervals are seconds or "1m".."1h". */
export interface UptimeCheckInput {
  url: string;
  every: string | number;
  method?: 'GET' | 'HEAD';
  /** ≤ 200 chars; not with HEAD. */
  keyword?: string;
  /** Seconds, 1–30. Default 10. */
  timeout?: number | string;
  /** Failures in a row before alerting, 1–5. Default 2. */
  confirmAfter?: number;
}

/** 200 from PUT and GET /uptime/<name>. */
export interface UptimeCheck {
  ok: true;
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  intervalSec: number;
  timeoutSec: number;
  keyword: string | null;
  confirmAfter: number;
  status: 'pending' | 'up' | 'down' | 'paused';
  lastCheckedAt: number | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  downSince: number | null;
}

/** GET /status-page/<slug>, public. */
export interface StatusPageView {
  title: string;
  description: string | null;
  logoUrl: string | null;
  logoShape: 'circle' | 'free' | 'square';
  /** Hex color, e.g. "#3E7BFA". */
  accent: string | null;
  theme: 'auto' | 'light' | 'dark';
  websiteUrl: string | null;
  announcement: { text: string; tone: 'info' | 'maintenance' | 'warning' } | null;
  overall: 'operational' | 'degraded' | 'outage';
  updatedAt: number;
  monitors: {
    label: string;
    /** The page's section heading for this monitor, if it has one. */
    group: string | null;
    kind: 'heartbeat' | 'uptime';
    status: 'pending' | 'up' | 'down' | 'paused';
    downSince: number | null;
    /** 0–1 over the last 90 days, or since the monitor was created. */
    uptime: number | null;
    /** 90 days, oldest first; downMs is -1 before the monitor existed. */
    days: { date: string; downMs: number }[];
    /** When the monitor was created, ms since epoch. */
    since: number;
    /** Its outages in the window: [start, end], end null while ongoing. */
    downtime: [number, number | null][];
  }[];
  /** Newest first, up to 50 from 90 days; overlapping outages across monitors are one incident. */
  incidents: {
    /** The monitors' names joined ("API and Website"), and the first outage's reason. */
    monitor: string;
    reason: string;
    startedAt: number;
    endedAt: number | null;
    /** Set by the page's owner with an update; null until then. */
    title: string | null;
    /** The latest update's status. */
    status: IncidentStatus | null;
    monitors: {
      label: string;
      reason: string;
      startedAt: number;
      endedAt: number | null;
      firstFailedAt: number | null;
      statusCode: number | null;
      latencyMs: number | null;
      recoveredStatusCode: number | null;
      recoveredLatencyMs: number | null;
    }[];
    /** Oldest first. */
    updates: { status: IncidentStatus; body: string; at: number }[];
  }[];
}

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

/** Webhook adapter (/hooks/github, /hooks/sentry, /hooks/grafana) responses. */
export type AdapterResponse = NotifyResponse | { ignored: true; provider: 'github' | 'sentry' | 'grafana' };
