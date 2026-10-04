/**
 * A dependency-free pushr client for any fetch runtime, with idempotent
 * retries (which @pushrsh/sdk doesn't do). Pairs with ./types.ts.
 */
import type {
  HealthResponse,
  HeartbeatQuery,
  HeartbeatResponse,
  NotifyInput,
  NotifyResponse,
  PushrErrorBody
} from './types';

export class PushrError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: PushrErrorBody
  ) {
    super(message);
    this.name = 'PushrError';
  }
  /** 5xx and network errors are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface PushrClientOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** Attempts for retryable failures when an idempotencyKey is given. Default 4. */
  maxAttempts?: number;
}

export function createPushr({ url, token, fetch: f = fetch, maxAttempts = 4 }: PushrClientOptions) {
  const base = url.replace(/\/+$/, '');

  async function once(input: NotifyInput, idempotencyKey?: string): Promise<NotifyResponse> {
    let res: Response;
    try {
      res = await f(`${base}/notify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
        },
        body: JSON.stringify(input)
      });
    } catch (err) {
      throw new PushrError(err instanceof Error ? err.message : 'Network error', 0);
    }
    if (res.ok) return (await res.json()) as NotifyResponse;
    const body = (await res.json().catch(() => undefined)) as PushrErrorBody | undefined;
    throw new PushrError(body?.error ?? `HTTP ${res.status}`, res.status, body);
  }

  return {
    /**
     * Sends one notification. With an idempotencyKey (≤ 255 chars, e.g. a job id),
     * retryable failures are retried with backoff and can never send twice.
     */
    async notify(input: NotifyInput, opts: { idempotencyKey?: string } = {}): Promise<NotifyResponse> {
      const attempts = opts.idempotencyKey ? maxAttempts : 1;
      for (let i = 1; ; i++) {
        try {
          return await once(input, opts.idempotencyKey);
        } catch (err) {
          if (!(err instanceof PushrError) || !err.retryable || i >= attempts) throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
        }
      }
    },

    /** Check in a heartbeat; `kind` "start" or "fail" (with `message`) for those events. */
    async heartbeat(
      name: string,
      opts: HeartbeatQuery & { kind?: 'start' | 'fail'; message?: string } = {}
    ): Promise<HeartbeatResponse> {
      const query = new URLSearchParams();
      if (opts.every !== undefined) query.set('every', String(opts.every));
      if (opts.grace !== undefined) query.set('grace', String(opts.grace));
      const res = await f(
        `${base}/heartbeat/${encodeURIComponent(name)}${opts.kind ? `/${opts.kind}` : ''}${query.size ? `?${query}` : ''}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: opts.message }
      );
      if (res.ok) return (await res.json()) as HeartbeatResponse;
      const body = (await res.json().catch(() => undefined)) as PushrErrorBody | undefined;
      throw new PushrError(body?.error ?? `HTTP ${res.status}`, res.status, body);
    },

    async health(): Promise<HealthResponse> {
      const res = await f(`${base}/healthz`);
      if (!res.ok) throw new PushrError(`HTTP ${res.status}`, res.status);
      return (await res.json()) as HealthResponse;
    }
  };
}
