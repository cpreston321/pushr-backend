/**
 * Android notification channels the app creates (apps/mobile/lib/push.ts).
 * On Android 8+ a notification's sound and importance come from its channel,
 * not from the push, so each bundled sound has its own channel and the server
 * picks one per push. iOS ignores `channelId` and keeps using `sound`.
 *
 * Keep these ids in sync with the app: a channel the app never created makes
 * Android fall back to its default one.
 */
export const ANDROID_SOUND_IDS = [
  'tap',
  'drop',
  'pulse',
  'wire',
  'kalimba',
  'spark',
  'orbit',
  'glass',
  'bell',
  'cashout',
  'pending',
  'escalate',
  'klaxon'
] as const;

/** Rings through Do Not Disturb where the person allowed it. */
export const ANDROID_CRITICAL_CHANNEL = 'pushr.critical';
/** No sound: quiet hours, or the person picked Silent. */
export const ANDROID_SILENT_CHANNEL = 'pushr.silent';
/** The system notification sound. */
export const ANDROID_DEFAULT_CHANNEL = 'pushr.sound.default';
/** Ongoing Live Update notifications; created by the app's native module. */
export const ANDROID_LIVE_CHANNEL = 'pushr.live';

const KNOWN = new Set<string>(ANDROID_SOUND_IDS);

export function androidChannelFor({ sound, critical }: { sound: string | null | undefined; critical: boolean }): string {
  if (critical) return ANDROID_CRITICAL_CHANNEL;
  if (sound === null) return ANDROID_SILENT_CHANNEL;
  const id = sound?.endsWith('.caf') ? sound.slice(0, -'.caf'.length) : undefined;
  return id && KNOWN.has(id) ? `pushr.sound.${id}` : ANDROID_DEFAULT_CHANNEL;
}
