/**
 * Is it currently inside the quiet-hours window [quietStart, quietEnd), in
 * minutes since midnight in `timeZone`? The window may wrap past midnight.
 */
export function isInQuietHours(
  quietStart: number | undefined,
  quietEnd: number | undefined,
  timeZone: string | undefined,
  now: Date = new Date()
): boolean {
  if (quietStart === undefined || quietEnd === undefined) return false;
  if (quietStart === quietEnd) return false;
  const mins = minutesInZone(now, timeZone ?? 'UTC');
  if (quietStart < quietEnd) {
    return mins >= quietStart && mins < quietEnd;
  }
  return mins >= quietStart || mins < quietEnd;
}

function minutesInZone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return get('hour') * 60 + get('minute');
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}
