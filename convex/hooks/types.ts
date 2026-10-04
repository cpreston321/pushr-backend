/**
 * Webhook adapter contract.
 *
 * Each adapter takes a parsed JSON payload plus the raw request headers
 * and returns a normalized notification, or `null` to silently drop the
 * event (e.g. GitHub's "ping" event on webhook creation).
 *
 * Adapters must not make network calls or touch the database — they are
 * pure functions over (payload, headers). The HTTP dispatcher handles
 * token auth, HMAC verification, ingestion and delivery.
 */

import type { NotifAction } from '../lib/actionsLayout';

export type NormalizedNotification = {
  title: string;
  body: string;
  priority?: number;
  url?: string;
  /** Optional deep-link/scheme tried before `url` on tap. */
  appUrl?: string;
  data?: Record<string, unknown>;
  image?: string;
  action?: { label: string; url: string };
  actions?: NotifAction[];
  /** Event name (e.g. "push", "pull_request.opened") — stored for observability */
  eventType?: string;
};

export type AdapterResult = NormalizedNotification | null;

export type Adapter = (payload: unknown, headers: Headers) => AdapterResult;
