/**
 * Source-app token helpers.
 *
 * Tokens are shown to the user exactly once at creation. We persist only a
 * SHA-256 hash, so DB leaks don't leak usable tokens. The prefix (first 8
 * chars) is stored plainly so the UI can show "pshr_abcd1234…" without
 * revealing the full secret.
 */

const PREFIX = 'pshr_';

export function generateToken(): string {
  return PREFIX + randomUrlSafe(32);
}

/** `bytes` random bytes as URL-safe base64 without padding. */
export function randomUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Hex SHA-256 of an arbitrary string. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashToken(token: string): Promise<string> {
  return await sha256Hex(token);
}

export function tokenDisplayPrefix(token: string): string {
  // "pshr_abcd1234" — first 8 chars after prefix, safe to display
  return token.slice(0, PREFIX.length + 8);
}
