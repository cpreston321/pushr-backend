/**
 * Web-crypto HMAC-SHA256 verification for webhook signatures.
 *
 * Used by the GitHub adapter (`X-Hub-Signature-256: sha256=<hex>`). Accepts
 * either `sha256=<hex>` or just `<hex>` so other providers with similar
 * schemes can reuse it.
 */
export async function verifyHmacSha256(
  rawBody: string,
  header: string | null,
  secret: string
): Promise<boolean> {
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // Constant-time compare.
  if (expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}
