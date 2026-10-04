import type { Doc } from '../_generated/dataModel';

const WEEK_MS = 7 * 86_400_000;
export const ON_CALL_MAX_PEOPLE = 10;

/** Who's on call, first to last, for this moment; null when on-call is off. */
export function onCallOrder(app: Doc<'sourceApps'>, now: number): string[] | null {
  const oc = app.onCall;
  if (!oc?.enabled || oc.userIds.length === 0) return null;
  if (oc.rotation !== 'weekly' || oc.userIds.length === 1) return oc.userIds;
  const shift = Math.floor(Math.max(0, now - oc.rotationStartedAt) / WEEK_MS) % oc.userIds.length;
  return [...oc.userIds.slice(shift), ...oc.userIds.slice(0, shift)];
}

type Ack = { timeoutSec: number; maxAttempts: number };

/**
 * An urgent push (an `ack`, or priority 7+) on an app with on-call goes to
 * the first person and widens by one each ack round, so it needs an ack loop
 * long enough to reach everyone: the sender's, stretched if it's too short,
 * or one paced by the app's escalation delay.
 */
export function escalationFor(
  app: Doc<'sourceApps'>,
  n: { priority?: number; ack?: Ack },
  now: number
): { escalation?: { order: string[]; level: number }; ack?: Ack } {
  const urgent = n.ack !== undefined || (n.priority ?? 0) >= 7;
  const order = urgent ? onCallOrder(app, now) : null;
  if (!order || order.length < 2) return { ack: n.ack };
  const rounds = Math.min(20, Math.max(n.ack?.maxAttempts ?? 0, order.length));
  return {
    escalation: { order, level: 0 },
    ack: { timeoutSec: n.ack?.timeoutSec ?? app.onCall!.escalateAfterSec, maxAttempts: rounds }
  };
}
