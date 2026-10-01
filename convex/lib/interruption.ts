export type InterruptionLevel = 'passive' | 'active' | 'time-sensitive' | 'critical';

/**
 * How hard a push may interrupt on iOS.
 *
 * Time-sensitive breaks through Focus and the notification summary (it needs
 * the time-sensitive entitlement, set in app.json). Passive delivers silently
 * without lighting the screen. Critical would also ring on silent, but needs
 * Apple's approval for the critical-alerts entitlement, so it isn't used yet.
 */
export function interruptionLevelFor(n: {
  priority: number | undefined;
  needsAck: boolean;
  escalation: boolean;
  quiet: boolean;
}): InterruptionLevel {
  if (n.escalation || n.needsAck) return 'time-sensitive';
  if (n.quiet) return 'passive';
  if (n.priority !== undefined && n.priority >= 7) return 'time-sensitive';
  if (n.priority !== undefined && n.priority <= 3) return 'passive';
  return 'active';
}
